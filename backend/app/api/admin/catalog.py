"""اللوحة — الكتالوج والتسعير (م-6)، والموردون والعروض والمقارنة، والتصنيفات واقتراحات الموردين (م-4).

التكاليف (سعر الشراء، الهامش، التكلفة المرجعية) تُحجب عمّن لا يملك «التكاليف» (common.sees_costs).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.admin.common import P, city, sees_costs
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import (CatalogNewIn, CatalogPatchIn, CatalogRowOut, CategoryIn, CategoryNodeOut, CategoryPatchIn,
                               CompareOut, ItemPricingOut, OfferOut, PriceChangeOut, PricingIn, ProposalDecisionIn,
                               ProposalOut, SourceIn, SourceOut, SupplierDetailOut, SupplierRowOut)

router = APIRouter()

ROW_SQL = """
SELECT ci.id, ci.name_ar, ci.unit::text AS unit, ci.unit_size, cat.name_ar AS category, ci.sale_price,
       ci.visibility::text AS visibility, ci.is_available, ci.below_cost,
       coalesce(pr.needs_review, false) AS needs_review,
       (SELECT count(*) FROM catalog_item_sources s WHERE s.catalog_item_id = ci.id) AS sources,
       pr.mode::text AS mode, pr.margin_value, item_cost_ref(ci.id) AS cost_ref
  FROM catalog_items ci JOIN categories cat ON cat.id = ci.category_id
  LEFT JOIN catalog_item_pricing pr ON pr.catalog_item_id = ci.id
"""


async def _row(t: Tx, item_id: int) -> CatalogRowOut:
    r = await t.one(ROW_SQL + " WHERE ci.id = :i", i=item_id)
    if r is None:
        raise ApiError(404, "item_not_found")
    return CatalogRowOut(**r)


@router.get("/catalog", response_model=list[CatalogRowOut], **P("catalog"))
async def catalog(request: Request, category_id: int | None = None, needs_review: bool | None = None,
                  q: str | None = None, p: Principal = Depends(admin_user)) -> list[CatalogRowOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        hide = not await sees_costs(t, p.user_id)
        rows = await t.all(ROW_SQL + """
 WHERE ci.city = :c AND (CAST(:cat AS bigint) IS NULL OR ci.category_id = :cat OR cat.parent_id = :cat)
   AND (CAST(:nr AS boolean) IS NULL OR coalesce(pr.needs_review, false) = :nr)
   AND (CAST(:q AS text) IS NULL OR ci.name_ar ILIKE '%' || :q || '%')
 ORDER BY coalesce(pr.needs_review, false) DESC, ci.below_cost DESC, ci.name_ar""",
                           c=city(request), cat=category_id, nr=needs_review, q=q)
    return [CatalogRowOut(**r).hide_costs(hide) for r in rows]


async def _pricing(t: Tx, item_id: int) -> ItemPricingOut:
    item = await _row(t, item_id)
    pr = await t.one("SELECT mode::text AS mode, margin_value, manual_price, reprice_override FROM catalog_item_pricing "
                     "WHERE catalog_item_id = :i", i=item_id) or {}
    sources = await t.all(
        "SELECT o.id AS offer_id, s.priority, sp.name AS supplier_name, o.status::text AS status, "
        "greatest(o.available_qty, 0) AS available_qty, o.purchase_price FROM catalog_item_sources s "
        "JOIN supplier_offers o ON o.id = s.offer_id JOIN suppliers sp ON sp.id = o.supplier_id "
        "WHERE s.catalog_item_id = :i ORDER BY s.priority", i=item_id)
    hist = await t.all("""
