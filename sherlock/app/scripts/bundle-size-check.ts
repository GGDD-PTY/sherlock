#!/usr/bin/env bun
// ============================================================================
// BUNDLE SIZE CHECK
// ============================================================================
// Verifica que el bundle no exceda los límites definidos.
// Se ejecuta como parte del pre-push hook para evitar pushear bundles gigantes.
//
// Límites:
// - Shared Client JS: 600KB (warning), 1MB (error)
// - Largest Deferred Chunk: 1MB (warning), 1.5MB (error)
//
// `build-manifest.json` lo emite Next, no este repo: se decodifica con
// `Schema` en vez de castearse, para que un manifest con otra forma falle acá
// y no más adelante como "0 KB compartidos". El recorrido de `.next/static`
// va por `Effect.forEach` con concurrencia acotada.
// ============================================================================

import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect, Schema } from 'effect'

import { decodeBoundary } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

// ===== CONFIGURACIÓN =====
// NOTE:
// - `totalJS` is informative only because it includes every lazy chunk in the app.
// - The enforceable metrics are:
//   1. shared client/runtime JS loaded on every route
//   2. the single largest deferred chunk users might download on demand
const LIMITS = {
  sharedClientJS: {
    warning: 600 * 1024, // 600KB
    error: 1024 * 1024, // 1MB
  },
  largestDeferredChunk: {
    warning: 1024 * 1024, // 1MB
    error: 1536 * 1024, // 1.5MB
  },
}

const READ_CONCURRENCY = 16

class BundleSizeError extends Schema.TaggedError<BundleSizeError>()('BundleSizeError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const BuildManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    polyfillFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    rootMainFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)

// ===== HELPERS =====
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function bundleError(path: string, message: string, cause: unknown): BundleSizeError {
  return new BundleSizeError({ path, message, cause })
}

/** Suma recursiva de los `.js` de un directorio; un directorio ausente pesa 0. */
const getJSFilesSize = Effect.fn('bundleSize.getJSFilesSize')(function* (
  dir: string
): Effect.fn.Return<number> {
  const entries = yield* Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.orElseSucceed((): Dirent[] => [])
  )

  // La anotación no es decorativa: la rama recursiva vuelve a esta misma
  // función, así que la inferencia del tipo del elemento se muerde la cola y
  // el lint con tipos lo ve como `unknown` en la suma de abajo.
  const sizes: number[] = yield* Effect.forEach(
    entries,
    (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return getJSFilesSize(path)
      if (!entry.name.endsWith('.js')) return Effect.succeed(0)
      return Effect.tryPromise(() => stat(path)).pipe(
        Effect.map((stats) => stats.size),
        Effect.orElseSucceed(() => 0)
      )
    },
    { concurrency: READ_CONCURRENCY }
  )

  return sizes.reduce((total, size) => total + size, 0)
})

const getFileSize = Effect.fn('bundleSize.getFileSize')(function* (
  baseDir: string,
  relativePath: string
): Effect.fn.Return<number, BundleSizeError> {
  const file = join(baseDir, relativePath)
  const stats = yield* Effect.tryPromise({
    try: () => stat(file),
    catch: (cause) => bundleError(file, 'No se pudo medir el archivo del build.', cause),
  })
  return stats.size
})

const readBuildManifest = Effect.fn('bundleSize.readBuildManifest')(function* (file: string) {
  const raw = yield* Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: (cause) => bundleError(file, 'No se pudo leer build-manifest.json.', cause),
  })
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => bundleError(file, 'build-manifest.json no es JSON.', cause),
  })
  return yield* decodeBoundary('nextBuildManifest', BuildManifestSchema, parsed).pipe(
    Effect.mapError((cause) => bundleError(file, cause.message, cause))
  )
})

