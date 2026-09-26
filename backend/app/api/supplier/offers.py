"""المورد — عروضه (§2.1) ومواقع استلامه. يقرأ من v_supplier_offers وv_supplier_locations وحدهما.

العضوية والاعتماد وثبات هوية العرض وسجل الأسعار في القاعدة (b_offer وما بعده).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.deps import Principal, supplier_user
from app.api.supplier.core import supplier
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.supplier import (LocationIn, LocationOut, LocationPatchIn, OfferIn, OfferMediaIn, OfferOut,
                                  OfferPatchIn)

router = APIRouter()

OFFER_SQL = """
SELECT id, product_id, product_name, product_status::text AS product_status, unit::text AS unit, unit_size, purchase_price,
       previous_price, reported_qty, reserved_qty, available_qty, min_order_qty, pickup_location_id, location_label,
       status::text AS status, qty_reported_at, updated_at, image_media_id
  FROM v_supplier_offers
"""


async def _offers(t: Tx) -> list[OfferOut]:
    return [OfferOut(**r) for r in await t.all(OFFER_SQL + " ORDER BY status, product_name")]


@router.get("/offers", response_model=list[OfferOut])
async def offers(request: Request, p: Principal = Depends(supplier_user)) -> list[OfferOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        return await _offers(t)


@router.post("/offers", response_model=list[OfferOut], status_code=201)
async def add_offer(body: OfferIn, request: Request, p: Principal = Depends(supplier_user)) -> list[OfferOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        await t.run("INSERT INTO supplier_offers (supplier_id, product_id, unit, unit_size, purchase_price, reported_qty, "
                    "min_order_qty, pickup_location_id, status) VALUES (:s, :p, CAST(:u AS sale_unit), :us, :pp, :rq, "
                    ":mq, :l, CAST(:st AS offer_status))", s=s["id"], p=body.product_id, u=body.unit, us=body.unit_size,
                    pp=body.purchase_price, rq=body.reported_qty, mq=body.min_order_qty, l=body.pickup_location_id,
                    st="active" if body.active else "paused")
        return await _offers(t)


async def _mine(t: Tx, offer_id: int) -> None:
    if not await t.val("SELECT 1 FROM v_supplier_offers WHERE id = :o", o=offer_id):
        raise ApiError(404, "offer_not_found")


@router.patch("/offers/{offer_id}", response_model=list[OfferOut])
async def edit_offer(offer_id: int, body: OfferPatchIn, request: Request, p: Principal = Depends(supplier_user)) -> list[OfferOut]:
    """السعر (يُسجَّل تغييره ويُبلَّغ المالك)، والكمية المتاحة، والحد الأدنى، والإيقاف والتفعيل."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        await _mine(t, offer_id)
        sets, params = [], {"o": offer_id}
        if body.purchase_price is not None:
            sets.append("purchase_price = :pp"); params["pp"] = body.purchase_price
        if body.reported_qty is not None:
            sets.append("reported_qty = :rq"); params["rq"] = body.reported_qty
        if body.clear_min_order:
            sets.append("min_order_qty = NULL")
        elif body.min_order_qty is not None:
            sets.append("min_order_qty = :mq"); params["mq"] = body.min_order_qty
        if body.active is not None:
            sets.append("status = CAST(:st AS offer_status)"); params["st"] = "active" if body.active else "paused"
        if sets:
            await t.run(f"UPDATE supplier_offers SET {', '.join(sets)}, updated_at = now() WHERE id = :o", **params)
        return await _offers(t)


@router.put("/offers/{offer_id}/media", response_model=list[OfferOut])
async def offer_media(offer_id: int, body: OfferMediaIn, request: Request, p: Principal = Depends(supplier_user)) -> list[OfferOut]:
    """صور العرض بترتيبها. الصورة من رفعه هو (b_offer_media)."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        await _mine(t, offer_id)
        await t.run("DELETE FROM supplier_offer_media WHERE offer_id = :o", o=offer_id)
        for i, mid in enumerate(body.media_ids):
            await t.run("INSERT INTO supplier_offer_media (offer_id, media_id, sort) VALUES (:o, :m, :s)", o=offer_id, m=mid, s=i)
        return await _offers(t)


# ——— مواقع الاستلام ——————————————————————————————————————————————————————————————————
async def _locations(t: Tx) -> list[LocationOut]:
    return [LocationOut(**r) for r in await t.all("SELECT id, label, lat, lng, address_text, active, active_offers "
                                                  "FROM v_supplier_locations ORDER BY active DESC, id")]


@router.get("/locations", response_model=list[LocationOut])
async def locations(request: Request, p: Principal = Depends(supplier_user)) -> list[LocationOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        return await _locations(t)


@router.post("/locations", response_model=list[LocationOut], status_code=201)
async def add_location(body: LocationIn, request: Request, p: Principal = Depends(supplier_user)) -> list[LocationOut]:
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        s = await supplier(t, p.user_id)
        await t.run("INSERT INTO supplier_pickup_locations (supplier_id, city, label, lat, lng, address_text) "
                    "VALUES (:s, :c, :l, :lat, :lng, :a)", s=s["id"], c=s["city"], l=body.label.strip(), lat=body.lat,
                    lng=body.lng, a=body.address_text.strip())
        return await _locations(t)


@router.patch("/locations/{location_id}", response_model=list[LocationOut])
async def edit_location(location_id: int, body: LocationPatchIn, request: Request,
                        p: Principal = Depends(supplier_user)) -> list[LocationOut]:
    """لا يُعطَّل موقع عليه عروض نشطة (location_in_use في القاعدة)."""
    async with request.app.state.db.tx("supplier", p.user_id) as t:
        await supplier(t, p.user_id)
        if not await t.val("SELECT 1 FROM v_supplier_locations WHERE id = :l", l=location_id):
            raise ApiError(404, "location_not_found")
        given = body.model_dump(exclude_unset=True)
        if given:
            sets = ", ".join(f"{k} = :{k}" for k in given)
            await t.run(f"UPDATE supplier_pickup_locations SET {sets} WHERE id = :l", l=location_id,
                        **{k: (v.strip() if isinstance(v, str) else v) for k, v in given.items()})
        return await _locations(t)
