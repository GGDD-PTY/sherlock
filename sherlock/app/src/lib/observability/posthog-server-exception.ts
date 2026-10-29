// Captura de excepciones del servidor en PostHog. Mismo destino y mismas reglas
// que `lib/analytics/server.ts`: solo producción, host HTTPS validado, sin
// perfil de persona y sin geoip. Nunca viajan headers, cookies, cuerpos ni
// identidades: solo nombre, mensaje, stack, ruta, requestId, locale, status y
// los tags de enrutado (método, routerKind, routeType).
//
// Desde A7 este es también el disparador del SEGUNDO canal: PostHog archiva,
// `reportServerErrorToTeam` despierta a un humano (campanita + correo del
// equipo). Los dos son independientes a propósito — el aviso no está atado al
// gate de producción de PostHog — y el segundo NUNCA se awaitea.

import { DateTime, Effect, Predicate } from 'effect'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { createLogger } from '@/lib/logger'

import { reportServerErrorToTeam } from './server-error-alert'

const log = createLogger('ServerExceptionAnalytics')
const CAPTURE_TIMEOUT_MS = 1_500
const MAX_FRAMES = 20
const MAX_VALUE_LENGTH = 512
const MAX_ROUTE_LENGTH = 512
const MAX_TAG_LENGTH = 32

type RawStackFrame = {
  filename: string
  function: string
  lineno: number
  colno: number
  in_app: boolean
}

export type ServerExceptionInput = {
  error?: unknown
  requestId: string
  status: number
  route?: string
  locale?: string
  method?: string
  routerKind?: string
  routeType?: string
  /** Marca el 5xx que un operador forzó desde `/api/observability/probe`. */
  synthetic?: boolean
}

// `apiError()` y `onRequestError` ven el mismo error cuando un handler reporta
// y luego relanza. El primero que lo captura lo marca aquí y el segundo se
// calla, sin cerrarle la puerta a lo que sí revienta fuera de `apiError()`.
const capturedErrors = new WeakSet<object>()

export function wasServerExceptionCaptured(error: unknown): boolean {
  return Predicate.isObjectOrArray(error) && capturedErrors.has(error)
}

const parsePostHogEventIngestUrl = Effect.fn('ServerException.parsePostHogEventIngestUrl')(
  function* (configuredHost: string) {
    const host = yield* Effect.try({
      try: () => new URL(configuredHost),
      catch: (cause) =>
        new UnexpectedAppError({
          operation: 'serverException.parsePostHogEventIngestUrl',
          message: 'La URL de ingesta de PostHog no es válida.',
          cause,
        }),
    })
    if (
      host.protocol !== 'https:' ||
      host.username !== '' ||
      host.password !== '' ||
      host.search !== '' ||
      host.hash !== ''
    ) {
      return null
    }
    const base = host.toString().endsWith('/') ? host.toString() : `${host.toString()}/`
    return new URL('e/', base).toString()
  }
)

function postHogEventIngestUrl(): string | null {
  const configuredHost = process.env.POSTHOG_INGEST_HOST
  if (!configuredHost) return null

  return Effect.runSync(
    parsePostHogEventIngestUrl(configuredHost).pipe(
      Effect.match({
        onSuccess: (url) => url,
        onFailure: () => null,
      })
    )
  )
}

function toRawFrame(filename: string, name: string | undefined, line: string, column: string) {
  const safeFilename = filename.split('?')[0]?.slice(0, 256) || '<unknown>'
  return {
    filename: safeFilename,
    function: (name ?? '<anonymous>').slice(0, 128),
    lineno: Number(line) || 0,
    colno: Number(column) || 0,
    in_app: !safeFilename.startsWith('node:') && !safeFilename.includes('node_modules'),
  }
}

function rawStackFrames(stack: string | undefined): RawStackFrame[] {
  if (!stack) return []

  const named = /^at (.+?) \((.+):(\d+):(\d+)\)$/
  const anonymous = /^at (.+):(\d+):(\d+)$/
  const frames: RawStackFrame[] = []

  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('at ')) continue

    const withName = named.exec(line)
    if (withName?.[2] && withName[3] && withName[4]) {
      frames.push(toRawFrame(withName[2], withName[1], withName[3], withName[4]))
    } else {
      const withoutName = anonymous.exec(line)
      if (withoutName?.[1] && withoutName[2] && withoutName[3]) {
        frames.push(toRawFrame(withoutName[1], undefined, withoutName[2], withoutName[3]))
      }
    }

    if (frames.length >= MAX_FRAMES) break
  }

  return frames
}

