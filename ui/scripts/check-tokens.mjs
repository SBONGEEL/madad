/**
 * حارس الرموز: لا لون ولا قياس مكتوب داخل مكوّن (§14).
 * يقرأ المجلدات المعطاة (src/ للواجهة وui/ المشترك)، ويستثني ملفَّي الرموز ونسخة أنماط نظام التصميم
 * (tokens.css وscale.css وkit.css) والأيقونات المولَّدة. يفشل عند hex أو rgb أو px/rem أو لون Tailwind الافتراضي.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const DIRS = process.argv.slice(2).map((d) => resolve(d));
const EXEMPT = new Set(["tokens.css", "scale.css", "kit.css", "icons.ts", "tailwind.preset.js"]);

const RULES = [
  { name: "لون hex", re: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "لون rgb/hsl", re: /\b(rgba?|hsla?)\(/g },
  { name: "قياس بالبكسل أو rem", re: /\b\d+(\.\d+)?(px|rem|em)\b/g },
  { name: "لون من لوحة Tailwind الافتراضية", re: /\b(bg|text|border|ring|fill|stroke|accent)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g },
  { name: "قيمة عشوائية فيها لون أو قياس", re: /\[[^\]]*(#[0-9a-fA-F]{3,8}|\d+px)[^\]]*\]/g },
];

// الحارس يثبت أنه يرى قبل أن يحكم: عيّنة يجب أن تُمسك بكل قاعدة.
const PROBE = ["color: #0F3D3A;", "background: rgba(0,0,0,.5);", "padding: 12px;", 'class="bg-red-500"', 'class="shadow-[inset_0_-3px_0_#000]"'];
RULES.forEach((rule, i) => {
  rule.re.lastIndex = 0;
  if (!rule.re.test(PROBE[i])) {
    console.error(`حارس الرموز معطَّل: القاعدة «${rule.name}» لا تمسك عيّنتها.`);
    process.exit(1);
  }
});

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "scripts") return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = DIRS.flatMap(walk).filter((f) => /\.(ts|tsx|css)$/.test(f) && !EXEMPT.has(basename(f)));
const offences = [];
for (const file of files) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (line.includes("check:tokens-allow")) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      const hit = rule.re.exec(line);
      if (hit) offences.push(`${relative(process.cwd(), file)}:${i + 1} — ${rule.name}: ${hit[0]}`);
    }
  });
}

if (offences.length) {
  console.error("حارس الرموز: قيمة مكتوبة خارج ملف الرموز\n" + offences.join("\n"));
  process.exit(1);
}
console.log(`حارس الرموز: نظيف — ${files.length} ملفاً، كل لون وقياس من ui/tokens.css وui/scale.css.`);
