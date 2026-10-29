#!/usr/bin/env tsx
// ============================================================================
// LÍNEA BASE DE RENDIMIENTO POR SUPERFICIE
// ============================================================================
// `bun run perf:baseline [--origin https://app.example.com]`
//
// Sobre un `.next` ya construido (`bun run build`) calcula el first-load JS de
// seis superficies y lo compara contra un presupuesto gzip. `perf:audit` y
// `bundle:size` miden el bundle entero o el chunk más grande; este script mide
// lo que baja CADA superficie.
//
// Cómo se mide (Next 16 con webpack, sin `app-build-manifest.json`):
//   - Superficies de ruta: el bundle de servidor de la ruta
//     (`.next/server/app/<ruta>/page.js` más los `chunks/*.js` que lista su
//     `page.js.nft.json`) nombra, como string literal, cada frontera de cliente
//     que puede renderizar. Esas fronteras se cruzan con `clientModules` del
//     `page_client-reference-manifest.js` de la ruta, que trae los chunks de
//     cada una, y se suman con `rootMainFiles` de `build-manifest.json`.
//     Validado el 2026-09-06 contra el HTML real de `next start`: mismos
//     chunks que los `<script>` de `/es`, salvo `polyfills-*.js`, que va con
//     `nomodule` y un navegador moderno no lo ejecuta — queda fuera a propósito.
//   - Visor PDF: los chunks diferidos del `import('pdfjs-dist')` de
//     `PdfViewer.tsx`, tomados de `react-loadable-manifest.json`. El worker
//     (`public/pdfjs/pdf.worker.min.mjs`) se sirve por URL y se lista aparte.
//   - Visor XLSX: el sidecar Mog es un iframe estático (`public/mog/`). Se mide
//     el JS + CSS que declara su `assets-manifest.json`; el WASM y las fuentes
//     se listan aparte porque no son JS.
//   Bytes crudos y gzip (`zlib.gzipSync`, nivel 9, el mismo que usa Next para
//   sus tamaños).
//
// Presupuesto por superficie (gzip, advisory: excederlo avisa y sale con 0):
//   landing 290 KB · sign-in 300 KB · sala cliente 450 KB · sala admin 500 KB
//   visor PDF 400 KB · visor XLSX 2400 KB (landing, sign-in y XLSX son guardias,
//   no metas)
//
// `--origin <url>` además hace `fetch` 3 veces a `/es`, `/es/sign-in` y
// `/api/health` (sin seguir redirects) y reporta status, TTFB mediana y
// `cache-control`.
//
// Salida: tabla Markdown en stdout y recibo JSON en
// `~/Developer/sherlock-handoffs/perf-baselines/perf-baseline-<sha>-<UTC>.json`
// (fuera del repo). Si hay un recibo anterior, imprime la delta por superficie.
// ============================================================================

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

import { Duration, Effect, Schema } from 'effect'

