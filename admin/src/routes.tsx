/** خريطة اللوحة كما في الشريط الجانبي المعتمد (AdminSide): المسار، والشاشة، والصلاحية التي يعلنها الخادم لها. */
import type { ComponentType } from "react";

import type { IconName } from "@ui/icons";
import type { Perm } from "@/session";

import { Approvals } from "@/screens/Approvals";
import { Assign } from "@/screens/Assign";
import { Audit } from "@/screens/Audit";
import { Broadcast } from "@/screens/Broadcast";
import { Capital } from "@/screens/Capital";
import { Catalog } from "@/screens/Catalog";
import { Categories } from "@/screens/Categories";
import { Custody } from "@/screens/Custody";
import { CustomerDetail } from "@/screens/CustomerDetail";
import { Customers } from "@/screens/Customers";
import { DisputeDetail } from "@/screens/DisputeDetail";
import { Disputes } from "@/screens/Disputes";
import { DriverSettle } from "@/screens/DriverSettle";
import { ItemPricing } from "@/screens/ItemPricing";
import { Ledger } from "@/screens/Ledger";
import { Main } from "@/screens/Main";
import { Offers } from "@/screens/Offers";
import { Orders } from "@/screens/Orders";
import { OwnerInbox } from "@/screens/OwnerInbox";
import { PickupPlan } from "@/screens/PickupPlan";
import { Profit } from "@/screens/Profit";
import { Settings } from "@/screens/Settings";
import { SupplierPay } from "@/screens/SupplierPay";
import { Users } from "@/screens/Users";
import { Warehouses } from "@/screens/Warehouses";
import { Withdrawals } from "@/screens/Withdrawals";
import { Zones } from "@/screens/Zones";

export type CountKey = "inbox" | "approvals" | "needs_review" | "to_confirm" | "disputes";

export interface NavEntry { key: string; label: string; icon: IconName; to: string; perm: Perm; count?: CountKey }

export const NAV: Array<{ title?: string; items: NavEntry[] }> = [
  { items: [
    { key: "dash", label: "الرئيسية", icon: "layout-dashboard", to: "/", perm: "any" },
    { key: "inbox", label: "إشعاراتي", icon: "bell", to: "/inbox", perm: "any", count: "inbox" },
    { key: "appr", label: "الاعتمادات", icon: "shield-check", to: "/approvals", perm: "approvals", count: "approvals" } ] },
  { title: "التجارة", items: [
    { key: "sup", label: "الموردون والعروض", icon: "store", to: "/suppliers", perm: "catalog" },
    { key: "cat", label: "الكتالوج والتسعير", icon: "tags", to: "/catalog", perm: "catalog", count: "needs_review" },
    { key: "tree", label: "التصنيفات", icon: "folder-tree", to: "/categories", perm: "catalog" },
    { key: "wh", label: "المخازن", icon: "warehouse", to: "/warehouses", perm: "warehouses" },
    { key: "cust", label: "العملاء", icon: "users", to: "/customers", perm: "customers" } ] },
  { title: "الطلبيات", items: [
    { key: "ord", label: "اللوحة الحية", icon: "clipboard-list", to: "/orders", perm: "orders", count: "to_confirm" },
    { key: "plan", label: "مخطط الاستلام", icon: "map-pin", to: "/plan", perm: "orders" },
    { key: "asg", label: "الإسناد", icon: "truck", to: "/assign", perm: "orders" },
    { key: "disp", label: "النزاعات", icon: "triangle-alert", to: "/disputes", perm: "orders", count: "disputes" } ] },
  { title: "المال", items: [
    { key: "led", label: "الدفتر", icon: "book-open", to: "/ledger", perm: "money" },
    { key: "cap", label: "رأس المال", icon: "banknote", to: "/capital", perm: "money" },
    { key: "wd", label: "السحوبات", icon: "wallet", to: "/withdrawals", perm: "owner" },
    { key: "drv", label: "تسوية السائقين", icon: "hand-coins", to: "/drivers", perm: "money" },
    { key: "pay", label: "صرف الموردين", icon: "banknote", to: "/supplier-pay", perm: "money" },
    { key: "prof", label: "تقارير الربح", icon: "chart-column", to: "/profit", perm: "costs_view" } ] },
  { title: "الإدارة", items: [
    { key: "set", label: "الإعدادات", icon: "settings", to: "/settings", perm: "settings" },
    { key: "zones", label: "مناطق التوصيل", icon: "map-pin", to: "/zones", perm: "settings" },
    { key: "notif", label: "الإشعارات الجماعية", icon: "megaphone", to: "/broadcasts", perm: "notifications" },
    { key: "users", label: "المشرفون والصلاحيات", icon: "shield-check", to: "/users", perm: "users" },
    { key: "audit", label: "سجل التدقيق", icon: "history", to: "/audit", perm: "users" } ] },
];

export const ROUTES: Array<{ path: string; perm: Perm; screen: ComponentType }> = [
  { path: "/", perm: "any", screen: Main },
  { path: "/inbox", perm: "any", screen: OwnerInbox },
  { path: "/approvals", perm: "approvals", screen: Approvals },
  { path: "/suppliers", perm: "catalog", screen: Offers },
  { path: "/catalog", perm: "catalog", screen: Catalog },
  { path: "/catalog/:itemId", perm: "catalog", screen: ItemPricing },
  { path: "/categories", perm: "catalog", screen: Categories },
  { path: "/warehouses", perm: "warehouses", screen: Warehouses },
  { path: "/customers", perm: "customers", screen: Customers },
  { path: "/customers/:customerId", perm: "customers", screen: CustomerDetail },
  { path: "/orders", perm: "orders", screen: Orders },
  { path: "/plan", perm: "orders", screen: PickupPlan },
  { path: "/plan/:orderId", perm: "orders", screen: PickupPlan },
  { path: "/assign", perm: "orders", screen: Assign },
  { path: "/disputes", perm: "orders", screen: Disputes },
  { path: "/disputes/:disputeId", perm: "orders", screen: DisputeDetail },
  { path: "/ledger", perm: "money", screen: Ledger },
  { path: "/capital", perm: "money", screen: Capital },
  { path: "/withdrawals", perm: "owner", screen: Withdrawals },
  { path: "/drivers", perm: "money", screen: DriverSettle },
  { path: "/drivers/custody", perm: "orders", screen: Custody },
  { path: "/supplier-pay", perm: "money", screen: SupplierPay },
  { path: "/profit", perm: "costs_view", screen: Profit },
  { path: "/settings", perm: "settings", screen: Settings },
  { path: "/zones", perm: "settings", screen: Zones },
  { path: "/broadcasts", perm: "notifications", screen: Broadcast },
  { path: "/users", perm: "users", screen: Users },
  { path: "/audit", perm: "users", screen: Audit },
];
