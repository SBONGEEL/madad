"""الترحيلة 0015 — قرارات الدفعة السابعة (§12-ي)، كل قاعدة في الاتجاهين."""
from __future__ import annotations

from datetime import date, timedelta

import asyncpg
import pytest

from tests.db.world import (ADDRESS_CANARY, CUSTOMER_CANARY, SUPPLIER_CANARY, act, build, collect_all,
                            confirm_and_assign, draft, place)


async def raises(coro, needle):
    with pytest.raises(asyncpg.PostgresError) as e:
        await coro
    assert needle in str(e.value), str(e.value)


async def supervisor(db, perms: list[str]) -> int:
    await act(db, "system")
    uid = await db.fetchval("INSERT INTO app_users (phone, audience, full_name) VALUES ('+218910000071', 'admin', 'مشرف') "
                            "RETURNING id")
    await db.execute("INSERT INTO admin_members (user_id, role) VALUES ($1, 'supervisor')", uid)
    for p in perms:
        await db.execute("INSERT INTO admin_permissions (user_id, permission) VALUES ($1, $2::admin_permission)", uid, p)
    return uid


async def general(db, owner, cycle=None, mode="rolling", wd=None, md=None, sm=None):
    await act(db, "admin", owner)
    await db.execute("INSERT INTO payout_rules (city, driver_cycle, mode, fixed_weekday, fixed_month_day, fixed_semimonth_days) "
                     "VALUES ('TIP', $1::payout_cycle, $2::payout_schedule_mode, $3, $4, $5)", cycle, mode, wd, md, sm)


async def backdate(db, table, pid, days):
    await act(db, "system")
    await db.execute(f"UPDATE {table} SET reviewed_at = now() - make_interval(days => $2) WHERE id = $1", pid, days)
    return await db.fetchval(f"SELECT reviewed_at::date FROM {table} WHERE id = $1", pid)


# ——— ١) D-1: دورية أجر السائق الدوري ————————————————————————————————————————————————
async def test_driver_without_general_cycle_has_no_next_payout(db):
    w = await build(db)
    assert await db.fetchval("SELECT driver_next_payout($1)", w.driver) is None


async def test_general_cycle_gives_the_next_payout(db):
    w = await build(db)
    base = await backdate(db, "drivers", w.driver, 3)
    await general(db, w.owner, "weekly")
    assert await db.fetchval("SELECT driver_next_payout($1)", w.driver) == base + timedelta(days=7)
    assert await db.fetchval("SELECT driver_payout_cycle($1)", w.driver) == "weekly"


async def test_offset_driver_has_no_payout_date(db):
    w = await build(db)
    await general(db, w.owner, "weekly")
    await db.execute("UPDATE drivers SET pay_method = 'offset_on_settlement' WHERE id = $1", w.driver)
    assert await db.fetchval("SELECT driver_next_payout($1)", w.driver) is None


async def test_cycle_change_applies_to_new_cycles_only(db):
    w = await build(db)
    base = await backdate(db, "drivers", w.driver, 3)
    await general(db, w.owner, "weekly")
    await general(db, w.owner, "monthly")
    # الدورة الجارية بدأت قبل التغيير: تبقى أسبوعية
    assert await db.fetchval("SELECT driver_next_payout($1)", w.driver) == base + timedelta(days=7)
    # دورة تبدأ بعد التغيير (اعتماد أو صرف لاحق): شهرية
    await act(db, "system")
    await db.execute("UPDATE drivers SET reviewed_at = now() WHERE id = $1", w.driver)
    today = await db.fetchval("SELECT reviewed_at::date FROM drivers WHERE id = $1", w.driver)
    nxt = await db.fetchval("SELECT driver_next_payout($1)", w.driver)
    assert nxt == await db.fetchval("SELECT ($1::date + interval '1 month')::date", today)


async def test_driver_exception_overrides_the_general_cycle(db):
    w = await build(db)
    await general(db, w.owner, "weekly")
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO payout_rules (city, driver_id, driver_cycle) VALUES ('TIP', $1, 'daily')", w.driver)
    assert await db.fetchval("SELECT driver_payout_cycle($1)", w.driver) == "daily"
    # الرجوع إلى العامة: صف استثناء بلا قيمة
    await db.execute("INSERT INTO payout_rules (city, driver_id) VALUES ('TIP', $1)", w.driver)
    assert await db.fetchval("SELECT driver_payout_cycle($1)", w.driver) == "weekly"