import { decodeBoundary, externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const KB = 1024
const GZIP_LEVEL = 9

export const BUDGETS = {
  // Línea base medida: 282 KB gzip el 2026-09-06 (recibo
  // `perf-baseline-4453dbdb9-2026-09-07T00-49-11-612Z.json`). [F] 2026-09-07
  // 01:04: el refactor del shell público no se hace ahora porque la landing ya
  // se siente rápida; los 290 KB guardan contra una regresión, no son meta.
  landing: 290 * KB,
  // Sign-in en prod es un 307 a AuthKit: el número mide el layout que Next
  // serviría; guarda contra regresiones, no es una meta.
  signIn: 300 * KB,
  companyRoom: 450 * KB,
  adminRoom: 500 * KB,
  pdfViewer: 400 * KB,
  // El sidecar Mog pesa 2.2 MB gzip por diseño (iframe estático): el techo es
  // guardia de regresión, no meta de recorte ([F] 2026-09-06).
  xlsxViewer: 2400 * KB,
} as const

export type SurfaceId = keyof typeof BUDGETS

type RouteSurface = {
  id: SurfaceId
  label: string
  /** Clave de la ruta en los manifests de Next (`/[locale]/page`). */
  route: string
  /** Ruta pública que la representa. */
  url: string
}

const ROUTE_SURFACES: readonly RouteSurface[] = [
  // Las rutas públicas viven en el grupo `(public)` desde la tarjeta O2-06;
  // el grupo no cambia la URL pero sí la clave de los manifests de Next.
  { id: 'landing', label: 'Landing', route: '/[locale]/(public)/page', url: '/es' },
  {
    id: 'signIn',
    label: 'Sign-in',
    route: '/[locale]/(public)/sign-in/[[...sign-in]]/page',
    url: '/es/sign-in',
  },
  {
    id: 'companyRoom',
    label: 'Sala cliente',
    route: '/[locale]/(app)/my-company/documents/page',
    url: '/es/my-company/documents',
  },
  {
    id: 'adminRoom',
    label: 'Sala admin',
    route: '/[locale]/(app)/admin/companies/[id]/documents/page',
    url: '/es/admin/companies/[id]/documents',
  },
]

const PDF_VIEWER_LOADABLE_KEY = /components\/documents\/viewers\/PdfViewer\.tsx -> pdfjs-dist$/
const PDF_WORKER_PUBLIC_PATH = 'pdfjs/pdf.worker.min.mjs'
const MOG_ASSET_MANIFEST_PUBLIC_PATH = 'mog/assets-manifest.json'

const ORIGIN_ROUTES = ['/es', '/es/sign-in', '/api/health'] as const
const ORIGIN_SAMPLES = 3

const RECEIPT_DIR = join(homedir(), 'Developer', 'sherlock-handoffs', 'perf-baselines')

// ============================================================================
// TIPOS
// ============================================================================

// Los cuatro manifests los emite el build (Next, webpack, Vite), no este
// repo: se decodifican con `Schema` en vez de castearse con `as`, y toleran
// las claves de más que cada herramienta agrega entre versiones.
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

const ClientModuleSchema = Schema.StructWithRest(
  Schema.Struct({ chunks: Schema.optionalKey(Schema.Array(Schema.String)) }),
  [JsonRecordSchema]
)

const ClientReferenceManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    clientModules: Schema.optionalKey(Schema.Record(Schema.String, ClientModuleSchema)),
  }),
  [JsonRecordSchema]
)

export type ClientReferenceManifest = {
  clientModules: Record<string, typeof ClientModuleSchema.Type>
}

const BuildManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    rootMainFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    polyfillFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [JsonRecordSchema]
)

export type BuildManifest = typeof BuildManifestSchema.Type

const ReactLoadableManifestSchema = Schema.Record(
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) }), [
    JsonRecordSchema,
  ])
)

export type ReactLoadableManifest = typeof ReactLoadableManifestSchema.Type

const MogAssetManifestSchema = Schema.StructWithRest(
  Schema.Struct({ prefetch: Schema.optionalKey(Schema.Array(Schema.String)) }),
  [JsonRecordSchema]
)

export type MogAssetManifest = typeof MogAssetManifestSchema.Type

const NftManifestSchema = Schema.StructWithRest(
  Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) }),
  [JsonRecordSchema]
)

// Del recibo anterior solo se lee la delta: se decodifica lo que se usa y el
// resto pasa sin estorbar, así que un recibo viejo con otra forma no rompe.
const PreviousReceiptSchema = Schema.StructWithRest(
  Schema.Struct({
    sha: Schema.String,
    generatedAt: Schema.String,
    surfaces: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ id: Schema.String, gzipBytes: Schema.Finite }), [
        JsonRecordSchema,
      ])
    ),
  }),
  [JsonRecordSchema]
)

type PreviousReceipt = typeof PreviousReceiptSchema.Type

export type SurfaceMeasurement = {
  id: SurfaceId
  label: string
  source: string
  files: string[]
  rawBytes: number
  gzipBytes: number
  budgetGzipBytes: number
  overBudget: boolean
  /** Bytes que la superficie también baja pero que no son JS (worker, WASM, fuentes). */
  notes: string[]
}

export type OriginSample = {
  path: string
  status: number | null
  cacheControl: string | null
  ttfbMsSamples: number[]
  ttfbMsMedian: number | null
  error?: string
}

export type Receipt = {
  version: 1
  sha: string
  buildId: string
  generatedAt: string
  gzipLevel: number
  surfaces: SurfaceMeasurement[]
  origin: { origin: string; routes: OriginSample[] } | null
}

// ============================================================================
// FUNCIONES PURAS (las prueba `src/__tests__/scripts/perf-baseline.test.ts`)
// ============================================================================

