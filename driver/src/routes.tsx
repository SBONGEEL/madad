/** خريطة تطبيق السائق كما في اللوحات المعتمدة (cv-drv). الشريط السفلي أربعة أقسام (DNav). */
import type { ComponentType } from "react";

import type { NavItem } from "@ui/kit";
import { Batch } from "@/screens/Batch";
import { Delivery } from "@/screens/Delivery";
import { Main } from "@/screens/Main";
import { PickupConfirm } from "@/screens/PickupConfirm";
import { Profile } from "@/screens/Profile";
import { Route } from "@/screens/Route";
import { Settlements } from "@/screens/Settlements";
import { Wallet } from "@/screens/Wallet";

export const NAV: NavItem[] = [
  { key: "home", label: "الرئيسية", icon: "house", to: "/" },
  { key: "route", label: "المسار", icon: "navigation", to: "/route" },
  { key: "wallet", label: "المحفظة", icon: "wallet", to: "/wallet" },
  { key: "me", label: "حسابي", icon: "user", to: "/profile" },
];

export const ROUTES: Array<{ path: string; screen: ComponentType }> = [
  { path: "/", screen: Main },
  { path: "/route", screen: Route },
  { path: "/route/:orderId", screen: Route },
  { path: "/stops/:stopId", screen: PickupConfirm },
  { path: "/orders/:orderId/batch", screen: Batch },
  { path: "/orders/:orderId/delivery", screen: Delivery },
  { path: "/wallet", screen: Wallet },
  { path: "/settlements", screen: Settlements },
  { path: "/profile", screen: Profile },
];