SELECT * FROM (
  SELECT h.changed_at AS at, 'sale' AS kind, 'بيع' AS label, h.old_price AS sale_old, h.new_price AS sale_new,
         NULL::numeric AS purchase_old, NULL::numeric AS purchase_new, coalesce(u.full_name, h.actor_role::text) AS by
    FROM catalog_price_history h LEFT JOIN app_users u ON u.id = h.actor_id WHERE h.catalog_item_id = :i
  UNION ALL
  SELECT h.changed_at, 'purchase', 'شراء — ' || sp.name, NULL, NULL, h.old_price, h.new_price,
         coalesce(u.full_name, h.actor_role::text)
    FROM supplier_offer_price_history h JOIN supplier_offers o ON o.id = h.offer_id
    JOIN suppliers sp ON sp.id = o.supplier_id LEFT JOIN app_users u ON u.id = h.actor_id
   WHERE h.offer_id IN (SELECT offer_id FROM catalog_item_sources WHERE catalog_item_id = :i)
) x ORDER BY at DESC LIMIT 50""", i=item_id)
    return ItemPricingOut(item=item, reprice_override=pr.get("reprice_override"),
                          sources_detail=[SourceOut(**s) for s in sources],
                          history=[PriceChangeOut(**h) for h in hist],
                          mode=pr.get("mode"), margin_value=pr.get("margin_value"),
                          manual_price=pr.get("manual_price"), cost_ref=item.cost_ref)


@router.get("/catalog/{item_id}", response_model=ItemPricingOut, **P("catalog"))
async def item_pricing(item_id: int, request: Request, p: Principal = Depends(admin_user)) -> ItemPricingOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        hide = not await sees_costs(t, p.user_id)
        # سجل الشراء كله تكاليف: يُحذف لا يُصفَّر
        out = await _pricing(t, item_id)
        if hide:
            out.history = [h for h in out.history if h.kind == "sale"]
        return out.hide_costs(hide)


@router.put("/catalog/{item_id}/pricing", response_model=ItemPricingOut, **P("costs_view"))
async def set_pricing(item_id: int, body: PricingIn, request: Request, p: Principal = Depends(admin_user)) -> ItemPricingOut:
    """الهامش والسعر اليدوي تكاليف: لمن يملك «التكاليف»، والقاعدة تفحص «الكتالوج» أيضاً."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("""
