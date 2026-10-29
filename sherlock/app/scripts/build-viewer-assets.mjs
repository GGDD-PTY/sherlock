#!/usr/bin/env node
// ============================================================================
// ASSETS ESTATICOS DE LOS VISORES DEL VDR
// ============================================================================
// Dos salidas, ambas fuera del bundle de Next y ambas gitignored:
//
//   public/mog/    — build Vite del sidecar `mog-sidecar/` (visor XLSX).
//                    19 MB de JS + 41 MB de WASM: jamas cabe en el presupuesto
//                    de chunk de Next (1.5 MB), por eso es un iframe estatico.
//   public/pdfjs/  — worker, cmaps, fuentes estandar, WASM e ICC de pdfjs-dist.
//                    El worker se sirve por URL para no meterlo al grafo de
//                    webpack ni al presupuesto de chunks.
//
// Se ejecuta en LAS DOS cadenas de build, porque ninguna llama a la otra:
//   - `bun run build` (CI, `next build` local)
//   - `scripts/vercel-build.sh` (deploy manual, ambas ramas)
// y tambien antes del `next dev` que levanta Playwright.
//
// Idempotente: si la salida ya es mas nueva que sus fuentes, no reconstruye.
// `--force` la regenera; `SKIP_MOG_SIDECAR=true` salta solo el sidecar (para
// entornos sin el workspace instalado), y entonces el visor XLSX cae a la
// descarga en vez de romper el build.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PUBLIC_DIR = join(APP_DIR, 'public')
const SIDECAR_DIR = join(APP_DIR, 'mog-sidecar')
const MOG_OUT = join(PUBLIC_DIR, 'mog')
const PDFJS_OUT = join(PUBLIC_DIR, 'pdfjs')

const force = process.argv.includes('--force')
const skipSidecar = process.env.SKIP_MOG_SIDECAR === 'true'

function newestMtime(paths) {
  let newest = 0
  for (const path of paths) {
    if (!existsSync(path)) continue
    newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

function isFresh(output, sources) {
  if (force || !existsSync(output)) return false
  return statSync(output).mtimeMs >= newestMtime(sources)
}

// ===== pdfjs-dist ===========================================================
const require = createRequire(join(APP_DIR, 'package.json'))

function resolvePdfjsDir() {
  // `pdfjs-dist` declara `main: build/pdf.mjs`; dos niveles arriba es la raiz.
  return dirname(dirname(require.resolve('pdfjs-dist')))
}

function buildPdfjsAssets() {
  const pdfjsDir = resolvePdfjsDir()
  const sources = [
    join(pdfjsDir, 'build/pdf.worker.min.mjs'),
    join(pdfjsDir, 'cmaps'),
    join(pdfjsDir, 'standard_fonts'),
    join(pdfjsDir, 'wasm'),
    join(pdfjsDir, 'iccs'),
  ]

  if (isFresh(join(PDFJS_OUT, 'pdf.worker.min.mjs'), sources)) {
    console.log('[viewer-assets] public/pdfjs esta al dia')
    return
  }

  rmSync(PDFJS_OUT, { recursive: true, force: true })
  mkdirSync(PDFJS_OUT, { recursive: true })
  cpSync(join(pdfjsDir, 'build/pdf.worker.min.mjs'), join(PDFJS_OUT, 'pdf.worker.min.mjs'))
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    cpSync(join(pdfjsDir, directory), join(PDFJS_OUT, directory), { recursive: true })
  }
  console.log('[viewer-assets] public/pdfjs regenerado')
}

// ===== sidecar Mog ==========================================================
function buildMogSidecar() {
  if (skipSidecar) {
    console.warn('[viewer-assets] SKIP_MOG_SIDECAR=true — el visor XLSX quedara sin sidecar')
    return
  }

  const sources = [
    join(SIDECAR_DIR, 'index.html'),
    join(SIDECAR_DIR, 'package.json'),
    join(SIDECAR_DIR, 'vite.config.js'),
    join(SIDECAR_DIR, 'src'),
  ]

  // El manifiesto de prefetch entra en la prueba de frescura: un `public/mog`
  // de antes de que existiera es un build viejo aunque su index.html sea nuevo.
  if (
    isFresh(join(MOG_OUT, 'index.html'), sources) &&
    existsSync(join(MOG_OUT, 'assets-manifest.json'))
  ) {
    console.log('[viewer-assets] public/mog esta al dia')
    return
  }

  const result = spawnSync('bunx', ['vite', 'build'], {
    cwd: SIDECAR_DIR,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error('El build del sidecar Mog fallo')
  }

  // Guarda del deploy: sin `index.html` el iframe sirve el 404 de Next y el
  // runtime de Mog revienta con "expected magic word 00 61 73 6d" al bajar el
  // HTML en vez del WASM (LESSONS 2026-08-23).
  if (!existsSync(join(MOG_OUT, 'index.html'))) {
    throw new Error('public/mog/index.html no se genero')
  }
  // Sin manifiesto la sala no puede calentar la cache del sidecar y la primera
  // apertura vuelve a pagar los 18 MB al pulsar "Abrir" (vite.config.js).
  if (!existsSync(join(MOG_OUT, 'assets-manifest.json'))) {
    throw new Error('public/mog/assets-manifest.json no se genero')
  }
  console.log('[viewer-assets] public/mog regenerado')
}

buildPdfjsAssets()
buildMogSidecar()
