// ============================================================================
// ADAPTADOR DEL GATEWAY DE ESCANEO
// ============================================================================
// La forma del sobre que devuelve el gateway se declara como schema: llega de
// un servicio externo y antes se leía con un `payload as Record<string,
// unknown>` seguido de tres comprobaciones a mano. Ese casteo era la mentira —
// si el gateway cambiaba el tipo de un campo, el código seguía compilando y el
// fallo aparecía como un `ERROR` sin causa.
//
// Cada motivo de fallo tiene ahora nombre propio en el canal de error del
// programa (`ScanFailure`) en vez de compartir un solo `catch {}` que devolvía
// `{ status: 'ERROR' }` sin decir de qué. El contrato público no cambia: la
// función sigue devolviendo `Promise<FileScanResult>` y nunca lanza.
//
// Este módulo lo consumen ACTIONS de Convex y una ruta Next, nunca una query ni
// una mutation: el `AbortController` con `setTimeout` que acota la llamada al
// gateway vive donde el aislado sí permite timers, y el corte lo hace el
// transporte —no un timer de Effect—, así que la petición se cancela de verdad.
// ============================================================================

import { Effect, Option, Schema, Stream } from 'effect'

import { runConvex } from '../_helpers/effect'

export type FileScanResult =
  | {
      status: 'CLEAN'
      engine: string
      scanId: string
      definitionVersion?: string
      scannedAt: number
    }
  | {
      status: 'INFECTED'
      engine: string
      scanId: string
      definitionVersion?: string
      scannedAt: number
    }
  | { status: 'NOT_CONFIGURED' }
  | { status: 'ERROR' }

export type ScannerEnvironment = {
  [key: string]: string | undefined
  VDR_FILE_SCANNER_URL?: string
  VDR_FILE_SCANNER_TOKEN?: string
  VDR_SCANNER_OPTIONAL?: string
  CONVEX_ENV?: string
}

const SCANNER_TIMEOUT_MS = 60_000
const MAX_SCANNER_RESPONSE_BYTES = 8_192

export function requiresConfiguredScanner(environment: ScannerEnvironment): boolean {
  // Two opt-outs, both explicit; anything else stays fail-closed. `dev` is the
  // local lane. VDR_SCANNER_OPTIONAL='true' is the [F]-owned production switch
  // (decision 2026-08-26): the team is the only uploader today and no scanning
  // gateway exists yet — flip it off before external guests get room access.
  if (environment.VDR_SCANNER_OPTIONAL === 'true') return false
  return environment.CONVEX_ENV !== 'dev'
}

// El sobre acotado que el gateway devuelve. Los techos de largo son parte del
// contrato —evidencia, no prosa— y viajan como checks del schema.
const evidenceString = (maxLength: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength)))

const ScannerEnvelope = Schema.Struct({
  verdict: Schema.Literals(['CLEAN', 'INFECTED']),
  engine: evidenceString(100),
  scanId: evidenceString(200),
  definitionVersion: Schema.optionalKey(evidenceString(100)),
})

const decodeScannerEnvelope = Schema.decodeUnknownOption(ScannerEnvelope)

/**
 * Los motivos por los que una corrida no produce veredicto. Cada uno viaja por
 * el canal de error con su nombre; el borde los colapsa a `ERROR` porque eso es
 * lo que el llamador sabe manejar, pero la causa deja de perderse en un `catch`
 * mudo.
 */
type ScanFailure =
  | { readonly reason: 'MISCONFIGURED' }
  | { readonly reason: 'INSECURE_ENDPOINT' }
  | { readonly reason: 'TRANSPORT' }
  | { readonly reason: 'HTTP_STATUS'; readonly status: number }
  | { readonly reason: 'RESPONSE_SIZE'; readonly bytes: number }
  | { readonly reason: 'MALFORMED_VERDICT' }

const scanFailure = (failure: ScanFailure): Effect.Effect<never, ScanFailure> =>
  Effect.fail(failure)

function parseScannerEndpoint(
  endpoint: string,
  environment: ScannerEnvironment
): Option.Option<URL> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return Option.none()
  }

  const localDevEndpoint =
    environment.CONVEX_ENV === 'dev' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !(localDevEndpoint && url.protocol === 'http:')) {
    return Option.none()
  }

  return Option.some(url)
}