async def test_general_rule_needs_settings_and_exception_needs_money(db):
    w = await build(db)
    sup = await supervisor(db, ["money"])
    await act(db, "admin", sup)
    await raises(db.execute("INSERT INTO payout_rules (city, mode, driver_cycle) VALUES ('TIP', 'rolling', 'weekly')"),
                 "forbidden")
    await db.execute("INSERT INTO payout_rules (city, driver_id, driver_cycle) VALUES ('TIP', $1, 'daily')", w.driver)
    await act(db, "driver", w.drv_user)
    await raises(db.execute("INSERT INTO payout_rules (city, driver_id, driver_cycle) VALUES ('TIP', $1, 'daily')", w.driver),
                 "forbidden")


async def test_payout_rules_are_append_only_and_audited(db):
    w = await build(db)
    await general(db, w.owner, "weekly")
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE payout_rules SET driver_cycle = 'daily'"), "append_only")
    await raises(db.execute("DELETE FROM payout_rules"), "append_only")
    row = await db.fetchrow("SELECT actor_id, after->>'driver_cycle' AS c FROM audit_log WHERE table_name = 'payout_rules' "
                            "ORDER BY id DESC LIMIT 1")
    assert (row["actor_id"], row["c"]) == (w.owner, "weekly")
    assert await db.fetchval("SELECT set_by FROM payout_rules ORDER BY id DESC LIMIT 1") == w.owner


# ——— ٣) موعد الصرف: آخر صرف + الدورة، أو أيام ثابتة ————————————————————————————————
@pytest.mark.parametrize("cycle,base,expected", [
    ("weekly", date(2026, 9, 24), date(2026, 9, 26)),        # الخميس ← السبت
    ("weekly", date(2026, 9, 26), date(2026, 10, 3)),        # السبت ← السبت التالي لا اليوم نفسه
    ("monthly", date(2026, 9, 15), date(2026, 10, 1)),
    ("monthly", date(2026, 9, 1), date(2026, 10, 1)),
    ("semimonthly", date(2026, 9, 10), date(2026, 9, 15)),
    ("semimonthly", date(2026, 9, 15), date(2026, 10, 1)),
    ("semimonthly", date(2026, 9, 30), date(2026, 10, 1)),
    ("daily", date(2026, 9, 30), date(2026, 10, 1)),
])
async def test_fixed_days(db, cycle, base, expected):
    got = await db.fetchval("SELECT payout_next_date($1::payout_cycle, $2, 'fixed', 6::smallint, 1::smallint, "
                            "ARRAY[1, 15]::smallint[])", cycle, base)
    assert got == expected


async def test_rolling_is_base_plus_cycle(db):
    assert await db.fetchval("SELECT payout_next_date('semimonthly', DATE '2026-09-10', 'rolling', NULL, NULL, NULL)") \
        == date(2026, 9, 25)


async def test_fixed_mode_needs_its_days(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("INSERT INTO payout_rules (city, mode, fixed_weekday) VALUES ('TIP', 'fixed', 6)"), "check")
    await raises(db.execute("INSERT INTO payout_rules (city, mode, fixed_weekday, fixed_month_day, fixed_semimonth_days) "
                            "VALUES ('TIP', 'fixed', 6, 1, ARRAY[15, 1]::smallint[])"), "check")
    await raises(db.execute("INSERT INTO payout_rules (city, mode, fixed_weekday, fixed_month_day, fixed_semimonth_days) "
                            "VALUES ('TIP', 'rolling', 6, NULL, NULL)"), "check")


