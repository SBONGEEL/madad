"""اللوحة — الإعدادات (م-5، م-6، م-7، م-12، م-15، م-22، م-24)، ومناطق التوصيل (م-16).

كل تغيير يُدقَّق في القاعدة (zz_audit)، ولا يسري على طلبية قائمة (لقطات الطلبية). إعداد م-27
(تداخل المنطقتين) إضافةٌ بانتظار اعتماد تصميمها: لا يمرّ هنا بعد.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request

from app.api.admin.common import P, city
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import (AreaIn, AreaOut, ChannelOut, ChannelsIn, CogsIn, SettingsIn, SettingsOut, ZoneIn, ZoneOut)
from app.services.otp.providers import configured

router = APIRouter()

COLS = ("min_order_amount, min_order_lines, min_order_decided, fee_mode::text AS fee_mode, delivery_fee_flat, "
        "free_delivery_threshold, oos_policy::text AS oos_policy, warehouse_first, auto_confirm_max_amount, driver_pay_base, "
        "driver_pay_per_stop, driver_pay_per_km, driver_cash_cap, collection_mode::text AS collection_mode, "
        "reprice_on_cost_change, cancel_policy::text AS cancel_policy, oversell_policy::text AS oversell_policy, "
        "pickup_proof_required, fee_conflict_rule::text AS fee_conflict_rule, cost_guard_basis::text AS cost_guard_basis")
CASTS = {"fee_mode": "fee_mode", "oos_policy": "oos_policy", "collection_mode": "collection_mode",
         "cancel_policy": "cancel_policy", "oversell_policy": "oversell_policy",
         "fee_conflict_rule": "fee_conflict_rule", "cost_guard_basis": "cost_guard_basis"}


async def _settings(t: Tx, c: str) -> SettingsOut:
    s = await t.one(f"SELECT {COLS} FROM city_settings WHERE city = :c", c=c)
    periods = await t.all("SELECT p.method::text AS method, p.effective_from, coalesce(u.full_name, 'النظام') AS by "
                          "FROM cogs_method_periods p LEFT JOIN app_users u ON u.id = p.set_by WHERE p.city = :c "
                          "ORDER BY p.effective_from", c=c)
    return SettingsOut(**s, cogs_method=periods[-1]["method"],
                       cogs_periods=[{"method": x["method"], "from": x["effective_from"].isoformat(), "by": x["by"]} for x in periods])


@router.get("/settings", response_model=SettingsOut, **P("settings"))
async def get_settings(request: Request, p: Principal = Depends(admin_user)) -> SettingsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _settings(t, city(request))


@router.put("/settings", response_model=SettingsOut, **P("settings"))
async def put_settings(body: SettingsIn, request: Request, p: Principal = Depends(admin_user)) -> SettingsOut:
    given = body.model_dump(exclude_unset=True)
    async with request.app.state.db.tx("admin", p.user_id) as t:
        if given:
            sets = ", ".join(f"{k} = CAST(:{k} AS {CASTS[k]})" if k in CASTS else f"{k} = :{k}" for k in given)
            await t.run(f"UPDATE city_settings SET {sets} WHERE city = :city", city=city(request), **given)
        return await _settings(t, city(request))


@router.post("/settings/cogs", response_model=SettingsOut, **P("settings"))
async def set_cogs(body: CogsIn, request: Request, p: Principal = Depends(admin_user)) -> SettingsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO cogs_method_periods (city, method) VALUES (:c, CAST(:m AS cogs_method))",
                    c=city(request), m=body.method)
        return await _settings(t, city(request))


# ——— قنوات الرمز (م-24): الترتيب والتفعيل؛ «مضبوطة» من البيئة بلا قيمة سرية ——————————————————
async def _channels(t: Tx) -> list[ChannelOut]:
    rows = await t.all("SELECT channel::text AS channel, position, enabled FROM otp_channels ORDER BY position")
    return [ChannelOut(**r, configured=configured(r["channel"]) is not None) for r in rows]


@router.get("/settings/otp-channels", response_model=list[ChannelOut], **P("settings"))
async def channels(request: Request, p: Principal = Depends(admin_user)) -> list[ChannelOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _channels(t)


@router.put("/settings/otp-channels", response_model=list[ChannelOut], **P("settings"))
async def set_channels(body: ChannelsIn, request: Request, p: Principal = Depends(admin_user)) -> list[ChannelOut]:
    if sorted(body.order) != sorted(["whatsapp_official", "whatsapp_linked", "sms"]):
        raise ApiError(422, "channels_order_incomplete")
    async with request.app.state.db.tx("admin", p.user_id) as t:
        for i, ch in enumerate(body.order, start=1):
            await t.run("UPDATE otp_channels SET position = :p, enabled = coalesce(:e, enabled) "
                        "WHERE channel = CAST(:c AS otp_channel_kind)", p=i, e=body.enabled.get(ch), c=ch)
        await t.run("SET CONSTRAINTS ALL IMMEDIATE")   # «SMS الأخير» يُفحص هنا فيصل خطؤه باسمه
        return await _channels(t)


# ——— مناطق التوصيل (م-16) ————————————————————————————————————————————————————
async def _zones(t: Tx, c: str) -> list[ZoneOut]:
    rows = await t.all("SELECT z.id, z.name_ar, z.fee, z.active, (SELECT count(*) FROM customer_locations b "
                       "WHERE b.zone_id = z.id) AS branches FROM delivery_zones z WHERE z.city = :c ORDER BY z.name_ar", c=c)
    return [ZoneOut(**r) for r in rows]


@router.get("/zones", response_model=list[ZoneOut], **P("settings"))
async def zones(request: Request, p: Principal = Depends(admin_user)) -> list[ZoneOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _zones(t, city(request))


@router.post("/zones", response_model=list[ZoneOut], status_code=201, **P("settings"))
async def add_zone(body: ZoneIn, request: Request, p: Principal = Depends(admin_user)) -> list[ZoneOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO delivery_zones (city, name_ar, fee, active) VALUES (:c, :n, :f, :a)",
                    c=city(request), n=body.name_ar.strip(), f=body.fee, a=body.active)
        return await _zones(t, city(request))


@router.put("/zones/{zone_id}", response_model=list[ZoneOut], **P("settings"))
async def edit_zone(zone_id: int, body: ZoneIn, request: Request, p: Principal = Depends(admin_user)) -> list[ZoneOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE delivery_zones SET name_ar = :n, fee = :f, active = :a WHERE id = :i",
                    n=body.name_ar.strip(), f=body.fee, a=body.active, i=zone_id)
        return await _zones(t, city(request))


async def _areas(t: Tx, c: str) -> list[AreaOut]:
    rows = await t.all("SELECT id, name_ar, fee, active, polygon FROM delivery_areas WHERE city = :c ORDER BY name_ar", c=c)
    return [AreaOut(**{**r, "polygon": r["polygon"] if isinstance(r["polygon"], list) else json.loads(r["polygon"])})
            for r in rows]


@router.get("/areas", response_model=list[AreaOut], **P("settings"))
async def areas(request: Request, p: Principal = Depends(admin_user)) -> list[AreaOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _areas(t, city(request))


@router.post("/areas", response_model=list[AreaOut], status_code=201, **P("settings"))
async def add_area(body: AreaIn, request: Request, p: Principal = Depends(admin_user)) -> list[AreaOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO delivery_areas (city, name_ar, fee, polygon, active) VALUES (:c, :n, :f, CAST(:g AS jsonb), :a)",
                    c=city(request), n=body.name_ar.strip(), f=body.fee, g=json.dumps(body.polygon), a=body.active)
        return await _areas(t, city(request))


@router.put("/areas/{area_id}", response_model=list[AreaOut], **P("settings"))
async def edit_area(area_id: int, body: AreaIn, request: Request, p: Principal = Depends(admin_user)) -> list[AreaOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE delivery_areas SET name_ar = :n, fee = :f, polygon = CAST(:g AS jsonb), active = :a WHERE id = :i",
                    n=body.name_ar.strip(), f=body.fee, g=json.dumps(body.polygon), a=body.active, i=area_id)
        return await _areas(t, city(request))
