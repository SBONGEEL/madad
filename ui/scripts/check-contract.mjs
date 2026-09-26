/**
 * حارس العقد: يفحص السلك لا طرفاً واحداً (§14).
 *
 * 1) كل مسار تناديه الواجهة موجود في OpenAPI بالطريقة نفسها — لا نداء إلى مسار غير قائم.
 * 2) كل مسار في /api/<الجمهور> وأبواب /api/auth له مستهلك — لا مسار مبنيّ ومنسيّ،
 *    إلا ما أُعلن في src/api/not-wired.json بسببه.
 * 3) src/api/types.ts يطابق مخططات الخادم حقلاً بحقل (مولَّد؛ تأخّره عن الخادم يُسقط الحارس).
 *
 * node ../ui/scripts/check-contract.mjs <audience>
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { loadSpec, mine, shortName } from "./openapi.mjs";

const AUD = process.argv[2];
const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const OTHERS = ["admin", "customer", "supplier", "driver"].filter((a) => a !== AUD);
const notWiredFile = join(SRC, "api", "not-wired.json");
const NOT_WIRED = new Map(Object.entries(existsSync(notWiredFile) ? JSON.parse(readFileSync(notWiredFile, "utf8")) : {}));

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** "/api/admin/orders/${id}/cancel${qs(…)}" ← "/api/admin/orders/{}/cancel" */
const normalize = (p) => p.replace(/\$\{qs\(.*$/, "").replace(/\?.*$/, "").replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}").replace(/\/$/, "");

// الأبواب العامة للمصادقة بمسار فيه {audience}: الواجهة تناديها بجمهورها
const authAud = (p) => p.replace(`/api/auth/${AUD}/`, "/api/auth/{}/");

function clientCalls() {
  const found = new Map();
  // عميل السلك المشترك (ui/client.ts) ينادي أبواب التجديد والخروج لكل الواجهات
  for (const file of [...walk(SRC), join(ROOT, "..", "ui", "client.ts")].filter((f) => /\.(ts|tsx)$/.test(f))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      for (const hit of line.matchAll(/\b(get|post|put|patch|del|open|postAs|raw)(?:<[^>]*>)?\(\s*(?:"(GET|POST|PUT|PATCH|DELETE)",\s*)?[`"']([^`"']*\/api\/[^`"']*)[`"']/g)) {
        const method = hit[2] ?? { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE", open: "?", postAs: "POST", raw: "?" }[hit[1]];
        const key = `${method} ${authAud(normalize(hit[3]))}`;
        if (!found.has(key)) found.set(key, `${relative(ROOT, file)}:${i + 1}`);
      }
    });
  }
  return found;
}

const spec = await loadSpec();
const S = spec.components?.schemas ?? {};
const server = new Map();
for (const [path, ops] of Object.entries(spec.paths)) {
  if (!mine(AUD)(path)) continue;
  if (OTHERS.some((a) => path.startsWith(`/api/auth/${a}/`))) continue;
  for (const m of Object.keys(ops)) server.set(`${m.toUpperCase()} ${normalize(path)}`, path);
}

const client = clientCalls();
const problems = [];
for (const [key, where] of client) {
  const [method, path] = key.split(" ");
  const ok = method === "?" ? [...server.keys()].some((k) => k.endsWith(` ${path}`)) : server.has(key);
  if (!ok) problems.push(`الواجهة تنادي ما ليس في الخلفية: ${key} (${where})`);
}
const called = new Set([...client.keys()].map((k) => k.split(" ")[1]));
for (const [key, path] of server) {
  const [method, p] = key.split(" ");
  if (client.has(key) || client.has(`? ${p}`)) continue;
  const reason = NOT_WIRED.get(`${method} ${path}`);
  if (reason) console.log(`— مؤجَّل معلَن: ${method} ${path} (${reason})`);
  else problems.push(`مسار في الخلفية بلا مستهلك في الواجهة: ${method} ${path}${called.has(p) ? " (المسار مستهلك بطريقة أخرى)" : ""}`);
}
for (const k of NOT_WIRED.keys()) {
  const [m, p] = k.split(" ");
  if (client.has(`${m} ${normalize(p)}`)) problems.push(`معلَن مؤجَّلاً وهو موصول: ${k} — احذفه من not-wired.json`);
}

// 3) الأنواع
const text = readFileSync(join(SRC, "api", "types.ts"), "utf8");
let compared = 0;
for (const m of text.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
  const [, name, body] = m;
  const key = Object.keys(S).find((k) => shortName(k) === name && k.includes(`__${AUD}__`)) ?? Object.keys(S).find((k) => shortName(k) === name);
  if (!key) {
    problems.push(`types.ts: ${name} لا يقابله مخطط في الخلفية — أعد التوليد`);
    continue;
  }
  const mineFields = new Set([...body.matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1]));
  const theirs = new Set(Object.keys(S[key].properties ?? {}));
  compared += 1;
  for (const f of mineFields) if (!theirs.has(f)) problems.push(`${name}.${f} في types.ts ولا يرسله الخادم — أعد التوليد`);
  for (const f of theirs) if (!mineFields.has(f)) problems.push(`${name}.${f} يرسله الخادم ولا يعرفه types.ts — أعد التوليد`);
}

if (problems.length) {
  console.error("حارس العقد: انقطاع في السلك\n" + problems.map((p) => `  • ${p}`).join("\n"));
  process.exit(1);
}
console.log(`حارس العقد: سليم — ${client.size} نداءً في الواجهة، ${server.size} عملية في الخلفية، ${compared} مخططاً مطابَقاً.`);
