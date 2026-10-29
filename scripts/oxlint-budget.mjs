#!/usr/bin/env bun

// oxlint-budget — el trinquete de oxlint, regla por regla.
//
// `.oxlintrc.json` lleva cada regla en "warn" con su conteo pinneado al lado:
//
//     "typescript/prefer-nullish-coalescing": "warn", // 338
//
// Ese número es el contrato: la deuda de esa regla puede bajar, nunca subir.
// Este script corre oxlint una sola vez y decide:
//
//   • cualquier error            → rojo, y los imprime.
//   • una regla por encima de su pin → rojo, con los sitios que sobran.
//   • una regla en cero          → dice que ya se puede subir a "error".
//   • todo igual o por debajo    → verde, con lo que bajó.
//
// Uso (desde el ROOT):
//   bun run lint:ox              # el gate: mide y adjudica
//   bun run lint:ox -- --update  # baja los pines que bajaron y promueve los ceros
//   bun run lint:ox -- --repin   # re-mide TODOS los pines (subiendo si hace falta).
//                                # Solo despues de un rebase o un merge que traiga
//                                # codigo ajeno: la deuda que entra no es tuya. Nunca
//                                # para tapar deuda propia — para eso esta --update.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(REPO_ROOT, ".oxlintrc.json");
// El valor pinneado suele ser el string simple `"warn"`, pero una regla puede
// llevar su propia config (p.ej. `["warn", { "allowNever": true }]`) cuando la
// reconfiguración, no el sitio, es el arreglo correcto — el pin sigue siendo
// el conteo del comentario, sea cual sea la forma del valor.
const PIN_PATTERN =
  /^(\s*)"([a-z0-9_/-]+)":\s*(?:"warn"|\[\s*"warn"[^\n]*?\])(,?)\s*\/\/\s*(\d+)\s*$/gm;

const repin = process.argv.includes("--repin");
const update = repin || process.argv.includes("--update");
const MAX_SITES_SHOWN = 8;

function readPins(source) {
  const pins = new Map();
  for (const match of source.matchAll(PIN_PATTERN))
    pins.set(match[2], Number(match[4]));
  return pins;
}

