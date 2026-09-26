/**
 * يولّد src/api/types.ts لواجهةٍ من OpenAPI الخلفية: كل مخطط تستعمله مسارات جمهورها و/api/auth.
 * لا يُحرَّر الملف المولَّد يدوياً؛ وcheck:contract يفشل إن تأخر عن الخادم.
 *
 * node ../ui/scripts/gen-types.mjs <audience>     (المصدر: MADAD_OPENAPI ملفاً، أو الخادم على VITE_API_TARGET)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSpec, mine, shortName } from "./openapi.mjs";

const AUD = process.argv[2];
if (!AUD) throw new Error("اذكر الجمهور: admin | customer | supplier | driver");

const spec = await loadSpec();
const S = spec.components?.schemas ?? {};
// عند تضارب الأسماء بين الجماهير يُؤخذ مخطط هذا الجمهور
const chosen = new Map();
for (const key of Object.keys(S)) {
  const name = shortName(key);
  const prev = chosen.get(name);
  if (!prev || key.includes(`__${AUD}__`)) chosen.set(name, key);
}

const used = new Set();
function collect(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const key = schema.$ref.split("/").pop();
    if (!used.has(key)) {
      used.add(key);
      collect(S[key]);
    }
    return;
  }
  for (const v of Object.values(schema)) if (typeof v === "object") collect(v);
}
for (const [path, ops] of Object.entries(spec.paths)) {
  if (!mine(AUD)(path)) continue;
  for (const op of Object.values(ops)) {
    collect(op.requestBody);
    for (const r of Object.values(op.responses ?? {})) if (!String(r).startsWith("4")) collect(r);
  }
}
for (const key of [...used]) if (/Validation|HTTPValidation/.test(key)) used.delete(key);

function ts(schema) {
  if (!schema) return "unknown";
  if (schema.$ref) return shortName(schema.$ref.split("/").pop());
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  for (const k of ["anyOf", "oneOf"]) if (schema[k]) return [...new Set(schema[k].map(ts))].join(" | ");
  if (schema.allOf) return schema.allOf.map(ts).join(" & ");
  switch (schema.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const inner = ts(schema.items);
      return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object":
      if (schema.properties) return `{ ${Object.entries(schema.properties).map(([k, v]) => `${k}: ${ts(v)}`).join("; ")} }`;
      if (schema.additionalProperties && schema.additionalProperties !== true) return `Record<string, ${ts(schema.additionalProperties)}>`;
      return "Record<string, unknown>";
    default: return "unknown";
  }
}

const names = [...used].map((k) => [shortName(k), chosen.get(shortName(k)) ?? k]).sort(([a], [b]) => a.localeCompare(b));
const seen = new Set();
let out = `/**\n * مولَّد من OpenAPI الخلفية (ui/scripts/gen-types.mjs ${AUD}) — لا يُحرَّر يدوياً.\n` +
  " * المال والكميات نصوص عشرية بثلاث خانات كما يرسلها الخادم؛ الحقل الاختياري «?» قد لا يصل\n" +
  " * (تكلفةٌ محجوبة عمّن لا يملك «التكاليف»، أو قيمة بإعداد).\n */\n";
for (const [name, key] of names) {
  if (seen.has(name)) continue;
  seen.add(name);
  const s = S[key];
  if (s.enum) {
    out += `\nexport type ${name} = ${ts(s)};\n`;
    continue;
  }
  const req = new Set(s.required ?? []);
  out += `\nexport interface ${name} {\n`;
  for (const [f, v] of Object.entries(s.properties ?? {})) out += `  ${f}${req.has(f) ? "" : "?"}: ${ts(v)};\n`;
  out += "}\n";
}
writeFileSync(join(process.cwd(), "src", "api", "types.ts"), out);
console.log(`types.ts: ${seen.size} مخططاً لجمهور ${AUD}.`);
