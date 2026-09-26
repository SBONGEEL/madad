"""العميل — التسجيل (الخطوة 4)، والفروع (م-9)، ومستخدمو المنشأة (م-8)، والإشعارات، والتقارير لكل فرع.

القواعد في القاعدة: الطرف يبدأ pending ووسائطه لرافعها (a_party_insert)، والأول صاحب المنشأة، والصاحب
وحده يضيف فرعاً أو مستخدماً (b_member، b_branch)، والإشعار يعلّمه صاحبه وحده (b_notification).
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Request, Response

from app.api.customer.common import member
from app.api.deps import Principal, customer_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.core.money import fmt
from app.schemas.customer import (BranchIn, BranchOut, BranchReportOut, DeviceIn, MemberIn, MemberRowOut,
                                  NotificationOut, ReadIn, RegistrationIn, ReportOut, CustomerOut)
from app.services.pdf import esc, render, rows

router = APIRouter()


@router.post("/registration", response_model=CustomerOut, status_code=201)
async def register(body: RegistrationIn, request: Request, p: Principal = Depends(customer_user)) -> CustomerOut:
    """الخطوة 4 من التسجيل (م-14): المنشأة وفرعها الأول، بانتظار اعتماد اللوحة."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        if await t.val("SELECT 1 FROM customer_members WHERE user_id = :u", u=p.user_id):
            raise ApiError(409, "establishment_exists")
        phone = await t.val("SELECT phone FROM app_users WHERE id = :u", u=p.user_id)
        city = request.app.state.settings.auth_city
        cid = await t.val(
            "INSERT INTO customers (city, name, kind, contact_name, phone, facade_media_id, cr_media_id) "
            "VALUES (:city, :n, CAST(:k AS establishment_kind), :cn, :ph, :f, :cr) RETURNING id",
            city=city, n=body.name.strip(), k=body.kind, cn=body.contact_name.strip(), ph=phone,
            f=body.facade_media_id, cr=body.cr_media_id)
        await t.run("INSERT INTO customer_members (customer_id, user_id, role) VALUES (:c, :u, 'owner')", c=cid, u=p.user_id)
        await t.run("INSERT INTO customer_locations (customer_id, city, lat, lng, address_text, zone_id) "
                    "VALUES (:c, :city, :lat, :lng, :a, :z)", c=cid, city=city, lat=body.lat, lng=body.lng,
                    a=body.address_text.strip(), z=body.zone_id)
        await t.run("UPDATE app_users SET full_name = :n WHERE id = :u", n=body.contact_name.strip(), u=p.user_id)
        return CustomerOut(id=cid, name=body.name.strip(), status="pending")


# ——— الفروع (م-9) ————————————————————————————————————————————————————————————————
BRANCH_SQL = ("SELECT id, name, address_text, lat, lng, zone_id, zone_name, status::text AS status, active "
              "FROM v_customer_branches")


async def _branches(t: Tx) -> list[BranchOut]:
    return [BranchOut(**r) for r in await t.all(BRANCH_SQL + " ORDER BY status DESC, id")]


