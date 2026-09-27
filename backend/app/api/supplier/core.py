"""المورد — الملف، والتسجيل (الخطوة 4)، ولوحة الأرقام، والقاموس والاقتراح (م-4)، والوسائط، والإشعارات.

القواعد في القاعدة: الطرف يبدأ pending ووسائطه لرافعها (a_party_insert)، والمسجِّل أول عضو (b_supplier_member)،
والمواقع لمورده (b_pickup_location)، والمورد يقترح ولا يعتمد (supplier_may_only_propose).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile

from app.api.deps import Principal, supplier_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.supplier import (ContactOut, CategoryOut, DashboardOut, DeviceIn, MediaOut, Me2Out, NotificationOut, ProductOut,
                                  ProposalIn, ProposalOut, ReadIn, RegistrationIn, SupplierOut)
from app.services.media import PUBLIC, PURPOSES

router = APIRouter()

SUPPLIER_SQL = ("SELECT s.id, s.name, s.status::text AS status, s.contact_name, s.phone, s.payout_cycle::text AS payout_cycle, "
                "s.city FROM supplier_members m JOIN suppliers s ON s.id = m.supplier_id WHERE m.user_id = :u")


async def supplier(t: Tx, user_id: int) -> dict:
    row = await t.one(SUPPLIER_SQL, u=user_id)
    if row is None:
        raise ApiError(404, "no_supplier")
    return row


@router.get("/me", response_model=Me2Out)
async def me(request: Request, p: Principal = Depends(supplier_user)) -> Me2Out:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        name = await t.val("SELECT full_name FROM app_users WHERE id = :u", u=p.user_id)
        unread = await t.val("SELECT count(*) FROM notifications WHERE user_id = :u AND read_at IS NULL", u=p.user_id)
        s = await t.one(SUPPLIER_SQL, u=p.user_id)
        c = await t.one("SELECT contact_phone AS phone, contact_whatsapp AS whatsapp FROM city_settings WHERE city = :c",
                        c=request.app.state.settings.auth_city)
    return Me2Out(full_name=name, unread=unread, contact=ContactOut(**c) if c else None,
                  supplier=SupplierOut(**{k: v for k, v in s.items() if k != "city"}) if s else None)


@router.post("/media", response_model=MediaOut, status_code=201)
async def upload(request: Request, purpose: str = Form(...), file: UploadFile = File(...),
                 p: Principal = Depends(supplier_user)) -> MediaOut:
    if purpose not in PURPOSES["supplier"]:
        raise ApiError(422, "media_purpose_unknown")
    key, mime, size, sha = request.app.state.media.put(await file.read())
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        mid = await t.val("INSERT INTO media_files (storage_key, mime_type, byte_size, sha256, is_private) "
                          "VALUES (:k, :m, :s, :h, :pv) RETURNING id", k=key, m=mime, s=size, h=sha, pv=purpose not in PUBLIC)
    return MediaOut(id=mid)


@router.post("/registration", response_model=SupplierOut, status_code=201)
async def register(body: RegistrationIn, request: Request, p: Principal = Depends(supplier_user)) -> SupplierOut:
    """الخطوة 4: المحل وموقع استلام واحد على الأقل، وهوية المالك إلزامية — بانتظار اعتماد اللوحة."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        if await t.val("SELECT 1 FROM supplier_members WHERE user_id = :u", u=p.user_id):
            raise ApiError(409, "supplier_exists")
        phone = await t.val("SELECT phone FROM app_users WHERE id = :u", u=p.user_id)
        city = request.app.state.settings.auth_city
        sid = await t.val("INSERT INTO suppliers (city, name, contact_name, phone, owner_id_media_id, cr_media_id) "
                          "VALUES (:c, :n, :cn, :ph, :o, :cr) RETURNING id", c=city, n=body.name.strip(),
                          cn=body.contact_name.strip(), ph=phone, o=body.owner_id_media_id, cr=body.cr_media_id)
        await t.run("INSERT INTO supplier_members (supplier_id, user_id) VALUES (:s, :u)", s=sid, u=p.user_id)
        for loc in body.locations:
            await t.run("INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
                        "VALUES (:s, :c, :l, :lat, :lng, :a)", s=sid, c=city, l=loc.label.strip(), lat=loc.lat,
                        lng=loc.lng, a=loc.address_text.strip())
        await t.run("UPDATE app_users SET full_name = :n WHERE id = :u", n=body.contact_name.strip(), u=p.user_id)
        return SupplierOut(**{k: v for k, v in (await t.one(SUPPLIER_SQL, u=p.user_id)).items() if k != "city"})


