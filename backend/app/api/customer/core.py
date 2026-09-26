"""العميل — الملف والتصنيفات والكتالوج والأحياء والوسائط."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile

from app.api.customer.common import MEMBER_SQL, member
from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.customer import (Catalog2Out, CategoryOut, ContextOut, CustomerOut, ItemDetailOut, Me2Out, MediaOut,
                                  MemberOut, ZoneOut)
from app.services.media import PUBLIC, PURPOSES

router = APIRouter()


@router.get("/me", response_model=Me2Out)
async def me(request: Request, p: Principal = Depends(customer_user)) -> Me2Out:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        name = await t.val("SELECT full_name FROM app_users WHERE id = :u", u=p.user_id)
        unread = await t.val("SELECT count(*) FROM notifications WHERE user_id = :u AND read_at IS NULL", u=p.user_id)
        c = await t.one(MEMBER_SQL, u=p.user_id)
        if c is None:
            return Me2Out(full_name=name, customer=None, member=None, context=None, unread=unread)
        ctx = await t.one(
            "SELECT ci.name_ar AS city_name, cs.oversell_policy::text AS oversell_policy, cs.min_order_amount, "
            "cs.min_order_lines, customer_credit_available(:c) AS credit FROM cities ci JOIN city_settings cs ON cs.city = ci.code "
            "WHERE ci.code = :city", c=c["id"], city=c["city"])
    return Me2Out(full_name=name, customer=CustomerOut(id=c["id"], name=c["name"], status=c["status"]),
                  member=MemberOut(role=c["role"], branch_id=c["branch_id"]),
                  context=ContextOut(kind=c["kind"], ordering_mode=c["purchaser_mode"], **ctx), unread=unread)


@router.get("/categories", response_model=list[CategoryOut])
async def categories(request: Request, p: Principal = Depends(customer_user)) -> list[CategoryOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        rows = await t.all("SELECT id, parent_id, name_ar, name_en, icon_key FROM categories WHERE active "
                           "ORDER BY sort, id")
    top = [r for r in rows if r["parent_id"] is None]
    return [CategoryOut(id=c["id"], name_ar=c["name_ar"], name_en=c["name_en"], icon_key=c["icon_key"],
                        children=[CategoryOut(id=k["id"], name_ar=k["name_ar"], name_en=k["name_en"],
                                              icon_key=k["icon_key"])
                                  for k in rows if k["parent_id"] == c["id"]])
            for c in top]


async def cart_branch(t: Tx, m: dict, branch_id: int | None) -> int | None:
    """فرع السلة المعروضة: المسؤول فرعه؛ الصاحب ما اختاره أو فرعه المعتمد الوحيد؛ وإلا لا سلة معيّنة."""
    if m["role"] == "purchaser":
        return m["branch_id"]
    if branch_id is not None:
        return await t.val("SELECT id FROM v_customer_branches WHERE id = :b", b=branch_id)
    rows = await t.all("SELECT id FROM v_customer_branches WHERE status = 'approved' AND active")
    return rows[0]["id"] if len(rows) == 1 else None


CATALOG_SQL = """
SELECT v.id, v.category_id, v.name_ar, v.name_en, v.unit::text AS unit, v.unit_size, v.sale_price, v.orderable,
       v.out_of_stock, v.image_media_id,
       (SELECT oi.qty FROM order_items oi JOIN v_customer_orders o ON o.id = oi.order_id
         WHERE o.status = 'draft' AND o.branch_id = :branch AND oi.catalog_item_id = v.id) AS cart_qty,
       CASE WHEN cs.oversell_policy = 'forbid' THEN item_available_qty(v.id) END AS available_qty
  FROM v_customer_catalog v JOIN city_settings cs ON cs.city = v.city
"""


@router.get("/catalog", response_model=list[Catalog2Out])
async def catalog(request: Request, category_id: int | None = None, q: str | None = None,
                  previously_ordered: bool = False, branch_id: int | None = None,
                  p: Principal = Depends(customer_user)) -> list[Catalog2Out]:
    """§2.3: بالتصنيف، وبالبحث، و«طلبتها سابقاً» مرتّبة بآخر طلب."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        branch = await cart_branch(t, m, branch_id)
        term = q.strip() if q and q.strip() else None
        order = ("(SELECT max(o.placed_at) FROM order_items oi JOIN v_customer_orders o ON o.id = oi.order_id "
                 "WHERE oi.catalog_item_id = v.id AND o.status <> 'draft') DESC NULLS LAST, v.name_ar"
                 if previously_ordered else "v.name_ar")
        rows = await t.all(CATALOG_SQL + """
 WHERE v.city = :city
   AND (CAST(:cat AS bigint) IS NULL OR v.category_id IN (SELECT id FROM categories WHERE id = :cat OR parent_id = :cat))
   AND (CAST(:q AS text) IS NULL OR v.name_ar ILIKE '%' || :q || '%' OR v.name_en ILIKE '%' || :q || '%')
   AND (NOT :prev OR EXISTS (SELECT 1 FROM order_items oi JOIN v_customer_orders o ON o.id = oi.order_id
                              WHERE oi.catalog_item_id = v.id AND o.status <> 'draft'))
 ORDER BY """ + order, city=m["city"], cat=category_id, q=term, prev=previously_ordered, branch=branch)
    return [Catalog2Out(**r) for r in rows]


@router.get("/catalog/{catalog_item_id}", response_model=ItemDetailOut)
async def item(catalog_item_id: int, request: Request, branch_id: int | None = None,
               p: Principal = Depends(customer_user)) -> ItemDetailOut:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        branch = await cart_branch(t, m, branch_id)
        r = await t.one(CATALOG_SQL + " WHERE v.id = :i AND v.city = :city", i=catalog_item_id, city=m["city"],
                        branch=branch)
        if r is None:
            raise ApiError(404, "item_not_found")
        cat = await t.val("SELECT name_ar FROM categories WHERE id = :c", c=r["category_id"])
    return ItemDetailOut(item=Catalog2Out(**r), category_name=cat)


@router.get("/zones", response_model=list[ZoneOut])
async def zones(request: Request, p: Principal = Depends(customer_user)) -> list[ZoneOut]:
    """الأحياء لاختيار حيّ الفرع (م-9) — بلا رسومها."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        city = await t.val("SELECT city FROM customer_members m JOIN customers c ON c.id = m.customer_id "
                           "WHERE m.user_id = :u LIMIT 1", u=p.user_id) or request.app.state.settings.auth_city
        rows = await t.all("SELECT id, name_ar FROM delivery_zones WHERE city = :c AND active ORDER BY name_ar", c=city)
    return [ZoneOut(**r) for r in rows]


# ——— الوسائط ——————————————————————————————————————————————————————————————————
@router.post("/media", response_model=MediaOut, status_code=201)
async def upload(request: Request, purpose: str = Form(...), file: UploadFile = File(...),
                 p: Principal = Depends(customer_user)) -> MediaOut:
    if purpose not in PURPOSES["customer"]:
        raise ApiError(422, "media_purpose_unknown")
    key, mime, size, sha = request.app.state.media.put(await file.read())
    async with request.app.state.db.tx("customer", p.user_id) as t:
        mid = await t.val("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                          "VALUES (:k, :m, :s, :h, :pv) RETURNING id", k=key, m=mime, s=size, h=sha, pv=purpose not in PUBLIC)
    return MediaOut(id=mid)
