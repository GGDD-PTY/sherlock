#!/usr/bin/env bun

// effect-status — cuántos archivos del proyecto corren sobre Effect y cuántos no.
//
// [F] 2026-09-08 21:22 fijó el orden del trabajo: primero se llena todo de
// Effect sin parar a medir, después se prueba, después se atacan los rojos en
// vueltas hasta que bajen, y solo al final se mide rendimiento. Este script
// existe para la palabra «bajen». Sin un número que se pueda correr en
// cualquier momento, «cada vez menos rojos» es una impresión.
//
// No es un gate. No falla nunca por sí solo. Cuenta y reporta.
//
//   bun run effect:status              informe legible
//   bun run effect:status --top 40     los 40 archivos más grandes que faltan
//   bun run effect:status --json       para otro script o un panel
//   bun run effect:status --area convex   una sola área
//
// Qué cuenta como «tiene Effect»: que el archivo importe de `effect` o de
// alguno de sus submódulos (`effect/Schema`, `effect/testing`, …). Un archivo
// que solo importa tipos con `import type` no cuenta, porque los tipos se
// borran al compilar y no cambian el comportamiento en runtime.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const APP = join(ROOT, 'sherlock', 'app')

// Las áreas en el orden en que se van a atacar, no en orden alfabético: el
// backend primero porque es el bloque más grande y el que nadie ha tocado.
const AREAS = [
  { name: 'convex', dir: join(APP, 'convex') },
  { name: 'lib', dir: join(APP, 'src', 'lib') },
  { name: 'components', dir: join(APP, 'src', 'components') },
  { name: 'app', dir: join(APP, 'src', 'app') },
  { name: 'hooks', dir: join(APP, 'src', 'hooks') },
]

// `_generated` lo escribe Convex y CLAUDE.md prohíbe editarlo. Los `.d.ts` no
// tienen runtime. Los tests van aparte: convertirlos no es el trabajo, y
// contarlos con los demás inflaría el avance.
const SKIP_DIR = new Set(['_generated', 'node_modules', '.next', 'dist', '__tests__'])
const CODE = /\.tsx?$/
const DECLARATION = /\.d\.ts$/

// `from 'effect'` y `from 'effect/loQueSea'`, en import o en re-export.
// `import type` se excluye a propósito: no sobrevive a la compilación.
const IMPORTS_EFFECT = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s+['"]effect(?:\/[\w/-]+)?['"]/m

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(join(dir, entry.name), out)
      continue
    }
    if (CODE.test(entry.name) && !DECLARATION.test(entry.name)) out.push(join(dir, entry.name))
  }
  return out
}

function inspect(file) {
  const source = readFileSync(file, 'utf8')
  return {
    path: relative(ROOT, file),
    lines: source.split('\n').length,
    hasEffect: IMPORTS_EFFECT.test(source),
  }
}

function measure() {
  const areas = AREAS.map((area) => {
    const files = walk(area.dir).map(inspect)
    const withEffect = files.filter((f) => f.hasEffect)
    const without = files.filter((f) => !f.hasEffect)
    return {
      name: area.name,
      total: files.length,
      done: withEffect.length,
      pending: without.length,
      linesPending: without.reduce((sum, f) => sum + f.lines, 0),
      files: without.toSorted((a, b) => b.lines - a.lines),
    }
  })

  const total = areas.reduce((sum, a) => sum + a.total, 0)
  const done = areas.reduce((sum, a) => sum + a.done, 0)
  return { areas, total, done, pending: total - done }
}

function bar(done, total, width = 24) {
  if (total === 0) return '─'.repeat(width)
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pct(done, total) {
  return total === 0 ? '100' : ((done / total) * 100).toFixed(0)
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const topIndex = argv.indexOf('--top')
  const top = topIndex === -1 ? 15 : Number(argv[topIndex + 1] ?? 15)
  const areaIndex = argv.indexOf('--area')
  const onlyArea = areaIndex === -1 ? null : argv[areaIndex + 1]

  const report = measure()
  const areas = onlyArea ? report.areas.filter((a) => a.name === onlyArea) : report.areas

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          total: report.total,
          done: report.done,
          pending: report.pending,
          areas: areas.map((a) => ({
            name: a.name,
            total: a.total,
            done: a.done,
            pending: a.pending,
            linesPending: a.linesPending,
            files: a.files.slice(0, top).map((f) => ({ path: f.path, lines: f.lines })),
          })),
        },
        null,
        2
      )
    )
    return
  }

  console.log('')
  console.log(`  Effect en el proyecto — ${report.done} de ${report.total} archivos`)
  console.log('')
  for (const area of areas) {
    const label = area.name.padEnd(11)
    const counts = `${String(area.done).padStart(3)}/${String(area.total).padEnd(3)}`
    console.log(
      `  ${label} ${bar(area.done, area.total)}  ${counts}  ${pct(area.done, area.total).padStart(3)}%` +
        (area.pending > 0 ? `   faltan ${area.linesPending.toLocaleString('es')} líneas` : '')
    )
  }
  console.log('')
  console.log(`  total       ${bar(report.done, report.total)}  ${pct(report.done, report.total)}%`)

  const pendingFiles = areas.flatMap((a) => a.files).toSorted((x, y) => y.lines - x.lines)
  console.log('')
  if (pendingFiles.length > 0) {
    console.log(`  Los ${Math.min(top, pendingFiles.length)} más grandes que faltan:`)
    console.log('')
    for (const file of pendingFiles.slice(0, top)) {
      console.log(`    ${String(file.lines).padStart(5)}  ${file.path}`)
    }
  } else {
    console.log('  No queda ningún archivo sin Effect.')
  }
  console.log('')
}

main()
