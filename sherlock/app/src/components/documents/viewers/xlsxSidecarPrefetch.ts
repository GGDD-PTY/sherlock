// ============================================================================
// PREFETCH DEL SIDECAR MOG
// ============================================================================
// El visor XLSX es un iframe estatico (`/mog/`) cuyo runtime pesa 15 MB de WASM
// comprimido, 2,2 MB de JS y 1,3 MB de fuentes, todos inmutables por hash. Sin
// esto, la primera apertura de un libro empieza a bajarlos al pulsar "Abrir":
// 9,6 s a 20 Mbps, contra 1,6 s con la cache caliente (hillclimb 2026-09-03).
//
// La sala llama a `prefetchXlsxSidecar()` en cuanto lista una hoja de calculo.
// El helper lee el manifiesto que emite el build de Vite del sidecar
// (`mog-sidecar/vite.config.js`) y cuelga un `<link rel="prefetch">` por asset:
// el navegador los baja con la prioridad mas baja, sin competir con la sala, y
// cuando el iframe los pida salen de la cache HTTP.
//
// Fail-open: sin manifiesto (build viejo, 404) no pasa nada y el visor sigue
// funcionando como antes, solo mas lento.
// ============================================================================

import { Effect, Option, Schema } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'

import { describeCause } from '@/lib/effect/errors'

export const MOG_ASSET_MANIFEST_URL = '/mog/assets-manifest.json'

/** Unico prefijo aceptado: el manifiesto no puede mandar a la sala a otro sitio. */
const MOG_ASSET_PREFIX = '/mog/assets/'

/** Las fuentes las pide el CSS del sidecar en modo CORS anonimo; el prefetch
 * tiene que coincidir o la cache no las reutiliza. */
const FONT_FILE = /\.(ttf|otf|woff2?)$/

let started = false

type NetworkInformation = { saveData?: boolean }

/**
 * La FORMA del manifiesto, no su contenido. Las entradas se declaran
 * `Unknown` a proposito: un manifiesto con una entrada rara (un numero, una
 * URL de otro origen) no puede tirar las buenas, porque entonces un build a
 * medias apagaria el prefetch entero en vez de saltarse la linea mala. Cada
 * entrada la juzga `isSidecarAsset`, que es la frontera de seguridad.
 */
const AssetManifest = Schema.Struct({
  prefetch: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

const decodeManifest = Schema.decodeUnknownOption(AssetManifest)

class SidecarManifestError extends Schema.TaggedError<SidecarManifestError>()(
  'SidecarManifestError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

function manifestUnreachable(cause: unknown): SidecarManifestError {
  return new SidecarManifestError({
    message: describeCause(cause),
    cause,
  })
}

/** Un href del sidecar y nada mas: mismo origen, bajo `/mog/assets/`, sin `..`. */
function isSidecarAsset(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith(MOG_ASSET_PREFIX) && !href.includes('..')
}

function manifestHrefs(manifest: unknown): readonly string[] {
  const decoded = Option.getOrUndefined(decodeManifest(manifest))
  return (decoded?.prefetch ?? []).filter(isSidecarAsset)
}

const readManifest = Effect.fn('XlsxSidecar.readManifest')(function* (): Effect.fn.Return<
  readonly string[],
  SidecarManifestError
> {
  const response = yield* Effect.tryPromise({
    try: () => fetch(MOG_ASSET_MANIFEST_URL, { credentials: 'same-origin' }),
    catch: manifestUnreachable,
  })

  // Un build sin manifiesto no es un fallo: es una sala mas lenta.
  if (!response.ok) return []

  const manifest = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: manifestUnreachable,
  })

  return manifestHrefs(manifest)
})

const warmSidecarCache = Effect.fn('XlsxSidecar.prefetch')(function* (): Effect.fn.Return<void> {
  const hrefs = yield* readManifest().pipe(
    // Fail-open con el fallo nombrado: la sala no se entera, pero el span sí.
    Effect.catch(() => Effect.succeed<readonly string[]>([]))
  )

  yield* Effect.sync(() => {
    for (const href of hrefs) {
      const link = document.createElement('link')
      link.rel = 'prefetch'
      link.href = href
      if (FONT_FILE.test(href)) link.crossOrigin = 'anonymous'
      document.head.append(link)
    }
  })
})

export function prefetchXlsxSidecar(): void {
  if (started || typeof document === 'undefined') return
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection
  if (connection?.saveData) return
  started = true

  runClientFork(warmSidecarCache())
}

/** Solo para pruebas: olvida que el prefetch ya se pidio. */
export function resetXlsxSidecarPrefetchForTests(): void {
  started = false
}
