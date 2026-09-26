"""اللوحة — الرئيسية، والاعتمادات، والعملاء وفروعهم (م-8، م-9)، ومستخدمو اللوحة، والإشعارات الجماعية،
وسجل التدقيق، وإشعاراتي. القواعد والصلاحيات في القاعدة؛ التكاليف محجوبة بلا «التكاليف».
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from app.api.admin.common import P, city, sees_costs
from app.api.admin.orders import ORDER_SQL
from app.api.deps import Principal, admin_user
from app.core.db import Tx
from app.core.errors import ApiError
from app.schemas.admin import (AdminInviteIn, AdminUserOut, ApprovalIn, AuditOut, BranchOut, BroadcastIn, BroadcastOut, DocumentOut,
                               CustomerDetailOut, CustomerRowOut, DashboardOut, InboxOut, MemberOut, OrderRowOut,
                               PendingOut, PermissionsIn, PurchaserModeIn)

router = APIRouter()


@router.get("/dashboard", response_model=DashboardOut, **P("any"))
async def dashboard(request: Request, p: Principal = Depends(admin_user)) -> DashboardOut:
    c = city(request)
    async with request.app.state.db.tx("admin", p.user_id) as t:
        n = await t.one("""
SELECT (SELECT count(*) FROM customers WHERE city = :c AND status = 'approved') AS customers,
       (SELECT count(*) FROM suppliers WHERE city = :c AND status = 'approved') AS suppliers_approved,
       (SELECT count(*) FROM customers WHERE city = :c AND status = 'pending')
     + (SELECT count(*) FROM suppliers WHERE city = :c AND status = 'pending')
     + (SELECT count(*) FROM drivers WHERE city = :c AND status = 'pending') AS pending_approvals,
       (SELECT count(*) FROM orders WHERE city = :c AND placed_at::date = current_date) AS orders_today,
       coalesce((SELECT sum(total) FROM orders WHERE city = :c AND delivered_at::date = current_date), 0) AS sales_today""", c=c)
        week = await t.all("SELECT d::date AS day, coalesce((SELECT sum(total) FROM orders WHERE city = :c AND "
                           "delivered_at::date = d::date), 0) AS sales FROM generate_series(current_date - 6, current_date, "
                           "interval '1 day') d ORDER BY d", c=c)
        att = await t.one("""
SELECT (SELECT count(*) FROM disputes d JOIN orders o ON o.id = d.order_id WHERE o.city = :c AND d.status = 'open') AS disputes,
       (SELECT count(*) FROM catalog_item_pricing pr JOIN catalog_items ci ON ci.id = pr.catalog_item_id
         WHERE ci.city = :c AND pr.needs_review) AS needs_review,
       (SELECT count(*) FROM catalog_items WHERE city = :c AND below_cost) AS below_cost,
       (SELECT count(*) FROM orders WHERE city = :c AND status = 'placed') AS to_confirm""", c=c)
        profit = await t.val(
            "SELECT coalesce(-sum(e.amount), 0) FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id "
            "JOIN ledger_accounts a ON a.id = e.account_id WHERE x.city = :c AND x.occurred_at::date = current_date AND "
            "a.kind IN ('sales_revenue', 'delivery_fee_revenue', 'sales_adjustment', 'cost_of_goods', 'driver_pay_expense', "
            "'operating_expense')", c=c)
        latest = await t.all(ORDER_SQL + " WHERE o.city = :c AND o.status <> 'draft' ORDER BY o.id DESC LIMIT 8", c=c)
        hide = not await sees_costs(t, p.user_id)
    return DashboardOut(**n, sales_7d=[{"day": w["day"].isoformat(), "sales": str(w["sales"])} for w in week],
                        attention=att, latest=[OrderRowOut(**r) for r in latest], profit_today=profit).hide_costs(hide)


# ——— الاعتمادات ——————————————————————————————————————————————————————————————
@router.get("/approvals", response_model=list[PendingOut], **P("approvals"))
async def approvals(request: Request, p: Principal = Depends(admin_user)) -> list[PendingOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all("""
SELECT 'customer' AS kind, id, name, phone, kind::text || ' · ' || contact_name AS detail, created_at
  FROM customers WHERE city = :c AND status = 'pending'