// ===== MAIN =====
const check = Effect.fn('bundleSize.check')(function* (): Effect.fn.Return<
  number,
  BundleSizeError
> {
  console.log('📦 Bundle Size Check\n')

  const nextDir = join(process.cwd(), '.next')
  const staticDir = join(nextDir, 'static')
  const chunksDir = join(staticDir, 'chunks')
  const buildManifestPath = join(nextDir, 'build-manifest.json')

  // Check if build exists
  const hasBuild = yield* Effect.tryPromise(() => stat(nextDir)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
  if (!hasBuild) {
    console.log('❌ No build found. Run `bun run build` first.\n')
    return 1
  }

  // Calculate sizes
  const totalJS = yield* getJSFilesSize(staticDir)
  const buildManifest = yield* readBuildManifest(buildManifestPath)
  const sharedFiles = Array.from(
    new Set([...(buildManifest.polyfillFiles ?? []), ...(buildManifest.rootMainFiles ?? [])])
  ).filter((file) => file.endsWith('.js'))
  const sharedSizes = yield* Effect.forEach(sharedFiles, (file) => getFileSize(nextDir, file), {
    concurrency: READ_CONCURRENCY,
  })
  const sharedClientJS = sharedSizes.reduce((sum, size) => sum + size, 0)

  const chunkEntries = yield* Effect.tryPromise({
    try: () => readdir(chunksDir, { withFileTypes: true }),
    catch: (cause) => bundleError(chunksDir, 'No se pudo listar los chunks del build.', cause),
  })
  const deferredChunkSizes = (yield* Effect.forEach(
    chunkEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')),
    (entry) => {
      const relativePath = `static/chunks/${entry.name}`
      return getFileSize(nextDir, relativePath).pipe(
        Effect.map((size) => ({
          file: relativePath,
          size,
          shared: sharedFiles.includes(relativePath),
        }))
      )
    },
    { concurrency: READ_CONCURRENCY }
  ))
    .filter((entry) => !entry.shared)
    .sort((a, b) => b.size - a.size)

  const largestDeferredChunk = deferredChunkSizes[0] ?? null

  console.log('📊 Results:')
  console.log(`   Total JS:    ${formatBytes(totalJS)}`)
  console.log(`   Shared JS:   ${formatBytes(sharedClientJS)}`)
  console.log(
    `   Largest Lazy:${largestDeferredChunk ? ` ${formatBytes(largestDeferredChunk.size)}` : ' 0 B'}`
  )
  if (largestDeferredChunk) {
    console.log(`   Lazy File:   ${largestDeferredChunk.file}`)
  }
  console.log('')

  // Check limits
  let hasWarning = false
  let hasError = false

  // Shared Client JS check
  if (sharedClientJS > LIMITS.sharedClientJS.error) {
    console.log(
      `❌ ERROR: Shared JS (${formatBytes(sharedClientJS)}) exceeds ${formatBytes(LIMITS.sharedClientJS.error)}`
    )
    hasError = true
  } else if (sharedClientJS > LIMITS.sharedClientJS.warning) {
    console.log(
      `⚠️  WARNING: Shared JS (${formatBytes(sharedClientJS)}) exceeds ${formatBytes(LIMITS.sharedClientJS.warning)}`
    )
    hasWarning = true
  } else {
    console.log(`✅ Shared JS is within limits`)
  }

  // Largest deferred chunk check
  if (largestDeferredChunk && largestDeferredChunk.size > LIMITS.largestDeferredChunk.error) {
    console.log(
      `❌ ERROR: Largest lazy chunk (${formatBytes(largestDeferredChunk.size)}) exceeds ${formatBytes(LIMITS.largestDeferredChunk.error)}`
    )
    hasError = true
  } else if (
    largestDeferredChunk &&
    largestDeferredChunk.size > LIMITS.largestDeferredChunk.warning
  ) {
    console.log(
      `⚠️  WARNING: Largest lazy chunk (${formatBytes(largestDeferredChunk.size)}) exceeds ${formatBytes(LIMITS.largestDeferredChunk.warning)}`
    )
    hasWarning = true
  } else {
    console.log(`✅ Largest lazy chunk is within limits`)
  }

  // Summary
  console.log('')
  if (hasError) {
    console.log('❌ Bundle size check FAILED. Reduce bundle size before pushing.')
    return 1
  }
  if (hasWarning) {
    console.log('⚠️  Bundle size check passed with warnings. Consider optimizing.')
    return 0
  }
  console.log('✅ Bundle size check passed!')
  return 0
})

void runServerEffect(
  check().pipe(
    Effect.catchTag('BundleSizeError', (error) =>
      Effect.sync(() => {
        console.error(`❌ Bundle size check could not run: ${error.path}: ${error.message}`)
        return 1
      })
    ),
    // El código de salida se aplica dentro del efecto: `tsx` compila estos
    // scripts como CJS y no hay await de nivel superior.
    Effect.flatMap((code) => Effect.sync(() => process.exit(code)))
  )
)
