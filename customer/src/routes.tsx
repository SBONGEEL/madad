/** خريطة تطبيق العميل كما في اللوحات المعتمدة (cv-cust). الشريط السفلي أربعة أقسام (CNav). */
import type { ComponentType } from "react";

import type { NavItem } from "@ui/kit";
import { Account } from "@/screens/Account";
import { Branches } from "@/screens/Branches";
import { Cart } from "@/screens/Cart";
import { Category } from "@/screens/Category";
import { Checkout } from "@/screens/Checkout";
import { Dispute } from "@/screens/Dispute";
import { Lists } from "@/screens/Lists";
import { Main } from "@/screens/Main";
import { Notifications } from "@/screens/Notifications";
import { Orders } from "@/screens/Orders";
import { Product } from "@/screens/Product";
import { Reports } from "@/screens/Reports";
import { Search } from "@/screens/Search";
import { Tracking } from "@/screens/Tracking";

export const NAV: Array<Omit<NavItem, "count"> & { countKey?: "cart" }> = [
  { key: "home", label: "الرئيسية", icon: "house", to: "/" },
  { key: "cart", label: "السلة", icon: "shopping-cart", to: "/cart", countKey: "cart" },
  { key: "orders", label: "الطلبات", icon: "clipboard-list", to: "/orders" },
  { key: "me", label: "حسابي", icon: "user", to: "/account" },
];

export const ROUTES: Array<{ path: string; screen: ComponentType }> = [
  { path: "/", screen: Main },
  { path: "/category/:categoryId", screen: Category },
  { path: "/product/:itemId", screen: Product },
  { path: "/search", screen: Search },
  { path: "/cart", screen: Cart },
  { path: "/checkout", screen: Checkout },
  { path: "/orders", screen: Orders },
  { path: "/orders/:orderId", screen: Tracking },
  { path: "/orders/:orderId/dispute", screen: Dispute },
  { path: "/lists", screen: Lists },
  { path: "/account", screen: Account },
  { path: "/notifications", screen: Notifications },
  { path: "/branches", screen: Branches },
  { path: "/reports", screen: Reports },
];