UNION ALL
SELECT 'supplier', id, name, phone, contact_name, created_at FROM suppliers WHERE city = :c AND status = 'pending'
UNION ALL
SELECT 'driver', id, full_name, phone, vehicle::text, created_at FROM drivers WHERE city = :c AND status = 'pending'
UNION ALL
SELECT 'branch', b.id, c.name || ' — ' || b.name, NULL, b.address_text, b.created_at FROM customer_locations b
  JOIN customers c ON c.id = b.customer_id WHERE b.city = :c AND b.status = 'pending' AND c.status = 'approved'
ORDER BY created_at""", c=city(request))
    return [PendingOut(**r) for r in rows]


TABLES = {"customer": "customers", "supplier": "suppliers", "driver": "drivers", "branch": "customer_locations"}


@router.post("/approvals/{kind}/{party_id}", response_model=list[PendingOut], **P("approvals"))
async def decide(kind: str, party_id: int, body: ApprovalIn, request: Request, p: Principal = Depends(admin_user)) -> list[PendingOut]:
    table = TABLES.get(kind)
    if table is None:
        raise ApiError(404, "kind_unknown")
    status = "approved" if body.decision == "approve" else "rejected"
    async with request.app.state.db.tx("admin", p.user_id) as t:
        extra = ""
        if kind == "supplier" and status == "approved":
            extra = ", payout_cycle = CAST(:x AS payout_cycle)"
        if kind == "driver" and status == "approved":
            extra = ", pay_method = CAST(:x AS driver_pay_method)"
        review = "" if kind == "branch" else ", reviewed_by = :u, reviewed_at = now()"
        done = await t.val(f"UPDATE {table} SET status = CAST(:s AS party_status){review}{extra} "
                           "WHERE id = :i AND status = 'pending' RETURNING id", s=status, u=p.user_id, i=party_id,
                           x=body.payout_cycle if kind == "supplier" else body.pay_method)
        if not done:
            raise ApiError(409, "not_pending")
    return await approvals(request, p)


@router.get("/approvals/{kind}/{party_id}/documents", response_model=list[DocumentOut], **P("approvals"))
async def documents(kind: str, party_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[DocumentOut]:
    """وثائق الطرف لقرار اعتماده: نوعها وعدد مرات فتحها — والملف نفسه عبر «فتح» المسجَّل."""
    if kind not in ("customer", "supplier", "driver"):
        raise ApiError(404, "kind_unknown")
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all("SELECT d.purpose, d.media_id, d.mime_type, (SELECT count(*) FROM media_views v "
                           "WHERE v.media_id = d.media_id) AS views FROM party_documents(:k, :i) d", k=kind, i=party_id)
    return [DocumentOut(**r) for r in rows]


@router.post("/media/{media_id}/open", response_class=Response, responses={200: {"content": {"image/*": {}}}},
             **P("approvals"))
async def open_media(media_id: int, request: Request, p: Principal = Depends(admin_user)) -> Response:
    """فتح وثيقة خاصة: يُسجَّل الفتح بمن فتحها ومتى (media_views، إلحاق فقط) ثم يُرسل الملف."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        row = await t.one("SELECT storage_key, mime_type FROM media_files WHERE id = :i", i=media_id)
        if row is None:
            raise ApiError(404, "media_not_found")
        await t.run("INSERT INTO media_views (media_id, viewed_by) VALUES (:i, 0)", i=media_id)
        data = request.app.state.media.get(row["storage_key"])
    return Response(data, media_type=row["mime_type"], headers={"Cache-Control": "no-store"})


# ——— العملاء وفروعهم (م-8، م-9) ————————————————————————————————————————————————
CUST_SQL = ("SELECT c.id, c.name, c.kind::text AS kind, c.status::text AS status, c.purchaser_mode::text AS purchaser_mode, "
            "(SELECT count(*) FROM customer_locations b WHERE b.customer_id = c.id) AS branches, "
            "(SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ('draft', 'cancelled')) AS orders "
            "FROM customers c")