@router.get("/dashboard", response_model=DashboardOut)
async def dashboard(request: Request, p: Principal = Depends(supplier_user)) -> DashboardOut:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        row = await t.one("""
SELECT coalesce((SELECT sum(amount) FROM v_supplier_received
                  WHERE received_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Tripoli')), 0) AS month_sales,
       (SELECT count(*) FROM v_supplier_offers WHERE status = 'active') AS active_offers,
       (SELECT count(DISTINCT s.id) FROM pickup_stops s JOIN orders o ON o.id = s.order_id
         WHERE s.supplier_id = actor_supplier() AND s.status = 'pending'
           AND o.status IN ('assigned', 'collecting')) AS pickups_today,
       supplier_own_due() AS due, supplier_next_payout(actor_supplier()) AS next_payout_on,
       (SELECT min(s.eta_at) FROM pickup_stops s WHERE s.supplier_id = actor_supplier() AND s.status = 'pending'
          AND s.eta_at IS NOT NULL) AS first_eta""")
    return DashboardOut(**row)


# ——— القاموس والاقتراح (م-4) ——————————————————————————————————————————————————————
@router.get("/categories", response_model=list[CategoryOut])
async def categories(request: Request, p: Principal = Depends(supplier_user)) -> list[CategoryOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        rows = await t.all("SELECT id, parent_id, name_ar FROM categories WHERE active ORDER BY sort, id")
    return [CategoryOut(id=c["id"], name_ar=c["name_ar"],
                        children=[CategoryOut(id=k["id"], name_ar=k["name_ar"]) for k in rows if k["parent_id"] == c["id"]])
            for c in rows if c["parent_id"] is None]


PRODUCT_SQL = """
SELECT p.id, p.name_ar, p.category_id, c.name_ar AS category_name, p.status::text AS status,
       p.proposed_by_supplier_id IS NOT DISTINCT FROM actor_supplier() AS mine
  FROM products p JOIN categories c ON c.id = p.category_id
"""


@router.get("/products", response_model=list[ProductOut])
async def products(request: Request, q: str | None = None, p: Principal = Depends(supplier_user)) -> list[ProductOut]:
    """المعتمد في القاموس، ومقترحاته هو وحده — لا مقترحات موردين آخرين."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        rows = await t.all(PRODUCT_SQL + """
 WHERE (p.status = 'approved' OR (p.status = 'proposed' AND p.proposed_by_supplier_id = actor_supplier()))
   AND (CAST(:q AS text) IS NULL OR p.name_ar ILIKE '%' || :q || '%' OR p.name_en ILIKE '%' || :q || '%')
 ORDER BY p.name_ar LIMIT 50""", q=q.strip() if q and q.strip() else None)
    return [ProductOut(**r) for r in rows]


@router.post("/products", response_model=ProposalOut, status_code=201)
async def propose(body: ProposalIn, request: Request, p: Principal = Depends(supplier_user)) -> ProposalOut:
    """اقتراح صنف: يعتمده المالك قبل أن يصل الكتالوج. يُذكر ما يشبهه في القاموس ليتجنّب التكرار."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        name = body.name_ar.strip()
        pid = await t.val("INSERT INTO products (name_ar, category_id, status, proposed_by_supplier_id) "
                          "VALUES (:n, :c, 'proposed', :s) RETURNING id", n=name, c=body.category_id, s=s["id"])
        similar = [r["name_ar"] for r in await t.all(
            "SELECT name_ar FROM products WHERE status = 'approved' AND id <> :i AND category_id = :c "
            "AND (name_ar ILIKE '%' || split_part(:n, ' ', 1) || '%') ORDER BY name_ar LIMIT 5",
            i=pid, c=body.category_id, n=name)]
        return ProposalOut(product=ProductOut(**await t.one(PRODUCT_SQL + " WHERE p.id = :i", i=pid)), similar=similar)


# ——— الإشعارات ————————————————————————————————————————————————————————————————————
async def _inbox(t: Tx, user_id: int) -> list[NotificationOut]:
    rows = await t.all("SELECT id, kind, title, body, created_at, read_at IS NOT NULL AS read FROM notifications "
                       "WHERE user_id = :u ORDER BY created_at DESC, id DESC LIMIT 100", u=user_id)
    return [NotificationOut(**r) for r in rows]


@router.get("/notifications", response_model=list[NotificationOut])
async def notifications(request: Request, p: Principal = Depends(supplier_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        return await _inbox(t, p.user_id)


@router.post("/notifications/read", response_model=list[NotificationOut])
async def read(body: ReadIn, request: Request, p: Principal = Depends(supplier_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await t.run("UPDATE notifications SET read_at = now() WHERE user_id = :u AND read_at IS NULL "
                    "AND (:all OR id = ANY(CAST(:ids AS bigint[])))", u=p.user_id, all=body.all, ids=body.ids)
        return await _inbox(t, p.user_id)


@router.post("/devices", status_code=204)
async def device(body: DeviceIn, request: Request, p: Principal = Depends(supplier_user)) -> Response:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await t.run("INSERT INTO device_tokens (user_id, fcm_token, platform) VALUES (:u, :tok, :pl) "
                    "ON CONFLICT (fcm_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, "
                    "updated_at = now()", u=p.user_id, tok=body.fcm_token, pl=body.platform)
    return Response(status_code=204)
