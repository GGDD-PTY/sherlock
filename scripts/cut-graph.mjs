#!/usr/bin/env node
// cut-graph.mjs — corte de borrado dirigido por grafo.
//
// Dado un árbol, una lista de puntos de entrada MUERTOS y una lista de puntos de
// entrada VIVOS, calcula:
//   cut        = archivos alcanzables desde los muertos y NO desde los vivos
//   ambiguous  = alcanzables desde ambos (los decide una persona)
//   components = componentes conexos de `cut` (grafo no dirigido) → un cirujano por
//                componente, en paralelo, sin conflictos
//   stringRefs = por cada archivo de `cut`, qué archivo vivo lo menciona por string
//                (basename o segmento de ruta) — pista de referencias colgantes
//
// Uso:
//   node scripts/cut-graph.mjs --root <repo> --dead dead.txt --live live.txt [--json out.json]
//
// Las listas son rutas relativas al repo (una por línea, `#` comenta). Un directorio
// vale como "todo archivo de código debajo". Los tests (`__tests__`, `.test.`, `.spec.`)
// no son raíces vivas: se reportan aparte como `testsOfCut` (tests que solo importan
// archivos del corte) para borrarlos en la misma ola.
//
// Sin dependencias: el grafo de imports se parsea con regex sobre import/export/require/
// import() y se resuelve `@/` → src, relativos, index y extensiones ts/tsx/js/mjs/json.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true])
    return acc
  }, []),
)
if (!args.root || !args.dead || !args.live) {
  console.error('uso: node scripts/cut-graph.mjs --root <repo> --dead dead.txt --live live.txt [--json out.json]')
  process.exit(2)
}
const ROOT = resolve(args.root)
const APP = join(ROOT, 'sherlock', 'app')
const SCAN_ROOTS = ['src', 'convex', 'e2e'].map((d) => join(APP, d)).filter(existsSync)
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.json']
const CODE_RE = /\.(ts|tsx|js|mjs|jsx)$/
const SKIP_DIRS = new Set(['node_modules', '_generated', '.next', 'coverage', 'dist', '.turbo'])

// ---------- walk ----------
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || (entry.startsWith('.') && entry !== '.well-known')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (CODE_RE.test(entry)) out.push(full)
  }
  return out
}
const files = SCAN_ROOTS.flatMap((r) => walk(r))
const fileSet = new Set(files)
const rel = (f) => relative(ROOT, f).split(sep).join('/')
const isTest = (f) => /__tests__|\.test\.|\.spec\./.test(f)

// ---------- import parsing ----------
const IMPORT_RE =
  /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+|\brequire\(\s*|\bimport\(\s*|\bvi\.mock\(\s*|\bjest\.mock\(\s*)['"]([^'"\n]+)['"]/g

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith('node:') || /^[a-z@][\w./-]*$/i.test(spec) && !spec.startsWith('@/') && !spec.startsWith('.')) {
    // bare package (react, convex/values, @radix-ui/...) — except our alias
    if (!spec.startsWith('@/')) return null
  }
  let base
  if (spec.startsWith('@/')) base = join(APP, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, 'index' + e))]
  for (const c of candidates) {
    if (fileSet.has(c)) return c
    if (existsSync(c) && statSync(c).isFile() && c.endsWith('.json')) return c
  }
  return null
}

// Convex: el frontend no importa los módulos, los llama por `api.modulo.fn` /
// `internal.modulo.fn` (y `api.carpeta.modulo.fn` para subcarpetas). Esas
// referencias son aristas reales del grafo aunque el import no exista.
const CONVEX_DIR = join(APP, 'convex')
const API_RE = /\b(?:api|internal)\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?(?:\.([A-Za-z_$][\w$]*))?/g
function resolveApiRef(a, b, c) {
  const tries = []
  if (a && b && c) tries.push(join(CONVEX_DIR, a, b + '.ts'))
  if (a && b) tries.push(join(CONVEX_DIR, a + '.ts'), join(CONVEX_DIR, a, b + '.ts'))
  if (a) tries.push(join(CONVEX_DIR, a + '.ts'))
  for (const t of tries) if (fileSet.has(t)) return t
  return null
}