async def test_supplier_schedule_general_then_exception(db):
    w = await build(db)                                             # أسبوعي
    base = await backdate(db, "suppliers", w.supplier, 2)
    assert await db.fetchval("SELECT supplier_next_payout($1)", w.supplier) == base + timedelta(days=7)
    # العام يصير أياماً ثابتة: الدورة الجارية بدأت قبله فلا تتغيّر
    await general(db, w.owner, None, "fixed", 6, 1, [1, 15])
    assert await db.fetchval("SELECT supplier_next_payout($1)", w.supplier) == base + timedelta(days=7)
    # مورد اعتُمد بعده: يوم السبت الثابت
    await act(db, "system")
    await db.execute("UPDATE suppliers SET reviewed_at = now() WHERE id = $1", w.supplier)
    today = await db.fetchval("SELECT reviewed_at::date FROM suppliers WHERE id = $1", w.supplier)
    nxt = await db.fetchval("SELECT supplier_next_payout($1)", w.supplier)
    assert nxt > today and nxt - today <= timedelta(days=7) and await db.fetchval("SELECT extract(dow FROM $1::date)", nxt) == 6
    # استثناؤه: آخر صرف + الدورة
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO payout_rules (city, supplier_id, mode) VALUES ('TIP', $1, 'rolling')", w.supplier)
    await act(db, "system")
    await db.execute("UPDATE suppliers SET reviewed_at = now() WHERE id = $1", w.supplier)
    assert await db.fetchval("SELECT supplier_next_payout($1)", w.supplier) == today + timedelta(days=7)


async def test_supplier_rule_cannot_carry_a_driver_cycle(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("INSERT INTO payout_rules (city, supplier_id, driver_cycle) VALUES ('TIP', $1, 'daily')",
                            w.supplier), "check")


# ——— ٢) ن-3 النسخ الاحتياطية ——————————————————————————————————————————————————————————
async def test_backup_policy_is_the_owners_alone(db):
    w = await build(db)
    assert await db.fetchval("SELECT (current_backup_policy()).plan::text") == "daily7_weekly12"
    assert await db.fetchval("SELECT (current_backup_policy()).location::text") == "both"
    sup = await supervisor(db, ["settings", "money"])
    await act(db, "admin", sup)
    await raises(db.execute("INSERT INTO backup_policies (plan, location) VALUES ('daily30', 'local')"), "forbidden_owner_only")
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO backup_policies (plan, location) VALUES ('daily30', 'local')")
    assert await db.fetchval("SELECT (current_backup_policy()).plan::text") == "daily30"
    await raises(db.execute("UPDATE backup_policies SET plan = 'daily7_weekly12'"), "append_only")


async def _run(db, status="ok", **kw):
    await act(db, "system")
    rid = await db.fetchval("INSERT INTO backup_runs (kind, plan, location) VALUES ('daily', 'daily7_weekly12', 'both') "
                            "RETURNING id")
    if status == "ok":
        await db.execute("UPDATE backup_runs SET status = 'ok', finished_at = coalesce($2, now()), "
                         "file_name = 'madad-20260927-030000.mdbk', byte_size = 10, sha256 = repeat('a', 64), "
                         "local_ok = true, offsite_ok = true WHERE id = $1", rid, kw.get("finished_at"))
    elif status == "failed":
        await db.execute("UPDATE backup_runs SET status = 'failed', finished_at = now(), error = 'pg_dump: x' WHERE id = $1", rid)
    return rid


