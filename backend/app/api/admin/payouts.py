"""اللوحة — دورية أجر السائق (D-1) وموعد الصرف القادم (§12-ي ٢ و٣).

القواعد بالإلحاق وحده في payout_rules (هي نفسها سجل التدقيق): العام من الإعدادات بصلاحية «الإعدادات»،
واستثناء المورد أو السائق من ملفه بصلاحية «المال» — مفروضان في القاعدة (trg_payout_rule_before).
كل تغيير يسري على الدورات الجديدة وحدها (payout_rule_at عند بداية الدورة).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.admin.common import P, city
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import PartyPayoutOut, PayoutRuleEventOut, PayoutRuleIn, PayoutRuleOut, PayoutSettingsOut

router = APIRouter()

FIELDS = ("driver_cycle::text AS driver_cycle, mode::text AS mode, fixed_weekday, fixed_month_day, "
          "fixed_semimonth_days::int[] AS fixed_semimonth_days")


def _rule(r: dict) -> PayoutRuleOut:
    return PayoutRuleOut(**{k: r[k] for k in PayoutRuleOut.model_fields})


async def _history(t: Tx, c: str, supplier: int | None, driver: int | None) -> list[PayoutRuleEventOut]:
    rows = await t.all(f"SELECT {FIELDS}, "
                       "r.effective_from AS at, coalesce(u.full_name, 'النظام') AS by FROM payout_rules r "
                       "LEFT JOIN app_users u ON u.id = r.set_by WHERE r.city = :c "
                       "AND r.supplier_id IS NOT DISTINCT FROM CAST(:s AS bigint) "
                       "AND r.driver_id IS NOT DISTINCT FROM CAST(:d AS bigint) ORDER BY r.effective_from DESC, r.id DESC "
                       "LIMIT 50", c=c, s=supplier, d=driver)
    return [PayoutRuleEventOut(**r) for r in rows]


async def _insert(t: Tx, c: str, body: PayoutRuleIn, supplier: int | None = None, driver: int | None = None) -> None:
    await t.run("INSERT INTO payout_rules (city, supplier_id, driver_id, driver_cycle, mode, fixed_weekday, fixed_month_day, "
                "fixed_semimonth_days) VALUES (:c, :s, :d, CAST(:dc AS payout_cycle), CAST(:m AS payout_schedule_mode), "
                ":wd, :md, CAST(:sm AS smallint[]))", c=c, s=supplier, d=driver, dc=body.driver_cycle, m=body.mode,
                wd=body.fixed_weekday, md=body.fixed_month_day, sm=body.fixed_semimonth_days)


# ——— العام (الإعدادات) ———————————————————————————————————————————————————————————————
async def _general(t: Tx, c: str) -> PayoutSettingsOut:
    now = await t.one(f"SELECT {FIELDS} FROM payout_rule_at(:c, NULL, NULL, now())", c=c)
    return PayoutSettingsOut(general=_rule(now), history=await _history(t, c, None, None))


@router.get("/settings/payout", response_model=PayoutSettingsOut, **P("settings"))
async def payout_settings(request: Request, p: Principal = Depends(admin_user)) -> PayoutSettingsOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _general(t, city(request))


@router.put("/settings/payout", response_model=PayoutSettingsOut, **P("settings"))
async def set_payout_settings(body: PayoutRuleIn, request: Request, p: Principal = Depends(admin_user)) -> PayoutSettingsOut:
    if body.mode is None:
        raise ApiError(422, "payout_mode_required")
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _insert(t, city(request), body)
        return await _general(t, city(request))


# ——— استثناء مورد أو سائق (ملفه) ————————————————————————————————————————————————————
async def _party(t: Tx, c: str, supplier: int | None, driver: int | None) -> PartyPayoutOut:
    if supplier is not None:
        s = await t.one("SELECT payout_cycle::text AS cycle, supplier_next_payout(id) AS nxt, NULL AS pm FROM suppliers "
                        "WHERE id = :i AND city = :c", i=supplier, c=c)
    else:
        s = await t.one("SELECT driver_payout_cycle(id)::text AS cycle, driver_next_payout(id) AS nxt, pay_method::text AS pm "
                        "FROM drivers WHERE id = :i AND city = :c", i=driver, c=c)
    if s is None:
        raise ApiError(404, "party_not_found")
    hist = await _history(t, c, supplier, driver)
    last = hist[0] if hist else None
    override = _rule(last.model_dump()) if last and (last.driver_cycle or last.mode) else None
    eff = await t.one(f"SELECT {FIELDS} FROM payout_rule_at(:c, CAST(:s AS bigint), CAST(:d AS bigint), now())",
                      c=c, s=supplier, d=driver)
    return PartyPayoutOut(override=override, effective=_rule(eff), payout_cycle=s["cycle"], pay_method=s["pm"],
                          next_payout_on=s["nxt"], history=hist)


@router.get("/drivers/{driver_id}/payout", response_model=PartyPayoutOut, **P("money"))
async def driver_payout_rule(driver_id: int, request: Request, p: Principal = Depends(admin_user)) -> PartyPayoutOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _party(t, city(request), None, driver_id)


@router.put("/drivers/{driver_id}/payout", response_model=PartyPayoutOut, **P("money"))
async def set_driver_payout_rule(driver_id: int, body: PayoutRuleIn, request: Request,
                                 p: Principal = Depends(admin_user)) -> PartyPayoutOut:
    """كل الحقول فارغة = الرجوع إلى العام."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _party(t, city(request), None, driver_id)
        await _insert(t, city(request), body, driver=driver_id)
        return await _party(t, city(request), None, driver_id)


@router.get("/suppliers/{supplier_id}/payout", response_model=PartyPayoutOut, **P("money"))
async def supplier_payout_rule(supplier_id: int, request: Request, p: Principal = Depends(admin_user)) -> PartyPayoutOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _party(t, city(request), supplier_id, None)


@router.put("/suppliers/{supplier_id}/payout", response_model=PartyPayoutOut, **P("money"))
async def set_supplier_payout_rule(supplier_id: int, body: PayoutRuleIn, request: Request,
                                   p: Principal = Depends(admin_user)) -> PartyPayoutOut:
    """دورية المورد نفسها في ملفه منذ اعتماده؛ هنا طريقة موعد صرفه وحدها."""
    if body.driver_cycle is not None:
        raise ApiError(422, "supplier_has_own_cycle")
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await _party(t, city(request), supplier_id, None)
        await _insert(t, city(request), body, supplier=supplier_id)
        return await _party(t, city(request), supplier_id, None)