function parseJson(body: string): Option.Option<unknown> {
  try {
    return Option.some(JSON.parse(body) as unknown)
  } catch {
    return Option.none()
  }
}

/** La llamada al gateway, acotada por su propio `AbortController`. Nunca rechaza. */
async function postToScannerGateway(
  url: URL,
  token: string,
  blob: Blob,
  sha256: string
): Promise<Response | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SCANNER_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha256,
      },
      body: blob,
      signal: controller.signal,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Lee el cuerpo por streaming y corta apenas cruza el tope, en vez de
 * bufferizar la respuesta entera antes de medirla (`Stream.limitBytes`, nuevo
 * en `effect@4.0.0-rc.112`, `node_modules/effect/src/Stream.ts:10065`). Un
 * gateway que responde de más ya no gasta la memoria completa antes de que el
 * chequeo de tamaño corra.
 */
function readBoundedResponseBody(response: Response): Effect.Effect<string, ScanFailure> {
  const body = response.body
  if (body === null) return Effect.succeed('')

  return Stream.fromReadableStream<Uint8Array, ScanFailure>({
    evaluate: () => body,
    onError: (): ScanFailure => ({ reason: 'TRANSPORT' }),
  }).pipe(
    Stream.limitBytes(MAX_SCANNER_RESPONSE_BYTES, () =>
      Stream.fail<ScanFailure>({ reason: 'RESPONSE_SIZE', bytes: MAX_SCANNER_RESPONSE_BYTES + 1 })
    ),
    Stream.decodeText,
    Stream.runFold(
      () => '',
      (acc, chunk) => acc + chunk
    )
  )
}

const scanProgram = Effect.fn('DocumentScanner.scan')(function* (
  blob: Blob,
  sha256: string,
  environment: ScannerEnvironment
) {
  const endpoint = environment.VDR_FILE_SCANNER_URL
  const token = environment.VDR_FILE_SCANNER_TOKEN
  if (!endpoint || !token) return yield* scanFailure({ reason: 'MISCONFIGURED' })

  const url = parseScannerEndpoint(endpoint, environment)
  if (Option.isNone(url)) return yield* scanFailure({ reason: 'INSECURE_ENDPOINT' })

  const response = yield* Effect.promise(() => postToScannerGateway(url.value, token, blob, sha256))
  if (!response) return yield* scanFailure({ reason: 'TRANSPORT' })
  if (!response.ok) return yield* scanFailure({ reason: 'HTTP_STATUS', status: response.status })

  const body = yield* readBoundedResponseBody(response)
  if (body.length === 0) return yield* scanFailure({ reason: 'RESPONSE_SIZE', bytes: 0 })

  const envelope = parseJson(body).pipe(Option.flatMap(decodeScannerEnvelope))
  if (Option.isNone(envelope)) return yield* scanFailure({ reason: 'MALFORMED_VERDICT' })

  const { verdict, engine, scanId, definitionVersion } = envelope.value
  return {
    status: verdict,
    engine,
    scanId,
    ...(definitionVersion ? { definitionVersion } : {}),
    scannedAt: Date.now(),
  } satisfies FileScanResult
})

/**
 * Contract for a private scanning gateway (recommended production backing:
 * MetaDefender Core in a controlled VPC; ClamAV can be one baseline engine).
 * The gateway receives raw bytes and returns only a bounded verdict/evidence
 * envelope. No filename, company, person, or access metadata leaves
 * Sherlock through this adapter.
 */
export async function scanFileWithConfiguredGateway(
  blob: Blob,
  sha256: string,
  environment: ScannerEnvironment = process.env
): Promise<FileScanResult> {
  // Sin endpoint NI token el deployment declara que no hay escáner; con uno
  // solo de los dos está mal configurado, y eso sí es un fallo.
  if (!environment.VDR_FILE_SCANNER_URL && !environment.VDR_FILE_SCANNER_TOKEN) {
    return requiresConfiguredScanner(environment)
      ? { status: 'ERROR' }
      : { status: 'NOT_CONFIGURED' }
  }

  return await runConvex(
    scanProgram(blob, sha256, environment).pipe(
      Effect.catch((): Effect.Effect<FileScanResult> => Effect.succeed({ status: 'ERROR' }))
    )
  )
}
