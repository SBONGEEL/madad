/**
 * غلاف Capacitor رقيق (§14، كما في رَفّ): الحزمة لا تحمل الكود، بل نافذة على ما تخدمه الواجهة الآن.
 *
 * نسخة تطوير (§12-ك ٤): العنوان `localhost` على الهاتف، و`adb reverse` يجسره إلى جهاز المطوّر حيث تُخدم
 * الواجهة مبنيّةً و`/api` إلى خلفية التطوير. `cleartext` للتطوير وحده عبر USB، ويُغلق يوم يصير العنوان https
 * (madad.tajora.ly) — وحينها يُبدَّل هذا السطر وحده.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ly.madad.driver",
  appName: "مَدَد — السائق",
  webDir: "dist",
  server: {
    url: "http://localhost:5184",
    cleartext: true,
  },
};

export default config;
