/** خريطة تطبيق المورد كما في اللوحات المعتمدة (cv-sup). الشريط السفلي خمسة أقسام (SNav). */
import type { ComponentType } from "react";

import type { NavItem } from "@ui/kit";
import { Dues } from "@/screens/Dues";
import { Locations } from "@/screens/Locations";
import { Main } from "@/screens/Main";
import { OfferForm } from "@/screens/OfferForm";
import { Offers } from "@/screens/Offers";
import { Pickups } from "@/screens/Pickups";
import { Profile } from "@/screens/Profile";

export const NAV: Array<Omit<NavItem, "count"> & { countKey?: "pickups" }> = [
  { key: "home", label: "الرئيسية", icon: "house", to: "/" },
  { key: "offers", label: "العروض", icon: "package", to: "/offers" },
  { key: "pickups", label: "الاستلام", icon: "truck", to: "/pickups", countKey: "pickups" },
  { key: "dues", label: "المستحقات", icon: "wallet", to: "/dues" },
  { key: "me", label: "حسابي", icon: "user", to: "/profile" },
];

export const ROUTES: Array<{ path: string; screen: ComponentType }> = [
  { path: "/", screen: Main },
  { path: "/offers", screen: Offers },
  { path: "/offers/new", screen: OfferForm },
  { path: "/offers/:offerId", screen: OfferForm },
  { path: "/pickups", screen: Pickups },
  { path: "/dues", screen: Dues },
  { path: "/locations", screen: Locations },
  { path: "/profile", screen: Profile },
];
