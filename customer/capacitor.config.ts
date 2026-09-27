/**
 * غلاف Capacitor رقيق (§14، كما في رَفّ): الحزمة لا تحمل الكود، بل نافذة على ما تخدمه الواجهة.
 *
 * الإنتاج (الافتراضي): `server.url` على https في نطاق مَدَد، بلا نص صريح ولا غلاف تطوير.
 * التطوير (`MADAD_SHELL=dev npx cap sync`، طلب المالك 27/09): الحزمة تحمل ui/dev-shell وحده، يجد حاسوب التطوير على
 * شبكة البيت (آخر عنوان ← اسم الحاسوب .local ← بحث ← خانة يدوية) ثم يفتح التطبيق منه بـhttp. اسم الحاسوب يُقرأ
 * وقت البناء ولا يُكتب في المستودع. ui/scripts/check-shell.mjs يثبت أن الإنتاج خالٍ من هذا كله.
 */
import { hostname } from "node:os";

import type { CapacitorConfig } from "@capacitor/cli";

const dev = process.env.MADAD_SHELL === "dev";

const config: CapacitorConfig = dev
  ? {
      appId: "ly.madad.customer",
      appName: "مَدَد",
      webDir: "../ui/dev-shell",
      android: { allowMixedContent: true, appendUserAgent: `MadadDev/customer/5182/${hostname().replace(/[^\w-]/g, "")}` },
      server: { cleartext: true, androidScheme: "http" },
    }
  : {
      appId: "ly.madad.customer",
      appName: "مَدَد",
      webDir: "dist",
      server: { url: "https://madad.tajora.ly" },
    };

export default config;