/**
 * Extrae el manifest de referencias de cliente de una ruta a partir del texto
 * del `page_client-reference-manifest.js`. Next escribe el objeto con
 * `JSON.stringify`, así que basta con recortar la asignación y parsearla: no
 * hace falta ejecutar el archivo.
 */
export function parseClientReferenceManifest(
  source: string,
  route: string
): ClientReferenceManifest {
  const marker = `globalThis.__RSC_MANIFEST[${JSON.stringify(route)}]=`
  const start = source.indexOf(marker)
  if (start === -1) {
    throw new Error(`El manifest de cliente no trae la ruta ${route}`)
  }
  const body = source.slice(start + marker.length).replace(/;?\s*$/, '')
  const parsed = Effect.runSync(
    decodeBoundary('nextClientReferenceManifest', ClientReferenceManifestSchema, JSON.parse(body))
  )
  return { clientModules: parsed.clientModules ?? {} }
}

/**
 * Fronteras de cliente que el bundle de servidor de la ruta puede renderizar:
 * cada clave de `clientModules` que aparece como string literal en ese código.
 * Ordenadas, para que el recibo sea determinista.
 */
export function findRenderedBoundaries(
  serverSources: readonly string[],
  manifest: ClientReferenceManifest
): string[] {
  const text = serverSources.join('\n')
  return Object.keys(manifest.clientModules)
    .filter((key) => text.includes(JSON.stringify(key.split('#')[0] ?? key)))
    .sort()
}

/**
 * First-load JS de una ruta: `rootMainFiles` (runtime compartido) más los
 * chunks de cada frontera renderizada. Devuelve rutas relativas a `.next`,
 * únicas, con el nombre decodificado (`%5Blocale%5D` → `[locale]`).
 */
export function collectRouteChunks(input: {
  serverSources: readonly string[]
  manifest: ClientReferenceManifest
  rootMainFiles: readonly string[]
}): { boundaries: string[]; files: string[] } {
  const boundaries = findRenderedBoundaries(input.serverSources, input.manifest)
  const files = new Set<string>()
  for (const file of input.rootMainFiles) {
    if (file.endsWith('.js')) files.add(decodeURIComponent(file))
  }
  for (const boundary of boundaries) {
    for (const chunk of input.manifest.clientModules[boundary]?.chunks ?? []) {
      // `chunks` alterna id y archivo: solo cuentan los archivos.
      if (chunk.endsWith('.js')) files.add(decodeURIComponent(chunk))
    }
  }
  return { boundaries, files: [...files].sort() }
}