async def test_backup_runs_are_written_by_the_worker_only(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await raises(db.execute("INSERT INTO backup_runs (kind, plan, location) VALUES ('daily', 'daily30', 'local')"),
                 "forbidden_role")
    rid = await _run(db)
    await raises(db.execute("UPDATE backup_runs SET sha256 = repeat('b', 64) WHERE id = $1", rid), "backup_run_final")
    await db.execute("UPDATE backup_runs SET pruned_at = now() WHERE id = $1", rid)
    await raises(db.execute("UPDATE backup_runs SET pruned_at = now() WHERE id = $1", rid), "backup_run_final")
    await raises(db.execute("DELETE FROM backup_runs WHERE id = $1", rid), "append_only")


async def test_ok_run_must_reach_every_place_the_policy_asked(db):
    await build(db)
    await act(db, "system")
    rid = await db.fetchval("INSERT INTO backup_runs (kind, plan, location) VALUES ('daily', 'daily30', 'both') RETURNING id")
    await raises(db.execute("UPDATE backup_runs SET status = 'ok', finished_at = now(), file_name = 'madad-20260927-030000.mdbk', "
                            "byte_size = 10, sha256 = repeat('a', 64), local_ok = true WHERE id = $1", rid), "check")


async def test_failed_backup_alerts_the_owner(db):
    w = await build(db)
    assert await db.fetchval("SELECT (backup_alert()).kind") is None
    await _run(db, "failed")
    assert await db.fetchval("SELECT (backup_alert()).kind") == "failed"
    assert await db.fetchval("SELECT user_id FROM notifications WHERE kind = 'backup_failed'") == w.owner
    await _run(db, "ok")
    assert await db.fetchval("SELECT (backup_alert()).kind") is None


async def test_a_day_without_a_successful_backup_alerts(db):
    await build(db)
    await act(db, "system")
    await _run(db, "ok", finished_at=await db.fetchval("SELECT now() - interval '26 hours'"))
    assert await db.fetchval("SELECT (backup_alert()).kind") == "stale"


async def test_backup_download_is_the_owners_alone_and_logged(db):
    w = await build(db)
    rid = await _run(db)
    bad = await _run(db, "failed")
    sup = await supervisor(db, ["settings", "money", "users"])
    await act(db, "admin", sup)
    await raises(db.execute("INSERT INTO backup_downloads (run_id) VALUES ($1)", rid), "forbidden_owner_only")
    await act(db, "admin", w.owner)
    await db.execute("INSERT INTO backup_downloads (run_id) VALUES ($1)", rid)
    assert await db.fetchval("SELECT user_id FROM backup_downloads WHERE run_id = $1", rid) == w.owner
    await raises(db.execute("INSERT INTO backup_downloads (run_id) VALUES ($1)", bad), "backup_unavailable")


# ——— ٣) ن-4 نص الإشعار على الشاشة المقفلة ————————————————————————————————————————————
async def _notify(db, user, kind="order_confirmed", order=None, title="عنوان", body="نص"):
    await act(db, "system")
    nid = await db.fetchval("INSERT INTO notifications (user_id, kind, order_id, title, body) VALUES ($1, $2, $3, $4, $5) "
                            "RETURNING id", user, kind, order, title, body)
    return await db.fetchrow("SELECT title, body, mode::text AS mode FROM push_outbox WHERE notification_id = $1", nid)


async def test_generic_is_the_default_lock_screen_text(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    got = await _notify(db, w.cust_user, order=oid, title=CUSTOMER_CANARY)
    assert (got["mode"], got["title"], got["body"]) == ("generic", "مَدَد", "لديك تحديث على طلبيتك")
    got = await _notify(db, w.sup_user, kind="pickup_request")
    assert got["body"] == "لديك إشعار جديد من مَدَد"


async def test_full_text_has_order_status_and_amount_and_nothing_personal(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET push_text_mode = 'full' WHERE city = 'TIP'")
    oid = await draft(db, w)
    await place(db, w, oid)
    got = await _notify(db, w.cust_user, order=oid, title=f"{CUSTOMER_CANARY} +218910000002", body=ADDRESS_CANARY)
    assert got["mode"] == "full" and f"#{oid}" in got["body"] and "بانتظار التأكيد" in got["body"] and "د.ل" in got["body"]
    # المورد لا يصله عن الطلبية شيء ولو حمل الإشعار رقمها
    got = await _notify(db, w.sup_user, kind="pickup_request", order=oid, title=SUPPLIER_CANARY)
    assert got["body"] == "طلب استلام جديد"
    confirm_and_assign  # noqa: B018 — الأدوات نفسها في الاختبارات الأخرى
    texts = " ".join(r["t"] for r in await db.fetch("SELECT title || ' ' || body AS t FROM push_outbox"))
    for canary in (CUSTOMER_CANARY, ADDRESS_CANARY, SUPPLIER_CANARY, "+218910000002", "السائق", "صاحب المطعم"):
        assert canary not in texts


async def test_login_codes_never_reach_the_push_outbox(db):
    w = await build(db)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET push_text_mode = 'full' WHERE city = 'TIP'")
    assert await _notify(db, w.cust_user, kind="otp", title="رمزك 123456") is None
    await act(db, "system")
    await raises(db.execute("INSERT INTO push_outbox (notification_id, user_id, kind, mode, title, body) "
                            "SELECT id, user_id, 'otp', 'full', 'x', 'y' FROM notifications LIMIT 1"), "check")


async def test_push_outbox_rejects_a_phone_number_and_non_worker_writes(db):
    w = await build(db)
    await _notify(db, w.cust_user, kind="broadcast")
    await act(db, "system")
    nid = await db.fetchval("INSERT INTO notifications (user_id, kind, title, body, channels) VALUES ($1, 'broadcast', 't', "
                            "'b', ARRAY['sms']::notification_channel[]) RETURNING id", w.cust_user)
    await raises(db.execute("INSERT INTO push_outbox (notification_id, user_id, kind, mode, title, body) VALUES "
                            "($1, $2, 'broadcast', 'full', 'مَدَد', 'اتصل 0921112233')", nid, w.cust_user), "check")
    await act(db, "admin", w.owner)
    await raises(db.execute("UPDATE push_outbox SET body = 'x'"), "forbidden_role")


async def test_push_text_mode_is_a_setting_with_audit(db):
    w = await build(db)
    sup = await supervisor(db, ["money"])
    await act(db, "admin", sup)
    await raises(db.execute("UPDATE city_settings SET push_text_mode = 'full' WHERE city = 'TIP'"), "forbidden")
    await act(db, "admin", w.owner)
    await db.execute("UPDATE city_settings SET push_text_mode = 'full' WHERE city = 'TIP'")
    assert await db.fetchval("SELECT after->>'push_text_mode' FROM audit_log WHERE table_name = 'city_settings' "
                             "ORDER BY id DESC LIMIT 1") == "full"


# ——— ٤) ن-5 مصدر الموعد وطول المسار ————————————————————————————————————————————————
async def _collecting(db, w):
    oid = await draft(db, w)
    await place(db, w, oid)
    await confirm_and_assign(db, w, oid)
    await act(db, "driver", w.drv_user)
    await db.execute("UPDATE orders SET status = 'collecting' WHERE id = $1", oid)
    return oid, await db.fetchval("SELECT id FROM pickup_stops WHERE order_id = $1", oid)


async def test_eta_source_follows_who_wrote_the_value(db):
    w = await build(db)
    oid, stop = await _collecting(db, w)
    await db.execute("UPDATE pickup_stops SET eta_at = now() + interval '20 minutes', eta_source = 'mapbox' WHERE id = $1", stop)
    assert await db.fetchval("SELECT eta_source FROM pickup_stops WHERE id = $1", stop) == "mapbox"
    # تعديل السائق للقيمة وحدها يصير يدوياً
    await db.execute("UPDATE pickup_stops SET eta_at = now() + interval '40 minutes' WHERE id = $1", stop)
    assert await db.fetchval("SELECT eta_source FROM pickup_stops WHERE id = $1", stop) == "manual"
    # ولا يُنسب للخرائط بلا قيمة جديدة
    await db.execute("UPDATE pickup_stops SET eta_source = 'mapbox' WHERE id = $1", stop)
    assert await db.fetchval("SELECT eta_source FROM pickup_stops WHERE id = $1", stop) == "manual"
    await act(db, "supplier", w.sup_user)
    assert await db.fetchval("SELECT DISTINCT eta_source FROM v_supplier_pickups WHERE id = $1", stop) == "manual"
    collect_all  # noqa: B018


async def test_route_km_source_follows_who_wrote_the_value(db):
    w = await build(db)
    oid = await draft(db, w)
    await place(db, w, oid)
    await act(db, "admin", w.owner)
    await db.execute("UPDATE orders SET status = 'confirmed' WHERE id = $1", oid)
    await db.execute("UPDATE orders SET route_km = 12.4, route_km_source = 'mapbox' WHERE id = $1", oid)
    assert await db.fetchval("SELECT route_km_source FROM orders WHERE id = $1", oid) == "mapbox"
    await db.execute("UPDATE orders SET route_km = 13 WHERE id = $1", oid)
    assert await db.fetchval("SELECT route_km_source FROM orders WHERE id = $1", oid) == "manual"
    await act(db, "driver", w.drv_user)
    await raises(db.execute("UPDATE orders SET route_km = 1, route_km_source = 'mapbox' WHERE id = $1", oid), "forbidden")