const deps = new Map() // file -> Set(file)
const rdeps = new Map() // file -> Set(file) reverse
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  const out = new Set()
  for (const m of src.matchAll(IMPORT_RE)) {
    const to = resolveSpec(f, m[1])
    if (to && to !== f) out.add(to)
  }
  if (/\b(?:api|internal)\./.test(src)) {
    for (const m of src.matchAll(API_RE)) {
      const to = resolveApiRef(m[1], m[2], m[3])
      if (to && to !== f) out.add(to)
    }
  }
  deps.set(f, out)
  for (const to of out) {
    if (!rdeps.has(to)) rdeps.set(to, new Set())
    rdeps.get(to).add(f)
  }
}

// ---------- entry points ----------
function readList(p) {
  return readFileSync(resolve(p), 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
}
function expandEntry(line) {
  const abs = join(ROOT, line)
  if (existsSync(abs) && statSync(abs).isDirectory()) return walk(abs).filter((f) => !isTest(f))
  if (fileSet.has(abs)) return [abs]
  // allow spec without extension
  for (const e of EXTS) if (fileSet.has(abs + e)) return [abs + e]
  console.error(`aviso: punto de entrada no encontrado: ${line}`)
  return []
}
const dead = new Set(readList(args.dead).flatMap(expandEntry))
const live = new Set(readList(args.live).flatMap(expandEntry))
// Raíces implícitas del framework: Next.js monta estos archivos por convención
// (nadie los importa) y Convex carga http/crons/auth.config solo. Son vivos salvo
// que estén en la lista muerta.
const FRAMEWORK_ROOT_RE =
  /\/src\/app\/(?:.*\/)?(?:page|layout|template|default|loading|error|not-found|global-error|global-not-found|route|robots|sitemap|manifest|icon|apple-icon|opengraph-image|twitter-image|proxy|middleware|instrumentation)\.(?:ts|tsx|js|mjs)$|\/src\/(?:proxy|middleware|instrumentation)\.ts$|\/src\/i18n\/(?:request|routing|navigation)\.ts$|\/convex\/(?:http|crons|auth\.config)\.ts$/
for (const f of files) if (FRAMEWORK_ROOT_RE.test(f) && !isTest(f) && !dead.has(f)) live.add(f)
for (const d of dead) live.delete(d)

function reach(roots) {
  const seen = new Set(roots)
  const stack = [...roots]
  while (stack.length) {
    const f = stack.pop()
    for (const to of deps.get(f) ?? []) if (!seen.has(to)) { seen.add(to); stack.push(to) }
  }
  return seen
}
const fromDead = reach(dead)
const fromLive = reach(live)

const cut = [...fromDead].filter((f) => !fromLive.has(f) && !isTest(f)).sort()
const cutSet = new Set(cut)
// Alcanzable desde ambos lados: el archivo vivo que lo importa es el que hay que
// EDITAR (quitar el uso) antes de borrar. Se listan los llamadores vivos.
const liveCallers = (f) => [...(rdeps.get(f) ?? [])].filter((x) => fromLive.has(x) && !cutSet.has(x) && !isTest(x)).map(rel)
const ambiguous = [...fromDead].filter((f) => fromLive.has(f) && !dead.has(f) && !isTest(f)).sort()
const ambiguousCallers = Object.fromEntries(ambiguous.map((f) => [rel(f), liveCallers(f)]))
// Raíz muerta que un archivo vivo todavía llama (p. ej. `api.investors.x` desde una
// página viva): migrar el caller primero, borrar después.
const deadRootsStillCalled = Object.fromEntries([...dead].filter((f) => fromLive.has(f)).map((f) => [rel(f), liveCallers(f)]))
// Nada vivo llega a estos archivos (huérfanos: lo que knip reportaría después del
// corte). No están en `cut` porque tampoco los alcanza una raíz muerta.
const unreached = files.filter((f) => !fromLive.has(f) && !fromDead.has(f) && !isTest(f) && !/\.json$/.test(f)).sort()
const deadSet = new Set([...cut, ...unreached])

// tests that only import cut files (and nothing live) → go in the same wave
const testsOfCut = files
  .filter((f) => isTest(f))
  .filter((f) => {
    const d = [...(deps.get(f) ?? [])].filter((x) => !isTest(x))
    return d.length > 0 && d.some((x) => deadSet.has(x)) && d.every((x) => deadSet.has(x) || !fromLive.has(x))
  })
  .sort()

// Tests que importan algo muerto: quedan rotos tras el corte. Se editan (quitar el
// caso) o se borran; el cirujano decide leyendo el test.
const testsTouchingCut = files
  .filter((f) => isTest(f) && !testsOfCut.includes(f))
  .filter((f) => [...(deps.get(f) ?? [])].some((x) => deadSet.has(x)))
  .sort()

// ---------- components (undirected, restricted to cut) ----------
const compOf = new Map()
const components = []
for (const f of cut) {
  if (compOf.has(f)) continue
  const comp = []
  const stack = [f]
  compOf.set(f, components.length)
  while (stack.length) {
    const x = stack.pop()
    comp.push(x)
    const nb = [...(deps.get(x) ?? []), ...(rdeps.get(x) ?? [])].filter((y) => cutSet.has(y))
    for (const y of nb) if (!compOf.has(y)) { compOf.set(y, components.length); stack.push(y) }
  }
  components.push(comp.sort())
}
components.sort((a, b) => b.length - a.length)

// ---------- string refs from live files ----------
const liveFiles = [...fromLive].filter((f) => !cutSet.has(f))
const liveSrc = new Map(liveFiles.map((f) => [f, readFileSync(f, 'utf8')]))
function stringRefsFor(f) {
  const base = f.split('/').pop().replace(/\.(tsx?|m?js)$/, '')
  const r = rel(f)
  const routeSeg = r.match(/src\/app\/(?:\[locale\]\/)?(?:\(app\)\/)?([^/]+(?:\/[^/]+)?)\/(?:page|route|layout)\.tsx?$/)?.[1]
  const needles = new Set([base])
  if (routeSeg) needles.add('/' + routeSeg)
  if (/^index$/.test(base)) needles.delete(base)
  const hits = []
  for (const [lf, s] of liveSrc) {
    for (const n of needles) if (n.length >= 4 && s.includes(n)) { hits.push({ file: rel(lf), needle: n }); break }
  }
  return hits
}
const stringRefs = Object.fromEntries(cut.map((f) => [rel(f), stringRefsFor(f)]).filter(([, h]) => h.length))

// ---------- output ----------
const out = {
  root: ROOT,
  scanned: files.length,
  deadRoots: [...dead].map(rel).sort(),
  liveRoots: live.size,
  cut: cut.map(rel),
  unreached: unreached.map(rel),
  ambiguous: ambiguous.map(rel),
  ambiguousCallers,
  deadRootsStillCalled,
  testsOfCut: testsOfCut.map(rel),
  testsTouchingCut: testsTouchingCut.map(rel),
  components: components.map((c) => c.map(rel)),
  stringRefs,
}
if (args.json) writeFileSync(resolve(args.json), JSON.stringify(out, null, 2))

const pad = (s, n) => String(s).padEnd(n)
console.log(`archivos escaneados : ${files.length}`)
console.log(`raíces muertas      : ${dead.size}   raíces vivas: ${live.size}`)
console.log(`alcanzable muerto   : ${fromDead.size}   alcanzable vivo: ${fromLive.size}`)
console.log(`CUT                 : ${cut.length}`)
console.log(`HUÉRFANOS           : ${unreached.length}  (ninguna raíz llega; knip los reportaría tras el corte)`)
console.log(`AMBIGUOS            : ${ambiguous.length}  (alcanzables desde ambos — editar el caller vivo, luego borrar)`)
console.log(`raíces muertas aún llamadas: ${Object.keys(deadRootsStillCalled).length}  (migrar callers antes de borrar)`)
console.log(`tests del corte     : ${testsOfCut.length}  (solo importan muertos → borrar)   tests que tocan el corte: ${testsTouchingCut.length} (editar)`)
console.log(`componentes         : ${components.length}  tamaños: ${components.slice(0, 12).map((c) => c.length).join(', ')}${components.length > 12 ? ', …' : ''}`)
console.log(`refs por string     : ${Object.keys(stringRefs).length} archivos del corte mencionados por archivos vivos`)
console.log('')
console.log(pad('componente', 12) + pad('archivos', 10) + 'primeros')
components.slice(0, 12).forEach((c, i) => console.log(pad(`#${i + 1}`, 12) + pad(c.length, 10) + c.slice(0, 3).map(rel).join(', ')))
if (ambiguous.length) {
  console.log('\nambiguos (primeros 20):')
  ambiguous.slice(0, 20).forEach((f) => console.log('  ' + rel(f) + '  ← ' + (ambiguousCallers[rel(f)].slice(0, 2).join(', ') || '(solo por api.*)')))
}
if (args.json) console.log(`\njson: ${resolve(args.json)}`)