/** Suma bytes crudos y gzip de una lista de archivos con un lector inyectable. */
export function sumChunkSizes(
  files: readonly string[],
  read: (file: string) => Buffer
): { rawBytes: number; gzipBytes: number } {
  let rawBytes = 0
  let gzipBytes = 0
  for (const file of files) {
    const buffer = read(file)
    rawBytes += buffer.length
    gzipBytes += gzipSync(buffer, { level: GZIP_LEVEL }).length
  }
  return { rawBytes, gzipBytes }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

export function formatKb(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} KB`
}

function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return '—'
  const delta = current - previous
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  return `${sign}${(Math.abs(delta) / KB).toFixed(1)} KB`
}

// ============================================================================
// LECTURA DEL BUILD
// ============================================================================

const APP_DIR = dirname(dirname(new URL(import.meta.url).pathname))
const NEXT_DIR = join(APP_DIR, '.next')
const PUBLIC_DIR = join(APP_DIR, 'public')
// Techo de descriptores abiertos al leer los chunks de servidor de una ruta.
const READ_CONCURRENCY = 16
// Un origen que no contesta en 20 s no aporta un TTFB; el número original.
const ORIGIN_TIMEOUT = Duration.seconds(20)
const GIT_TIMEOUT = Duration.seconds(10)

class PerfBaselineError extends Schema.TaggedError<PerfBaselineError>()('PerfBaselineError', {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function perfError(message: string, cause?: unknown): PerfBaselineError {
  return new PerfBaselineError({ message, ...(cause === undefined ? {} : { cause }) })
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Lee un manifest del build y lo decodifica; nada entra por `as`. */
function readManifest<S extends Schema.Top>(
  boundary: string,
  schema: S,
  file: string
): Effect.Effect<S['Type'], PerfBaselineError, S['DecodingServices']> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(file, 'utf8'),
      catch: (cause) => perfError(`No se pudo leer ${file}`, cause),
    })
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => perfError(`${file} no es JSON`, cause),
    })
    return yield* decodeBoundary(boundary, schema, parsed).pipe(
      Effect.mapError((cause) => perfError(`${file}: ${cause.message}`, cause))
    )
  })
}

const pathExists = Effect.fn('perfBaseline.pathExists')(function* (
  path: string
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise(() => stat(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
})

const readText = Effect.fn('perfBaseline.readText')(function* (
  file: string
): Effect.fn.Return<string, PerfBaselineError> {
  return yield* Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: (cause) => perfError(`No se pudo leer ${file}`, cause),
  })
})

function routeDir(route: string): string {
  return join(NEXT_DIR, 'server', 'app', route.replace(/\/page$/, ''))
}

/** `page.js` de la ruta más los chunks de servidor que su `.nft.json` declara. */
const readServerSources = Effect.fn('perfBaseline.readServerSources')(function* (
  route: string
): Effect.fn.Return<string[], PerfBaselineError> {
  const dir = routeDir(route)
  const page = join(dir, 'page.js')
  if (!(yield* pathExists(page))) {
    return yield* Effect.fail(
      perfError(
        `No existe ${page}: la ruta ${route} ya no está en el build. Actualiza ROUTE_SURFACES.`
      )
    )
  }
  const pageSource = yield* readText(page)
  const nft = yield* readManifest('nextNftManifest', NftManifestSchema, `${page}.nft.json`)
  const chunkFiles = (nft.files ?? []).filter(
    (file) => /(^|\/)chunks\/[^/]+\.js$/.test(file) && !file.includes('node_modules')
  )
  const chunkSources = yield* Effect.forEach(chunkFiles, (file) => readText(resolve(dir, file)), {
    concurrency: READ_CONCURRENCY,
  })
  return [pageSource, ...chunkSources]
})

// `sumChunkSizes` recibe un lector síncrono: es la función pura que prueba
// `perf-baseline.test.ts` con un lector inyectado, y su contrato no cambia.
function readNextFile(file: string): Buffer {
  return readFileSync(join(NEXT_DIR, file))
}

function readPublicFile(file: string): Buffer {
  return readFileSync(join(PUBLIC_DIR, file))
}

const fileSizeNote = Effect.fn('perfBaseline.fileSizeNote')(function* (
  label: string,
  absolutePath: string
): Effect.fn.Return<string | null> {
  return yield* Effect.tryPromise(() => stat(absolutePath)).pipe(
    Effect.map((stats) => `${label}: ${formatKb(stats.size)} crudo`),
    Effect.orElseSucceed(() => null)
  )
})

const measureRouteSurface = Effect.fn('perfBaseline.measureRouteSurface')(function* (
  surface: RouteSurface,
  buildManifest: BuildManifest
): Effect.fn.Return<SurfaceMeasurement, PerfBaselineError> {
  const manifestFile = join(routeDir(surface.route), 'page_client-reference-manifest.js')
  if (!(yield* pathExists(manifestFile))) {
    return yield* Effect.fail(
      perfError(`No existe ${manifestFile}: la ruta ${surface.route} no tiene manifest.`)
    )
  }
  const manifest = parseClientReferenceManifest(yield* readText(manifestFile), surface.route)
  const { boundaries, files } = collectRouteChunks({
    serverSources: yield* readServerSources(surface.route),
    manifest,
    rootMainFiles: buildManifest.rootMainFiles ?? [],
  })
  const sizes = sumChunkSizes(files, readNextFile)
  const budget = BUDGETS[surface.id]
  return {
    id: surface.id,
    label: surface.label,
    source: surface.url,
    files,
    ...sizes,
    budgetGzipBytes: budget,
    overBudget: sizes.gzipBytes > budget,
    notes: [`${boundaries.length} fronteras de cliente`],
  }
})

const measurePdfViewer = Effect.fn('perfBaseline.measurePdfViewer')(function* (
  loadable: ReactLoadableManifest
): Effect.fn.Return<SurfaceMeasurement, PerfBaselineError> {
  const entry = Object.entries(loadable).find(([key]) => PDF_VIEWER_LOADABLE_KEY.test(key))
  if (!entry) {
    return yield* Effect.fail(
      perfError(
        'react-loadable-manifest.json no trae el import diferido de pdfjs-dist en PdfViewer.tsx.'
      )
    )
  }
  const files = [...new Set(entry[1].files ?? [])].sort()
  const sizes = sumChunkSizes(files, readNextFile)
  const notes = ["chunks diferidos de `import('pdfjs-dist')`"]
  const worker = yield* fileSizeNote(
    'worker por URL (no JS del bundle)',
    join(PUBLIC_DIR, PDF_WORKER_PUBLIC_PATH)
  )
  if (worker) notes.push(worker)
  return {
    id: 'pdfViewer',
    label: 'Visor PDF',
    source: 'PdfViewer.tsx → pdfjs-dist',
    files,
    ...sizes,
    budgetGzipBytes: BUDGETS.pdfViewer,
    overBudget: sizes.gzipBytes > BUDGETS.pdfViewer,
    notes,
  }
})

const measureXlsxViewer = Effect.fn('perfBaseline.measureXlsxViewer')(
  function* (): Effect.fn.Return<SurfaceMeasurement, PerfBaselineError> {
    const manifestFile = join(PUBLIC_DIR, MOG_ASSET_MANIFEST_PUBLIC_PATH)
    const base = {
      id: 'xlsxViewer' as const,
      label: 'Visor XLSX',
      source: 'sidecar Mog (public/mog)',
      budgetGzipBytes: BUDGETS.xlsxViewer,
    }
    if (!(yield* pathExists(manifestFile))) {
      return {
        ...base,
        files: [],
        rawBytes: 0,
        gzipBytes: 0,
        overBudget: false,
        notes: ['sin sidecar en este build (SKIP_MOG_SIDECAR): el visor cae a descarga'],
      }
    }
    const manifest = yield* readManifest('mogAssetManifest', MogAssetManifestSchema, manifestFile)
    const assets = (manifest.prefetch ?? []).filter((href) => href.startsWith('/mog/assets/'))
    const files = assets.filter((href) => /\.(js|css)$/.test(href)).map((href) => href.slice(1))
    const sizes = sumChunkSizes(files, readPublicFile)
    const notes = ['JS + CSS que carga el iframe; el motor no es JS']
    let wasmBytes = 0
    let fontBytes = 0
    const assetSizes = yield* Effect.forEach(
      assets,
      (href) =>
        Effect.tryPromise(() => stat(join(PUBLIC_DIR, href.slice(1)))).pipe(
          Effect.map((stats) => ({ href, size: stats.size })),
          Effect.orElseSucceed(() => null)
        ),
      { concurrency: READ_CONCURRENCY }
    )
    for (const asset of assetSizes) {
      if (asset === null) continue
      if (asset.href.endsWith('.wasm')) wasmBytes += asset.size
      else if (/\.(ttf|otf|woff2?)$/.test(asset.href)) fontBytes += asset.size
    }
    notes.push(`WASM ${formatKb(wasmBytes)} crudo · fuentes ${formatKb(fontBytes)} crudo`)
    return {
      ...base,
      files,
      ...sizes,
      overBudget: sizes.gzipBytes > BUDGETS.xlsxViewer,
      notes,
    }
  }
)

// ============================================================================
// ORIGEN (TTFB Y CACHE-CONTROL)
// ============================================================================

const sampleOrigin = Effect.fn('perfBaseline.sampleOrigin')(function* (
  origin: string
): Effect.fn.Return<OriginSample[]> {
  // Secuencial a propósito: medir TTFB con las tres rutas compitiendo entre
  // sí mediría la cola de salida, no el origen.
  return yield* Effect.forEach(
    ORIGIN_ROUTES,
    (path) =>
      Effect.gen(function* () {
        const sample: OriginSample = {
          path,
          status: null,
          cacheControl: null,
          ttfbMsSamples: [],
          ttfbMsMedian: null,
        }
        for (let i = 0; i < ORIGIN_SAMPLES; i += 1) {
          const started = performance.now()
          const failure = yield* externalCall({
            service: 'origin',
            operation: path,
            run: (signal) =>
              fetch(new URL(path, origin), {
                redirect: 'manual',
                cache: 'no-store',
                signal,
              }),
            timeout: ORIGIN_TIMEOUT,
            // Una muestra es una muestra: reintentar acá inventaría un TTFB.
            retries: 0,
          }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                // `fetch` resuelve con las cabeceras ya recibidas: eso es el TTFB,
                // y se anota antes de bajar el cuerpo.
                sample.ttfbMsSamples.push(Math.round(performance.now() - started))
                sample.status = response.status
                sample.cacheControl = response.headers.get('cache-control')
              })
            ),
            Effect.flatMap((response) =>
              Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (cause) => describeCause(cause),
              })
            ),
            Effect.match({
              onSuccess: () => null,
              onFailure: (error) => (typeof error === 'string' ? error : error.message),
            })
          )
          if (failure !== null) sample.error = failure
        }
        sample.ttfbMsMedian = median(sample.ttfbMsSamples)
        return sample
      }),
    { concurrency: 1 }
  )
})

// ============================================================================
// RECIBO Y SALIDA
// ============================================================================

const gitSha = Effect.fn('perfBaseline.gitSha')(function* (): Effect.fn.Return<string> {
  return yield* externalCall({
    service: 'git',
    operation: 'rev-parse',
    run: (signal) =>
      new Promise<string>((resolvePromise, reject) => {
        execFile(
          'git',
          ['rev-parse', '--short', 'HEAD'],
          { cwd: APP_DIR, encoding: 'utf8', signal },
          (error, stdout) => {
            if (error) reject(error)
            else resolvePromise(stdout)
          }
        )
      }),
    timeout: GIT_TIMEOUT,
    retries: 0,
  }).pipe(
    Effect.map((stdout) => stdout.trim()),
    Effect.orElseSucceed(() => 'unknown')
  )
})

const previousReceipt = Effect.fn('perfBaseline.previousReceipt')(
  function* (): Effect.fn.Return<PreviousReceipt | null> {
    const names = yield* Effect.tryPromise(() => readdir(RECEIPT_DIR)).pipe(
      Effect.orElseSucceed((): string[] => [])
    )
    const candidates = yield* Effect.forEach(
      names.filter((name) => /^perf-baseline-.*\.json$/.test(name)),
      (name) =>
        Effect.tryPromise(() => stat(join(RECEIPT_DIR, name))).pipe(
          Effect.map((stats) => ({ name, mtime: stats.mtimeMs })),
          Effect.orElseSucceed(() => null)
        ),
      { concurrency: READ_CONCURRENCY }
    )
    const newest = candidates
      .filter((candidate): candidate is { name: string; mtime: number } => candidate !== null)
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!newest) return null
    return yield* readManifest(
      'perfBaselineReceipt',
      PreviousReceiptSchema,
      join(RECEIPT_DIR, newest.name)
    ).pipe(Effect.orElseSucceed(() => null))
  }
)

/** El descriptor se cierra por scope, pase lo que pase con la escritura. */
const writeReceipt = Effect.fn('perfBaseline.writeReceipt')(function* (
  receipt: Receipt
): Effect.fn.Return<string, PerfBaselineError> {
  yield* Effect.tryPromise({
    try: () => mkdir(RECEIPT_DIR, { recursive: true }),
    catch: (cause) => perfError(`No se pudo crear ${RECEIPT_DIR}`, cause),
  })
  const stamp = receipt.generatedAt.replace(/[:.]/g, '-')
  const file = join(RECEIPT_DIR, `perf-baseline-${receipt.sha}-${stamp}.json`)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(file, 'w'),
          catch: (cause) => perfError(`No se pudo abrir ${file}`, cause),
        }),
        (openFile) => Effect.promise(() => openFile.close())
      )
      yield* Effect.tryPromise({
        try: () => handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'),
        catch: (cause) => perfError(`No se pudo escribir ${file}`, cause),
      })
    })
  )
  return file
})

function printTable(receipt: Receipt, previous: PreviousReceipt | null) {
  const previousById = new Map(previous?.surfaces.map((s) => [s.id, s.gzipBytes]) ?? [])
  console.log(`## Línea base de rendimiento — ${receipt.sha} (build ${receipt.buildId})\n`)
  console.log('| Superficie | Origen | Archivos | Crudo | Gzip | Presupuesto | Estado | Δ gzip |')
  console.log('| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |')
  for (const s of receipt.surfaces) {
    console.log(
      `| ${s.label} | ${s.source} | ${s.files.length} | ${formatKb(s.rawBytes)} | ${formatKb(s.gzipBytes)} | ${formatKb(s.budgetGzipBytes)} | ${s.overBudget ? 'EXCEDE' : 'ok'} | ${formatDelta(s.gzipBytes, previousById.get(s.id))} |`
    )
  }
  console.log()
  for (const s of receipt.surfaces) {
    if (s.notes.length > 0) console.log(`- ${s.label}: ${s.notes.join(' · ')}`)
  }
  if (previous) {
    console.log(`\nDelta contra el recibo anterior (${previous.sha}, ${previous.generatedAt}).`)
  }
  if (receipt.origin) {
    console.log(`\n### Origen ${receipt.origin.origin}\n`)
    console.log('| Ruta | Status | TTFB mediana | cache-control |')
    console.log('| --- | ---: | ---: | --- |')
    for (const r of receipt.origin.routes) {
      const ttfb = r.ttfbMsMedian === null ? (r.error ?? 'sin respuesta') : `${r.ttfbMsMedian} ms`
      console.log(`| ${r.path} | ${r.status ?? '—'} | ${ttfb} | ${r.cacheControl ?? '—'} |`)
    }
  }
  const over = receipt.surfaces.filter((s) => s.overBudget)
  console.log()
  for (const s of over) {
    console.log(
      `AVISO: ${s.label} excede su presupuesto (${formatKb(s.gzipBytes)} gzip > ${formatKb(s.budgetGzipBytes)}).`
    )
  }
  if (over.length === 0) console.log('Todas las superficies dentro de presupuesto.')
}