function runOxlint() {
  const result = spawnSync(
    path.join(REPO_ROOT, "node_modules/.bin/oxlint"),
    ["--type-aware", "--format=json"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (!result.stdout.trim())
    throw new Error(`oxlint no devolvió nada:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  return Array.isArray(report) ? report : (report.diagnostics ?? []);
}

// El code viene como `plugin(regla)`; la config lo escribe `plugin/regla`, y
// jsx-a11y es jsx_a11y en la config.
function ruleKey(code) {
  const match = /^([a-z0-9_-]+)\(([a-z0-9@/_.-]+)\)$/.exec(code ?? "");
  if (!match) return code ?? "desconocida";
  return `${match[1].replace("jsx-a11y", "jsx_a11y")}/${match[2]}`;
}

function site(diagnostic) {
  const label = diagnostic.labels?.[0]?.span;
  const where = label ? `:${label.line}:${label.column}` : "";
  return `${diagnostic.filename}${where}`;
}

const source = readFileSync(CONFIG_PATH, "utf8");
const pins = readPins(source);
const diagnostics = runOxlint();

const errors = [];
const byRule = new Map();
for (const diagnostic of diagnostics) {
  const severity = diagnostic.severity ?? diagnostic.level;
  if (severity === "error") {
    errors.push(diagnostic);
    continue;
  }
  const key = ruleKey(diagnostic.code);
  if (!byRule.has(key)) byRule.set(key, []);
  byRule.get(key).push(diagnostic);
}

if (errors.length > 0) {
  console.error(
    `✗ oxlint: ${errors.length} ${errors.length === 1 ? "error" : "errores"}.\n`,
  );
  for (const diagnostic of errors.slice(0, 40)) {
    console.error(
      `  ${site(diagnostic)}  ${diagnostic.code}  ${diagnostic.message.trim()}`,
    );
  }
  if (errors.length > 40) console.error(`  … y ${errors.length - 40} más.`);
  process.exit(1);
}

const grown = [];
const shrunk = [];
const cleared = [];
const unpinned = [];

for (const [rule, hits] of byRule) {
  const pin = pins.get(rule);
  if (pin === undefined) unpinned.push([rule, hits.length]);
  else if (hits.length > pin) grown.push([rule, pin, hits]);
  else if (hits.length < pin) shrunk.push([rule, pin, hits.length]);
}
for (const [rule, pin] of pins) {
  if (!byRule.has(rule)) cleared.push([rule, pin]);
}

const total = diagnostics.length - errors.length;

if (unpinned.length > 0) {
  console.error('✗ oxlint: reglas en "warn" sin pin en .oxlintrc.json.\n');
  for (const [rule, count] of unpinned) console.error(`  ${rule}: ${count}`);
  console.error(
    '\n  Añade `// <conteo>` al lado de la regla, o córrela a "error"/"off".',
  );
  process.exit(1);
}

if (grown.length > 0 && !repin) {
  console.error(
    `✗ oxlint: ${grown.length} ${grown.length === 1 ? "regla subió" : "reglas subieron"} sobre su pin.\n`,
  );
  for (const [rule, pin, hits] of grown) {
    console.error(`  ${rule}: ${hits.length} (el pin es ${pin})`);
    for (const diagnostic of hits.slice(0, MAX_SITES_SHOWN))
      console.error(`      ${site(diagnostic)}`);
    if (hits.length > MAX_SITES_SHOWN)
      console.error(`      … y ${hits.length - MAX_SITES_SHOWN} sitios más.`);
  }
  console.error(
    "\n  Arréglalo, o justifica el cambio de regla en .oxlintrc.json.",
  );
  process.exit(1);
}

const verdict =
  repin && grown.length > 0
    ? `${grown.length} ${grown.length === 1 ? "regla" : "reglas"} por re-pinnear`
    : "ninguna sobre su pin";
console.log(
  `✓ oxlint: 0 errores, ${total} avisos en ${byRule.size} reglas, ${verdict}.`,
);

for (const [rule, pin, hits] of grown)
  console.log(`  ↑ ${rule}: ${pin} → ${hits.length}`);
for (const [rule, pin, count] of shrunk)
  console.log(`  ↓ ${rule}: ${pin} → ${count}`);
for (const [rule, pin] of cleared)
  console.log(`  ✔ ${rule}: ${pin} → 0 — súbela a "error" en .oxlintrc.json.`);

if (!update || (shrunk.length === 0 && cleared.length === 0 && grown.length === 0)) process.exit(0);

let next = source;
const rewrites = repin
  ? [...shrunk, ...grown.map(([rule, pin, hits]) => [rule, pin, hits.length])]
  : shrunk;
for (const [rule, , count] of rewrites) {
  next = next.replace(
    new RegExp(
      `^(\\s*"${rule.replace("/", "\\/")}":\\s*(?:"warn"|\\[\\s*"warn"[^\\n]*?\\]))(,?)\\s*\\/\\/\\s*\\d+\\s*$`,
      "m",
    ),
    `$1$2 // ${count}`,
  );
}
for (const [rule] of cleared) {
  next = next.replace(
    new RegExp(
      `^(\\s*)"${rule.replace("/", "\\/")}":\\s*"warn"(,?)\\s*\\/\\/\\s*\\d+\\s*$`,
      "m",
    ),
    `$1"${rule}": "error"$2`,
  );
}
writeFileSync(CONFIG_PATH, next);
const moved = repin ? shrunk.length + grown.length : shrunk.length;
console.log(
  `
  .oxlintrc.json actualizado: ${moved} pines re-medidos, ${cleared.length} reglas promovidas a "error".`,
);