INSERT INTO catalog_item_pricing (catalog_item_id, mode, margin_value, manual_price, reprice_override)
VALUES (:i, CAST(:m AS pricing_mode), :mv, :mp, :ro)
ON CONFLICT (catalog_item_id) DO UPDATE SET mode = EXCLUDED.mode, margin_value = EXCLUDED.margin_value,
       manual_price = EXCLUDED.manual_price, reprice_override = EXCLUDED.reprice_override""",
                    i=item_id, m=body.mode, mv=body.margin_value if body.mode != "manual" else None,
                    mp=body.manual_price if body.mode == "manual" else None, ro=body.reprice_override)
        return await _pricing(t, item_id)


@router.patch("/catalog/{item_id}", response_model=CatalogRowOut, **P("catalog"))
async def patch_item(item_id: int, body: CatalogPatchIn, request: Request, p: Principal = Depends(admin_user)) -> CatalogRowOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        if body.visibility is not None:
            await t.run("UPDATE catalog_items SET visibility = CAST(:v AS visibility) WHERE id = :i", v=body.visibility, i=item_id)
        if body.oos_policy is not None:
            await t.run("UPDATE catalog_items SET oos_policy = CAST(nullif(:o, 'project') AS oos_policy) WHERE id = :i",
                        o=body.oos_policy, i=item_id)
        if body.weight_kg is not None:
            await t.run("UPDATE catalog_items SET weight_kg = :w WHERE id = :i", w=body.weight_kg, i=item_id)
        if body.name_ar is not None:
            await t.run("UPDATE catalog_items SET name_ar = :n WHERE id = :i", n=body.name_ar.strip(), i=item_id)
        hide = not await sees_costs(t, p.user_id)
        return (await _row(t, item_id)).hide_costs(hide)


@router.post("/catalog", response_model=CatalogRowOut, status_code=201, **P("catalog"))
async def new_item(body: CatalogNewIn, request: Request, p: Principal = Depends(admin_user)) -> CatalogRowOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        iid = await t.val("INSERT INTO catalog_items (city, product_id, category_id, name_ar, unit, unit_size) "
                          "VALUES (:c, :p, :cat, :n, CAST(:u AS sale_unit), :s) RETURNING id", c=city(request),
                          p=body.product_id, cat=body.category_id, n=body.name_ar.strip(), u=body.unit, s=body.unit_size)
        hide = not await sees_costs(t, p.user_id)
        return (await _row(t, iid)).hide_costs(hide)


@router.post("/catalog/{item_id}/sources", response_model=ItemPricingOut, **P("catalog"))
async def add_source(item_id: int, body: SourceIn, request: Request, p: Principal = Depends(admin_user)) -> ItemPricingOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO catalog_item_sources (catalog_item_id, offer_id, priority) VALUES (:i, :o, :p)",
                    i=item_id, o=body.offer_id, p=body.priority)
        hide = not await sees_costs(t, p.user_id)
        return (await _pricing(t, item_id)).hide_costs(hide)


@router.delete("/catalog/{item_id}/sources/{offer_id}", status_code=204, **P("catalog"))
async def remove_source(item_id: int, offer_id: int, request: Request, p: Principal = Depends(admin_user)) -> Response:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("DELETE FROM catalog_item_sources WHERE catalog_item_id = :i AND offer_id = :o", i=item_id, o=offer_id)
    return Response(status_code=204)


# ——— الموردون والعروض والمقارنة ————————————————————————————————————————————————
SUP_SQL = ("SELECT s.id, s.name, s.contact_name, s.phone, s.status::text AS status, s.payout_cycle::text AS payout_cycle, "
           "(SELECT count(*) FROM supplier_offers o WHERE o.supplier_id = s.id) AS offers FROM suppliers s")


@router.get("/suppliers", response_model=list[SupplierRowOut], **P("catalog"))
async def suppliers(request: Request, status: str | None = None, p: Principal = Depends(admin_user)) -> list[SupplierRowOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(SUP_SQL + " WHERE s.city = :c AND (CAST(:st AS text) IS NULL OR s.status::text = :st) "
                                     "ORDER BY s.name", c=city(request), st=status)
    return [SupplierRowOut(**r) for r in rows]


@router.get("/suppliers/{supplier_id}", response_model=SupplierDetailOut, **P("catalog"))
async def supplier(supplier_id: int, request: Request, p: Principal = Depends(admin_user)) -> SupplierDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        s = await t.one(SUP_SQL + " WHERE s.id = :i", i=supplier_id)
        if s is None:
            raise ApiError(404, "supplier_not_found")
        offers = await t.all(
            "SELECT o.id, pr.name_ar AS product, o.unit::text AS unit, o.unit_size, greatest(o.available_qty, 0) AS available_qty, "
            "o.status::text AS status, l.label AS location, o.purchase_price FROM supplier_offers o "
            "JOIN products pr ON pr.id = o.product_id JOIN supplier_pickup_locations l ON l.id = o.pickup_location_id "
            "WHERE o.supplier_id = :i ORDER BY pr.name_ar", i=supplier_id)
        hide = not await sees_costs(t, p.user_id)
    out = SupplierDetailOut(supplier=SupplierRowOut(**s), offers=[OfferOut(**o) for o in offers])
    for o in out.offers:
        o.hide_costs(hide)
    return out


@router.get("/products/{product_id}/offers", response_model=list[CompareOut], **P("catalog"))
async def compare(product_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[CompareOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(
            "SELECT o.id AS offer_id, sp.name AS supplier_name, o.unit::text AS unit, o.unit_size, "
            "greatest(o.available_qty, 0) AS available_qty, o.purchase_price, "
            "EXISTS (SELECT 1 FROM catalog_item_sources s WHERE s.offer_id = o.id) AS in_catalog "
            "FROM supplier_offers o JOIN suppliers sp ON sp.id = o.supplier_id "
            "WHERE o.product_id = :p AND sp.status = 'approved' ORDER BY o.purchase_price", p=product_id)
        hide = not await sees_costs(t, p.user_id)
    return [CompareOut(**r).hide_costs(hide) for r in rows]


# ——— التصنيفات واقتراحات الموردين (م-4) ——————————————————————————————————————
@router.get("/categories", response_model=list[CategoryNodeOut], **P("catalog"))
async def categories(request: Request, p: Principal = Depends(admin_user)) -> list[CategoryNodeOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all("SELECT c.id, c.parent_id, c.name_ar, c.name_en, c.icon_key, c.active, "
                           "(SELECT count(*) FROM catalog_items ci WHERE ci.category_id = c.id) AS items "
                           "FROM categories c ORDER BY c.sort, c.id")
    node = lambda r: CategoryNodeOut(**{k: v for k, v in r.items() if k != "parent_id"})  # noqa: E731
    return [node(r).model_copy(update={"children": [node(k) for k in rows if k["parent_id"] == r["id"]]})
            for r in rows if r["parent_id"] is None]


@router.post("/categories", response_model=CategoryNodeOut, status_code=201, **P("catalog"))
async def add_category(body: CategoryIn, request: Request, p: Principal = Depends(admin_user)) -> CategoryNodeOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        r = await t.one("INSERT INTO categories (parent_id, name_ar, name_en, sort) VALUES (:p, :a, :e, "
                        "(SELECT coalesce(max(sort), 0) + 1 FROM categories WHERE parent_id = :p)) "
                        "RETURNING id, name_ar, name_en, icon_key, active, 0 AS items",
                        p=body.parent_id, a=body.name_ar.strip(), e=body.name_en.strip())
    return CategoryNodeOut(**r)


@router.patch("/categories/{category_id}", response_model=CategoryNodeOut, **P("catalog"))
async def patch_category(category_id: int, body: CategoryPatchIn, request: Request,
                         p: Principal = Depends(admin_user)) -> CategoryNodeOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        r = await t.one("UPDATE categories SET name_ar = coalesce(:a, name_ar), name_en = coalesce(:e, name_en), "
                        "active = coalesce(:ac, active) WHERE id = :i RETURNING id, name_ar, name_en, icon_key, active, "
                        "(SELECT count(*) FROM catalog_items ci WHERE ci.category_id = :i) AS items",
                        a=body.name_ar, e=body.name_en, ac=body.active, i=category_id)
    if r is None:
        raise ApiError(404, "category_not_found")
    return CategoryNodeOut(**r)


@router.get("/proposals", response_model=list[ProposalOut], **P("catalog"))
async def proposals(request: Request, p: Principal = Depends(admin_user)) -> list[ProposalOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(
            "SELECT pr.id, pr.name_ar, c.name_ar AS category, sp.name AS supplier_name, pr.created_at, "
            "coalesce((SELECT array_agg(o.name_ar) FROM products o WHERE o.status = 'approved' AND o.id <> pr.id "
            "AND (o.name_norm LIKE '%' || split_part(pr.name_norm, ' ', 1) || '%')), '{}') AS similar "
            "FROM products pr JOIN categories c ON c.id = pr.category_id JOIN suppliers sp ON sp.id = pr.proposed_by_supplier_id "
            "WHERE pr.status = 'proposed' ORDER BY pr.created_at")
    return [ProposalOut(**r) for r in rows]


@router.post("/proposals/{product_id}", response_model=list[ProposalOut], **P("catalog"))
async def decide_proposal(product_id: int, body: ProposalDecisionIn, request: Request,
                          p: Principal = Depends(admin_user)) -> list[ProposalOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE products SET status = CAST(:s AS product_status), "
                    "category_id = coalesce(:c, category_id) WHERE id = :p AND status = 'proposed'",
                    s="approved" if body.decision == "approve" else "rejected", c=body.category_id, p=product_id)
    return await proposals(request, p)