@router.get("/branches", response_model=list[BranchOut])
async def branches(request: Request, p: Principal = Depends(customer_user)) -> list[BranchOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        return await _branches(t)


@router.post("/branches", response_model=list[BranchOut], status_code=201)
async def add_branch(body: BranchIn, request: Request, p: Principal = Depends(customer_user)) -> list[BranchOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        await t.run("INSERT INTO customer_locations (customer_id, city, name, lat, lng, zone_id, address_text) "
                    "VALUES (:c, :city, :n, :lat, :lng, :z, :a)", c=m["id"], city=m["city"], n=body.name.strip(),
                    lat=body.lat, lng=body.lng, z=body.zone_id, a=body.address_text.strip())
        return await _branches(t)


@router.patch("/branches/{branch_id}", response_model=list[BranchOut])
async def edit_branch(branch_id: int, body: BranchIn, request: Request, p: Principal = Depends(customer_user)) -> list[BranchOut]:
    """تغيير الموقع أو العنوان يعيد الفرع إلى «بانتظار الاعتماد» (b_branch في القاعدة)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        if not await t.val("SELECT 1 FROM v_customer_branches WHERE id = :b", b=branch_id):
            raise ApiError(404, "branch_missing")
        await t.run("UPDATE customer_locations SET name = :n, lat = :lat, lng = :lng, zone_id = :z, address_text = :a "
                    "WHERE id = :b", n=body.name.strip(), lat=body.lat, lng=body.lng, z=body.zone_id,
                    a=body.address_text.strip(), b=branch_id)
        return await _branches(t)


# ——— مستخدمو المنشأة (م-8) ——————————————————————————————————————————————————————
async def _members(t: Tx, customer_id: int) -> list[MemberRowOut]:
    rows = await t.all("""
SELECT m.user_id, u.full_name, u.phone, m.role::text AS role, m.branch_id, b.name AS branch_name,
       b.status::text AS branch_status, u.password_hash IS NOT NULL AS activated
  FROM customer_members m JOIN app_users u ON u.id = m.user_id LEFT JOIN customer_locations b ON b.id = m.branch_id
 WHERE m.customer_id = :c ORDER BY m.role, u.full_name""", c=customer_id)
    return [MemberRowOut(**r) for r in rows]


@router.get("/members", response_model=list[MemberRowOut])
async def members(request: Request, p: Principal = Depends(customer_user)) -> list[MemberRowOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        return await _members(t, m["id"])


@router.post("/members", response_model=list[MemberRowOut], status_code=201)
async def add_member(body: MemberIn, request: Request, p: Principal = Depends(customer_user)) -> list[MemberRowOut]:
    """الصاحب يضيف مستخدماً برقمه؛ يفعّل المضاف حسابه بنفسه من «تسجيل» (رمز ثم كلمة مرور)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        if m["role"] != "owner":
            raise ApiError(403, "forbidden_owner_member")
        uid = await t.val("SELECT id FROM app_users WHERE phone = :ph AND audience = 'customer'", ph=body.phone)
        if uid is None:
            uid = await t.val("INSERT INTO app_users (phone, audience, full_name) VALUES (:ph, 'customer', :n) RETURNING id",
                              ph=body.phone, n=body.full_name.strip())
        elif await t.val("SELECT 1 FROM customer_members WHERE user_id = :u", u=uid):
            raise ApiError(409, "member_exists")
        await t.run("INSERT INTO customer_members (customer_id, user_id, role, branch_id) "
                    "VALUES (:c, :u, CAST(:r AS member_role), :b)", c=m["id"], u=uid, r=body.role,
                    b=body.branch_id if body.role == "purchaser" else None)
        return await _members(t, m["id"])


# ——— الإشعارات ————————————————————————————————————————————————————————————————————
async def _inbox(t: Tx, user_id: int) -> list[NotificationOut]:
    rows = await t.all("SELECT id, kind, title, body, order_id, created_at, read_at IS NOT NULL AS read "
                       "FROM notifications WHERE user_id = :u ORDER BY created_at DESC, id DESC LIMIT 100", u=user_id)
    return [NotificationOut(**r) for r in rows]


@router.get("/notifications", response_model=list[NotificationOut])
async def notifications(request: Request, p: Principal = Depends(customer_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        return await _inbox(t, p.user_id)


@router.post("/notifications/read", response_model=list[NotificationOut])
async def read(body: ReadIn, request: Request, p: Principal = Depends(customer_user)) -> list[NotificationOut]:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await t.run("UPDATE notifications SET read_at = now() WHERE user_id = :u AND read_at IS NULL "
                    "AND (:all OR id = ANY(CAST(:ids AS bigint[])))", u=p.user_id, all=body.all, ids=body.ids)
        return await _inbox(t, p.user_id)


@router.post("/devices", status_code=204)
async def device(body: DeviceIn, request: Request, p: Principal = Depends(customer_user)) -> Response:
    """رمز الإشعار الفوري (FCM) لهذا الجهاز؛ جهاز انتقل لمستخدم آخر يُنقل رمزه."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await t.run("INSERT INTO device_tokens (user_id, fcm_token, platform) VALUES (:u, :tok, :pl) "
                    "ON CONFLICT (fcm_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, "
                    "updated_at = now()", u=p.user_id, tok=body.fcm_token, pl=body.platform)
    return Response(status_code=204)


# ——— التقارير لكل فرع (م-9) ——————————————————————————————————————————————————————
def _month(month: str | None) -> date:
    if not month:
        return date.today().replace(day=1)
    try:
        y, m = (int(x) for x in month.split("-"))
        return date(y, m, 1)
    except ValueError:
        raise ApiError(422, "month_invalid") from None


async def _report(t: Tx, month: str | None) -> ReportOut:
    start = _month(month)
    rows = await t.all("""
SELECT b.id, b.name, b.status::text AS status,
       coalesce(sum(o.total) FILTER (WHERE o.id IS NOT NULL), 0) AS amount, count(o.id) AS orders
  FROM v_customer_branches b
  LEFT JOIN v_customer_orders o ON o.branch_id = b.id AND o.status IN ('delivered', 'closed')
       AND o.delivered_at >= :s AND o.delivered_at < (CAST(:s AS date) + interval '1 month')
 GROUP BY b.id, b.name, b.status ORDER BY amount DESC, b.id""", s=start)
    branches = [BranchReportOut(**r) for r in rows]
    return ReportOut(month=start.strftime("%Y-%m"), amount=sum((b.amount for b in branches), start=0),
                     orders=sum(b.orders for b in branches), branches=branches)


@router.get("/reports", response_model=ReportOut)
async def report(request: Request, month: str | None = None, p: Principal = Depends(customer_user)) -> ReportOut:
    """من الطلبيات المسلَّمة. الصاحب كل الفروع، والمسؤول فرعه (v_customer_* في القاعدة)."""
    async with request.app.state.db.tx("customer", p.user_id) as t:
        await member(t, p.user_id)
        return await _report(t, month)


@router.get("/reports.pdf", response_class=Response, responses={200: {"content": {"application/pdf": {}}}})
async def report_pdf(request: Request, month: str | None = None, p: Principal = Depends(customer_user)) -> Response:
    async with request.app.state.db.tx("customer", p.user_id) as t:
        m = await member(t, p.user_id)
        r = await _report(t, month)
    body = (f"<h1>تقرير المشتريات — {esc(m['name'])}</h1><p>الشهر <span class='num'>{esc(r.month)}</span> · "
            f"الإجمالي <span class='num'>{fmt(r.amount)}</span> د.ل · الطلبيات <span class='num'>{r.orders}</span></p>"
            "<table><thead><tr><th>الفرع</th><th>الطلبيات</th><th>الإجمالي</th></tr></thead><tbody>"
            + rows([[b.name, str(b.orders), fmt(b.amount)] for b in r.branches], numeric_from=1) + "</tbody></table>")
    return Response(render(title="تقرير الفروع", body=body), media_type="application/pdf")