function exceptionEntry(error: unknown, status: number) {
  const stacktrace = {
    type: 'raw' as const,
    frames: error instanceof Error ? rawStackFrames(error.stack) : [],
  }
  const mechanism = { handled: true, type: 'generic' as const }

  if (error instanceof Error) {
    return {
      type: (error.name.trim() || 'Error').slice(0, 128),
      value: error.message.slice(0, MAX_VALUE_LENGTH),
      mechanism,
      stacktrace,
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return { type: 'ServerError', value: error.slice(0, MAX_VALUE_LENGTH), mechanism, stacktrace }
  }
  return { type: 'ServerError', value: `HTTP ${status}`, mechanism, stacktrace }
}

function safeRoute(route: string | undefined): string | undefined {
  const pathname = route?.split('?')[0]?.split('#')[0]?.trim()
  return pathname && pathname.length <= MAX_ROUTE_LENGTH ? pathname : undefined
}

function safeTag(tag: string | undefined): string | undefined {
  const value = tag?.trim()
  return value && value.length <= MAX_TAG_LENGTH ? value : undefined
}

const sendServerException = Effect.fn('ServerException.send')(function* (args: {
  input: ServerExceptionInput
  ingestUrl: string
  locale: 'es' | undefined
  method: string | undefined
  projectKey: string
  route: string | undefined
  routerKind: string | undefined
  routeType: string | undefined
}) {
  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const body = yield* Effect.try({
    try: () =>
      JSON.stringify({
        api_key: args.projectKey,
        event: '$exception',
        timestamp,
        properties: {
          token: args.projectKey,
          distinct_id: 'server',
          $process_person_profile: false,
          $geoip_disable: true,
          $exception_level: 'error',
          $exception_list: [exceptionEntry(args.input.error, args.input.status)],
          requestId: args.input.requestId,
          status: args.input.status,
          ...(args.route ? { route: args.route } : {}),
          ...(args.locale ? { locale: args.locale } : {}),
          ...(args.method ? { method: args.method } : {}),
          ...(args.routerKind ? { routerKind: args.routerKind } : {}),
          ...(args.routeType ? { routeType: args.routeType } : {}),
          ...(args.input.synthetic === true ? { synthetic: true } : {}),
        },
      }),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'serverException.serializeEvent',
        message: 'No se pudo serializar la excepción del servidor.',
        cause,
      }),
  })

  return yield* externalCall({
    service: 'PostHog',
    operation: 'capture.$exception',
    timeout: CAPTURE_TIMEOUT_MS,
    // Exception ingest has no idempotency UUID, so a retry could duplicate it.
    retries: 0,
    run: (signal) =>
      fetch(args.ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        signal,
      }),
  })
})

const captureServerExceptionEffect = Effect.fn('ServerException.capture')(function* (
  input: ServerExceptionInput
) {
  const projectKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const ingestUrl = postHogEventIngestUrl()
  if (process.env.NODE_ENV !== 'production' || !projectKey || !ingestUrl) return false

  const route = safeRoute(input.route)
  const locale = input.locale === 'es' ? input.locale : undefined
  const method = safeTag(input.method)
  const routerKind = safeTag(input.routerKind)
  const routeType = safeTag(input.routeType)

  const outcome = yield* sendServerException({
    input,
    ingestUrl,
    locale,
    method,
    projectKey,
    route,
    routerKind,
    routeType,
  }).pipe(
    Effect.match({
      onSuccess: (response) => ({ ok: true as const, response }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
  if (!outcome.ok) {
    // Nombrado, no tragado: el segundo canal (`reportServerErrorToTeam`) ya
    // avisó a un humano sin depender de esto, pero un fallo silencioso acá
    // deja el archivo de PostHog sin la excepción y sin ninguna pista de por
    // qué. Mismo patrón que `room-journey-server.ts`.
    log.warn('Server exception capture failed', {
      requestId: input.requestId,
      reason: outcome.error._tag,
      message: outcome.error.message,
    })
    return false
  }
  if (!outcome.response.ok) {
    log.warn('Server exception capture failed', {
      requestId: input.requestId,
      reason: 'provider_response',
      status: outcome.response.status,
    })
    return false
  }
  return true
})

/**
 * Manda un `$exception` de servidor a PostHog. Devuelve `false` sin hacer nada
 * si falta la clave, el host de ingesta o si no es producción. Nunca lanza: un
 * fallo de captura no puede romper la respuesta.
 */
export async function captureServerException(input: ServerExceptionInput): Promise<boolean> {
  if (Predicate.isObjectOrArray(input.error)) capturedErrors.add(input.error)

  // SIN await, y antes del gate de producción de PostHog: los dos canales son
  // independientes y este devuelve void para que nadie pueda encadenarlo al
  // camino de la respuesta. Lo fija `server-error-alert-nonblocking.test.ts`.
  reportServerErrorToTeam({
    error: input.error,
    requestId: input.requestId,
    status: input.status,
    route: input.route,
    method: input.method,
    synthetic: input.synthetic,
  })

  return runServerEffect(captureServerExceptionEffect(input))
}