function parseArgs(argv: readonly string[]): { origin: string | null } {
  const index = argv.indexOf('--origin')
  if (index === -1) return { origin: null }
  const origin = argv[index + 1]
  if (!origin || origin.startsWith('--')) {
    throw new Error('--origin necesita una URL, por ejemplo --origin https://app.example.com')
  }
  return { origin: new URL(origin).origin }
}

const main = Effect.fn('perfBaseline.main')(function* (): Effect.fn.Return<
  number,
  PerfBaselineError
> {
  const { origin } = yield* Effect.try({
    try: () => parseArgs(process.argv.slice(2)),
    catch: (cause) => perfError(cause instanceof Error ? cause.message : String(cause), cause),
  })
  const buildIdFile = join(NEXT_DIR, 'BUILD_ID')
  const buildManifestFile = join(NEXT_DIR, 'build-manifest.json')
  if (!(yield* pathExists(buildIdFile)) || !(yield* pathExists(buildManifestFile))) {
    console.error(`No hay build en ${NEXT_DIR}: corre \`bun run build\` primero.`)
    return 1
  }

  const buildManifest = yield* readManifest(
    'nextBuildManifest',
    BuildManifestSchema,
    buildManifestFile
  )
  const loadable = yield* readManifest(
    'nextReactLoadableManifest',
    ReactLoadableManifestSchema,
    join(NEXT_DIR, 'react-loadable-manifest.json')
  )

  const surfaces: SurfaceMeasurement[] = [
    ...(yield* Effect.forEach(ROUTE_SURFACES, (surface) =>
      measureRouteSurface(surface, buildManifest)
    )),
    yield* measurePdfViewer(loadable),
    yield* measureXlsxViewer(),
  ]

  const receipt: Receipt = {
    version: 1,
    sha: yield* gitSha(),
    buildId: (yield* readText(buildIdFile)).trim(),
    generatedAt: new Date().toISOString(),
    gzipLevel: GZIP_LEVEL,
    surfaces,
    origin: origin ? { origin, routes: yield* sampleOrigin(origin) } : null,
  }

  const previous = yield* previousReceipt()
  const file = yield* writeReceipt(receipt)
  printTable(receipt, previous)
  console.log(`\nRecibo: ${file}`)
  return 0
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runServerEffect(
    main().pipe(
      Effect.catchTag('PerfBaselineError', (error) =>
        Effect.sync(() => {
          console.error(error.message)
          return 1
        })
      ),
      // El código de salida se aplica dentro del efecto, como en el resto de
      // los scripts de la ola: `tsx` los compila como CJS y no hay await de
      // nivel superior donde colgar el `.then`.
      Effect.flatMap((code) => Effect.sync(() => process.exit(code)))
    )
  )
}
