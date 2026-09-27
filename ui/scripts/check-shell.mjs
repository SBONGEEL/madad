/**
 * حارس غلاف التطوير (طلب المالك 27/09): نسخة الإنتاج لا تحمل البحث عن الحاسوب ولا الخانة اليدوية ولا أي عنوان محلي.
 *
 * node ../ui/scripts/check-shell.mjs <app>
 *
 * ١) إعداد Capacitor في وضع الإنتاج: https وحده، webDir = dist، لا نص صريح ولا وكيل مستخدم للتطوير ولا dev-shell.
 * ٢) حزمة الواجهة المبنية (dist) خالية من علامات الغلاف ومن العناوين المحلية.
 * ٣) الشاهد الإيجابي: الإعداد نفسه في وضع التطوير يحمل الغلاف — فالفحص يرى ما يبحث عنه.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { transformSync } from "esbuild";

const APP = process.argv[2];
if (!APP) throw new Error("اذكر التطبيق: customer | supplier | driver");
const ROOT = resolve(import.meta.dirname, "..", "..");
const LOCAL = [/localhost/i, /127\.0\.0\.1/, /\b192\.168\.\d/, /\b10\.\d+\.\d+\.\d+/, /\.local\b/i, /madad-dev/i, /MadadDev/, /dev-shell/i];

async function load(mode) {
  const src = transformSync(readFileSync(join(ROOT, APP, "capacitor.config.ts"), "utf8"), { loader: "ts", format: "esm" }).code;
  const dir = mkdtempSync(join(tmpdir(), "madad-shell-"));
  const file = join(dir, "c.mjs");
  writeFileSync(file, src);
  const before = process.env.MADAD_SHELL;
  if (mode === "dev") process.env.MADAD_SHELL = "dev"; else delete process.env.MADAD_SHELL;
  try {
    return (await import(pathToFileURL(file).href + `?${mode}`)).default;
  } finally {
    if (before === undefined) delete process.env.MADAD_SHELL; else process.env.MADAD_SHELL = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const problems = [];
const prod = await load("prod");
const text = JSON.stringify(prod);
if (!String(prod.server?.url ?? "").startsWith("https://")) problems.push(`server.url ليس https: ${prod.server?.url}`);
if (prod.server?.cleartext) problems.push("cleartext مفتوح في الإنتاج");
if (prod.webDir !== "dist") problems.push(`webDir في الإنتاج ${prod.webDir}`);
if (prod.android?.allowMixedContent) problems.push("allowMixedContent في الإنتاج");
for (const re of LOCAL) if (re.test(text)) problems.push(`إعداد الإنتاج يحمل ${re}`);

function* files(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|html|css|json|webmanifest)$/.test(n)) yield p;
  }
}
let scanned = 0;
for (const f of files(join(ROOT, APP, "dist"))) {
  const s = readFileSync(f, "utf8");
  scanned++;
  for (const re of LOCAL) if (re.test(s)) problems.push(`${f.slice(ROOT.length + 1)} يحمل ${re}`);
}
if (!scanned) problems.push("لا حزمة مبنية في dist — ابنِ التطبيق أولاً");

const dev = await load("dev");
if (!String(dev.webDir).includes("dev-shell") || !/MadadDev/.test(dev.android?.appendUserAgent ?? ""))
  problems.push("الشاهد الإيجابي أعمى: وضع التطوير لا يحمل الغلاف");

if (problems.length) {
  console.error("حارس الغلاف: فشل\n" + problems.map((p) => "— " + p).join("\n"));
  process.exit(1);
}
console.log(`حارس الغلاف: سليم — الإنتاج ${prod.server.url}، ${scanned} ملفاً في dist بلا عنوان محلي، والتطوير يحمل الغلاف.`);
