#!/usr/bin/env bun

// ============================================================================
// NORTH STAR FITNESS
// ============================================================================
// Gate de deriva de rendering: cuenta fronteras de cliente, rutas
// `force-dynamic` e imports `ssr: false` y los compara contra el registro de
// política. El escaneo es IO puro sobre miles de archivos: va por
// `Effect.forEach` con concurrencia acotada (leer 1200 archivos de a uno era
// tiempo de pared regalado) y los fallos de disco llegan tipados en vez de
// reventar con un stack.
// ============================================================================

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'
import { RENDERING_POLICY_REGISTRY } from '@/lib/runtime/rendering-policy'

const ROOT = process.cwd()
const APP_DIR = join(ROOT, 'src', 'app')
const SRC_DIR = join(ROOT, 'src')
const SOURCE_EXTENSIONS = ['.ts', '.tsx']
// Techo de descriptores abiertos: suficiente para saturar el disco, lejos del
// límite de `ulimit -n`.
const READ_CONCURRENCY = 16

class NorthStarScanError extends Schema.TaggedError<NorthStarScanError>()('NorthStarScanError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type SourceFile = Readonly<{ path: string; content: string }>

function isMissingEntry(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === 'ENOENT'
}

function scanError(path: string, message: string, cause: unknown): NorthStarScanError {
  return new NorthStarScanError({ path, message, cause })
}

/** Archivos fuente bajo `dir`, en el orden en que los entrega el sistema. */
const listFiles = Effect.fn('northStar.listFiles')(function* (
  dir: string
): Effect.fn.Return<string[], NorthStarScanError> {
  const entries = yield* Effect.tryPromise({
    try: () => readdir(dir, { withFileTypes: true }),
    catch: (cause) => scanError(dir, 'No se pudo listar el directorio.', cause),
  }).pipe(
    // Un directorio ausente no es una falla del gate: la política nombra
    // carpetas opcionales (agentes, api/agents) que no siempre existen.
    Effect.catchIf(
      (error) => isMissingEntry(error.cause),
      () => Effect.succeed([])
    )
  )

  const nested = yield* Effect.forEach(
    entries,
    (entry) => {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) return listFiles(fullPath)
      const matches = SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      return Effect.succeed(matches ? [fullPath] : [])
    },
    { concurrency: READ_CONCURRENCY }
  )

  return nested.flat()
})

const readSourceFiles = Effect.fn('northStar.readSourceFiles')(function* (
  files: readonly string[]
): Effect.fn.Return<SourceFile[], NorthStarScanError> {
  return yield* Effect.forEach(
    files,
    (path) =>
      Effect.tryPromise({
        try: () => readFile(path, 'utf8'),
        catch: (cause) => scanError(path, 'No se pudo leer el archivo.', cause),
      }).pipe(Effect.map((content): SourceFile => ({ path, content }))),
    { concurrency: READ_CONCURRENCY }
  )
})

const readTree = Effect.fn('northStar.readTree')(function* (
  dir: string
): Effect.fn.Return<SourceFile[], NorthStarScanError> {
  return yield* readSourceFiles(yield* listFiles(dir))
})

function countPattern(files: readonly SourceFile[], pattern: RegExp): number {
  return files.reduce((count, file) => count + (file.content.match(pattern)?.length ?? 0), 0)
}

function formatResult(label: string, value: number, limit: number) {
  const status = value > limit ? 'FAIL' : 'PASS'
  console.log(`${status.padEnd(4)} ${label}: ${value} / ${limit}`)
}

const fileExists = Effect.fn('northStar.fileExists')(function* (
  path: string
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((stats) => stats.isFile()),
    Effect.orElseSucceed(() => false)
  )
})

const report = Effect.fn('northStar.report')(function* (): Effect.fn.Return<
  boolean,
  NorthStarScanError
> {
  const appFiles = yield* readTree(SRC_DIR)
  const routeFiles = yield* readTree(APP_DIR)
  const shippingAgentFiles = (yield* Effect.forEach(
    [
      join(SRC_DIR, 'components', 'agents'),
      join(SRC_DIR, 'lib', 'api', 'agents'),
      join(APP_DIR, 'api', 'agents'),
    ],
    readTree
  )).flat()

  const clientEntryPoints = appFiles.filter((file) => file.content.includes("'use client'")).length
  const forceDynamicRoutes = countPattern(
    routeFiles,
    /export const dynamic = ['"]force-dynamic['"]/g
  )
  const clientOnlyImports = countPattern(appFiles, /ssr:\s*false/g)

  const unsupportedSurfacedFindings = shippingAgentFiles.flatMap((file) =>
    RENDERING_POLICY_REGISTRY.unsupportedSurfacedAgents
      .filter((agent) => file.content.includes(agent))
      .map((agent) => ({ agent, file: file.path }))
  )

  console.log('North Star Fitness')
  console.log('')

  formatResult(
    'Client entry points',
    clientEntryPoints,
    RENDERING_POLICY_REGISTRY.thresholds.maxClientEntryPoints
  )
  formatResult(
    'force-dynamic routes',
    forceDynamicRoutes,
    RENDERING_POLICY_REGISTRY.thresholds.maxForceDynamicRoutes
  )
  formatResult(
    'ssr:false imports',
    clientOnlyImports,
    RENDERING_POLICY_REGISTRY.thresholds.maxClientOnlyDynamicImports
  )

  if (unsupportedSurfacedFindings.length > 0) {
    console.log('FAIL Unsupported surfaced agents:')
    unsupportedSurfacedFindings.forEach(({ agent, file }) => {
      console.log(`     ${agent} -> ${file.replace(`${ROOT}/`, '')}`)
    })
  }

  const hasFailures =
    clientEntryPoints > RENDERING_POLICY_REGISTRY.thresholds.maxClientEntryPoints ||
    forceDynamicRoutes > RENDERING_POLICY_REGISTRY.thresholds.maxForceDynamicRoutes ||
    clientOnlyImports > RENDERING_POLICY_REGISTRY.thresholds.maxClientOnlyDynamicImports ||
    unsupportedSurfacedFindings.length > 0

  if (yield* fileExists(join(ROOT, 'lighthouse-report.report.html'))) {
    console.log('WARN Tracked report artifact detected: lighthouse-report.report.html')
  }

  console.log('')
  console.log(
    hasFailures
      ? 'North Star fitness failed. Reduce drift before adding more capability.'
      : 'North Star fitness passed.'
  )

  return hasFailures
})

void runServerEffect(
  report().pipe(
    Effect.catchTag('NorthStarScanError', (error) =>
      Effect.sync(() => {
        console.error(`North Star fitness could not run: ${error.path}: ${error.message}`)
        return true
      })
    ),
    // El veredicto sale del proceso desde dentro del efecto: `tsx` compila
    // estos scripts como CJS y no hay await de nivel superior.
    Effect.flatMap((hasFailures) => Effect.sync(() => process.exit(hasFailures ? 1 : 0)))
  )
)
