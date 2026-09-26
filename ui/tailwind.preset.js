/**
 * إعداد Tailwind المشترك: كل قيمة var(--…) من ui/tokens.css وui/scale.css — لا رقم ولا لون هنا.
 * أسماء المسافات على عُرف Tailwind (4 = 16px) لكن قيمتها من الرموز.
 */
const v = (n) => `var(--${n})`;

const colors = Object.fromEntries(
  ["primary", "secondary", "success", "error", "warning", "white", "page", "surface", "ink", "ink-muted", "border", "border-strong",
   "primary-tint", "secondary-tint", "success-tint", "error-tint", "warning-tint", "primary-text", "secondary-text", "success-text",
   "error-text", "on-primary", "on-primary-muted", "on-secondary", "on-error", "on-warning", "action", "on-action", "action-green"]
    .map((n) => [n, v(n)]),
);

const space = { 0: "0", 0.5: v("s-2"), 1: v("s-4"), 1.5: v("s-6"), 2: v("s-8"), 2.5: v("s-10"), 3: v("s-12"), 3.5: v("s-14"),
  4: v("s-16"), 5: v("s-20"), 6: v("s-24"), 7: v("s-28"), 8: v("s-32"), 10: v("s-40"), 12: v("s-48"),
  side: v("w-side"), login: v("w-login"), "field-sm": v("w-field-sm"), "field-md": v("w-field-md"), "col-side": v("w-col-side"),
  chart: v("h-chart"), map: v("h-map"), row: v("h-row"), main: v("w-main-max") };

export default {
  theme: {
    colors: { ...colors, transparent: "transparent", current: "currentColor" },
    spacing: space,
    fontFamily: { sans: v("font-sans"), num: v("font-num") },
    fontSize: Object.fromEntries(["11", "12", "13", "14", "15", "16", "17", "18", "19", "22", "26"].map((n) => [n, v(`fs-${n}`)])),
    lineHeight: { 20: v("lh-20"), 22: v("lh-22"), 30: v("lh-30"), none: "1", normal: "1.6" },
    borderRadius: { none: "0", sm: v("radius-sm"), md: v("radius-md"), lg: v("radius-lg"), full: v("radius-pill") },
    borderWidth: { 0: "0", DEFAULT: v("hair"), 2: v("hair-2") },
    boxShadow: { card: v("shadow-card"), sheet: v("shadow-sheet"), none: "none" },
    extend: {},
  },
  // بلا preflight: اللوحات صُمّمت على أنماط المتصفح + kit.css، كما في نظام التصميم
  corePlugins: { preflight: false },
};