@router.get("/customers", response_model=list[CustomerRowOut], **P("customers"))
async def customers(request: Request, q: str | None = None, p: Principal = Depends(admin_user)) -> list[CustomerRowOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        rows = await t.all(CUST_SQL + " WHERE c.city = :c AND (CAST(:q AS text) IS NULL OR c.name ILIKE '%' || :q || '%') "
                           "ORDER BY c.name", c=city(request), q=q)
    return [CustomerRowOut(**r) for r in rows]


async def _customer(t: Tx, customer_id: int) -> CustomerDetailOut:
    c = await t.one(CUST_SQL + " WHERE c.id = :i", i=customer_id)
    if c is None:
        raise ApiError(404, "customer_not_found")
    x = await t.one("SELECT contact_name, phone FROM customers WHERE id = :i", i=customer_id)
    br = await t.all("SELECT b.id, b.name, b.address_text, z.name_ar AS zone, b.status::text AS status, b.active "
                     "FROM customer_locations b LEFT JOIN delivery_zones z ON z.id = b.zone_id WHERE b.customer_id = :i "
                     "ORDER BY b.id", i=customer_id)
    mem = await t.all("SELECT m.user_id, u.full_name, u.phone, m.role::text AS role, b.name AS branch FROM customer_members m "
                      "JOIN app_users u ON u.id = m.user_id LEFT JOIN customer_locations b ON b.id = m.branch_id "
                      "WHERE m.customer_id = :i ORDER BY m.role, u.full_name", i=customer_id)
    by = await t.all("SELECT b.name AS branch, coalesce(sum(o.total), 0) AS total FROM customer_locations b "
                     "LEFT JOIN orders o ON o.branch_id = b.id AND o.status IN ('delivered', 'closed') "
                     "AND o.delivered_at >= date_trunc('month', now()) WHERE b.customer_id = :i GROUP BY b.id, b.name "
                     "ORDER BY b.id", i=customer_id)
    credit = await t.val("SELECT customer_credit_available(:i)", i=customer_id)
    return CustomerDetailOut(customer=CustomerRowOut(**c), **x, month_total=sum(r["total"] for r in by),
                             by_branch=[{"branch": r["branch"], "total": str(r["total"])} for r in by], credit=credit,
                             branches=[BranchOut(**r) for r in br], members=[MemberOut(**r) for r in mem])


@router.get("/customers/{customer_id}", response_model=CustomerDetailOut, **P("customers"))
async def customer(customer_id: int, request: Request, p: Principal = Depends(admin_user)) -> CustomerDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _customer(t, customer_id)


@router.put("/customers/{customer_id}/purchaser-mode", response_model=CustomerDetailOut, **P("customers"))
async def purchaser_mode(customer_id: int, body: PurchaserModeIn, request: Request,
                         p: Principal = Depends(admin_user)) -> CustomerDetailOut:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE customers SET purchaser_mode = CAST(:m AS purchaser_mode) WHERE id = :i", m=body.purchaser_mode, i=customer_id)
        return await _customer(t, customer_id)


# ——— مستخدمو اللوحة وصلاحياتهم (ت-40) ————————————————————————————————————————————
async def _admins(t: Tx) -> list[AdminUserOut]:
    rows = await t.all("SELECT m.user_id, u.full_name, u.phone, m.role::text AS role, u.active, "
                       "coalesce((SELECT array_agg(permission::text ORDER BY permission) FROM admin_permissions ap "
                       "WHERE ap.user_id = m.user_id), '{}') AS permissions FROM admin_members m JOIN app_users u ON u.id = m.user_id "
                       "ORDER BY m.role, u.full_name")
    return [AdminUserOut(**r) for r in rows]


@router.get("/admins", response_model=list[AdminUserOut], **P("users"))
async def admins(request: Request, p: Principal = Depends(admin_user)) -> list[AdminUserOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _admins(t)


@router.post("/admins", response_model=list[AdminUserOut], status_code=201, **P("users"))
async def invite(body: AdminInviteIn, request: Request, p: Principal = Depends(admin_user)) -> list[AdminUserOut]:
    """المشرف الجديد يفعّل حسابه برمز مرة واحدة ثم كلمة مرور (م-14، /auth/admin/register)."""
    async with request.app.state.db.tx("admin", p.user_id) as t:
        uid = await t.val("INSERT INTO app_users (phone, audience, full_name) VALUES (:p, 'admin', :n) RETURNING id",
                          p=body.phone, n=body.full_name.strip())
        await t.run("INSERT INTO admin_members (user_id, role) VALUES (:u, 'supervisor')", u=uid)
        for perm in body.permissions:
            await t.run("INSERT INTO admin_permissions (user_id, permission) VALUES (:u, CAST(:p AS admin_permission))", u=uid, p=perm)
        return await _admins(t)


@router.put("/admins/{user_id}/permissions", response_model=list[AdminUserOut], **P("users"))
async def set_permissions(user_id: int, body: PermissionsIn, request: Request, p: Principal = Depends(admin_user)) -> list[AdminUserOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("DELETE FROM admin_permissions WHERE user_id = :u AND NOT (permission::text = ANY(:k))", u=user_id, k=body.permissions)
        for perm in body.permissions:
            await t.run("INSERT INTO admin_permissions (user_id, permission) VALUES (:u, CAST(:p AS admin_permission)) "
                        "ON CONFLICT DO NOTHING", u=user_id, p=perm)
        return await _admins(t)


# ——— الإشعارات الجماعية (ت-41) ————————————————————————————————————————————————————
async def _broadcasts(t: Tx, c: str) -> list[BroadcastOut]:
    rows = await t.all("SELECT b.id, b.audience::text AS audience, b.title, b.body, b.created_at, "
                       "(SELECT count(*) FROM notifications n WHERE n.kind = 'broadcast' AND (n.payload->>'broadcast_id')::bigint = b.id) AS recipients "
                       "FROM broadcasts b WHERE b.city = :c ORDER BY b.id DESC LIMIT 100", c=c)
    return [BroadcastOut(**r) for r in rows]


@router.get("/broadcasts", response_model=list[BroadcastOut], **P("notifications"))
async def broadcasts(request: Request, p: Principal = Depends(admin_user)) -> list[BroadcastOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        return await _broadcasts(t, city(request))


@router.post("/broadcasts", response_model=list[BroadcastOut], status_code=201, **P("notifications"))
async def broadcast(body: BroadcastIn, request: Request, p: Principal = Depends(admin_user)) -> list[BroadcastOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("INSERT INTO broadcasts (city, audience, title, body, created_by) VALUES (:c, CAST(:a AS audience), :t, :b, :u)",
                    c=city(request), a=body.audience, t=body.title.strip(), b=body.body.strip(), u=p.user_id)
        return await _broadcasts(t, city(request))


# ——— سجل التدقيق — جداول التكلفة لمن يملك «التكاليف» ————————————————————————————————
COST_TABLES = ["supplier_offers", "catalog_item_pricing", "pickup_line_costs", "stock_movements",
               "supplier_offer_price_history", "owner_capital_entries", "owner_withdrawals", "driver_custody"]


@router.get("/audit", response_model=list[AuditOut], **P("users"))
async def audit(request: Request, table: str | None = None, p: Principal = Depends(admin_user)) -> list[AuditOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        hide = not await sees_costs(t, p.user_id)
        rows = await t.all(
            "SELECT a.id, a.table_name, a.row_pk, a.op, coalesce(u.full_name, a.actor_role) AS actor, a.at, "
            "coalesce((SELECT jsonb_object_agg(k, jsonb_build_array(a.before -> k, a.after -> k)) FROM jsonb_object_keys("
            "coalesce(a.after, a.before)) k WHERE (a.before -> k) IS DISTINCT FROM (a.after -> k) "
            "AND k NOT IN ('password_hash')), '{}'::jsonb) AS changes "
            "FROM audit_log a LEFT JOIN app_users u ON u.id = a.actor_id "
            "WHERE (CAST(:t AS text) IS NULL OR a.table_name = :t) AND (NOT :h OR NOT (a.table_name = ANY(:ct))) "
            "ORDER BY a.id DESC LIMIT 200", t=table, h=hide, ct=COST_TABLES)
    return [AuditOut(**r) for r in rows]


# ——— إشعاراتي ——————————————————————————————————————————————————————————————
@router.get("/inbox", response_model=list[InboxOut], **P("any"))
async def inbox(request: Request, p: Principal = Depends(admin_user)) -> list[InboxOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        hide = not await sees_costs(t, p.user_id)
        rows = await t.all("SELECT id, kind, title, CASE WHEN :h AND kind IN ('price_changed', 'below_cost') "
                           "THEN title ELSE body END AS body, order_id, created_at, read_at IS NOT NULL AS read "
                           "FROM notifications WHERE user_id = :u ORDER BY id DESC LIMIT 100", u=p.user_id, h=hide)
    return [InboxOut(**r) for r in rows]


@router.post("/inbox/{notification_id}/read", response_model=list[InboxOut], **P("any"))
async def read(notification_id: int, request: Request, p: Principal = Depends(admin_user)) -> list[InboxOut]:
    async with request.app.state.db.tx("admin", p.user_id) as t:
        await t.run("UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = :i AND user_id = :u",
                    i=notification_id, u=p.user_id)
    return await inbox(request, p)
