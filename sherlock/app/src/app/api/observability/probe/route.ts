// POST /api/observability/probe — forzar un 5xx sin sesión de navegador.
// La única forma de saber que la alerta de errores funciona en producción es
// romper algo a propósito. Esta ruta rompe lo MENOS posible: levanta un error
// sintético, lo mete por el mismo `apiError(500)` que ve cualquier handler roto
// y devuelve el requestId para que el operador lo busque en la campanita, en el
// correo y en PostHog.
//
// PUERTAS, EN ORDEN:
//   1. Sin `OBSERVABILITY_PROBE_SECRET` la ruta no existe: 404, igual que una
//      ruta ausente. Un deployment que no la configuró no ofrece superficie.
//   2. Bearer ausente, con otro esquema o que no cuadra: el MISMO 404. Con 401
//      y 403 la respuesta decía gratis que el probe está armado acá, y la
//      comparación por largo decía si el intento se acercó. Quién intentó qué
//      queda en el log del servidor, que es donde el operador lo busca.
//   3. Rate limit por IP antes de comparar el secreto (fuerza bruta) y un tope
//      global después (un secreto filtrado no puede vaciar la cuota de Resend
//      ni llenar PostHog). Los dos salen por el envelope de la API.
//
// El aviso al equipo y su auditoría los escribe Convex desde el mismo camino de
// captura, con `synthetic: true`: la fila de `activityLogs` es el registro de
// que un operador disparó esto.

import { createHash, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect'
import type { NextRequest } from 'next/server'

import { routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, getOrCreateRequestId } from '@/lib/api/response'
import { createLogger } from '@/lib/logger'
import {
  OBSERVABILITY_PROBE_ERROR_NAME,
  OBSERVABILITY_PROBE_ROUTE,
  resolveObservabilityProbeSecret,
} from '@/lib/observability/probe'
import {
  type RateLimitResult,
  checkRateLimitDistributed,
  getClientIp,
} from '@/lib/utils/rate-limit'

const log = createLogger('API:ObservabilityProbe')

// Generoso: sólo frena la fuerza bruta contra el bearer, no al operador.
const PROBE_ATTEMPT_RATE_LIMIT = { limit: 20, windowSec: 60 }
// Estrecho: el probe es un acto deliberado, no un monitor. Aunque el secreto se
// filtrara, esto es lo máximo que puede costar en correos y eventos.
const PROBE_FIRE_RATE_LIMIT = { limit: 5, windowSec: 300 }

function bearerFrom(request: NextRequest): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token || null
}

// Se comparan HASHES, no los secretos: dos digest SHA-256 miden siempre 32
// bytes, así que no hay rama por largo y `timingSafeEqual` nunca tira. Un
// candidato de tres caracteres y uno de cinco mil cuestan lo mismo.
function matchesSecret(candidate: string, secret: string): boolean {
  const provided = createHash('sha256').update(candidate, 'utf8').digest()
  const expected = createHash('sha256').update(secret, 'utf8').digest()
  return timingSafeEqual(provided, expected)
}

function notFound(requestId: string): Response {
  return apiError(requestId, 404, { error: 'No encontrado' })
}

function rateLimited(requestId: string, result: RateLimitResult): Response {
  const response = apiError(requestId, 429, {
    error: 'Demasiadas solicitudes',
    retryAfter: result.retryAfterSec,
  })
  response.headers.set('Retry-After', String(result.retryAfterSec))
  response.headers.set('X-RateLimit-Limit', String(result.remaining + 1))
  response.headers.set('X-RateLimit-Remaining', '0')
  response.headers.set('X-RateLimit-Reset', String(Math.floor(result.resetAt.getTime() / 1000)))
  return response
}

/** Sin handler propio Next contesta 405, y eso también delata que la ruta existe. */
const hideProbe = (requestId: string) => Effect.succeed(notFound(requestId))

export function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, OBSERVABILITY_PROBE_ROUTE, hideProbe(requestId), { requestId })
}

const fireProbe = Effect.fn('ObservabilityProbe.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const secret = resolveObservabilityProbeSecret()
  if (!secret) return notFound(requestId)

  const clientIp = getClientIp(request)
  const attemptLimit = yield* routePromise('ObservabilityProbe.attemptLimit', () =>
    checkRateLimitDistributed(`observability-probe:attempt:${clientIp}`, PROBE_ATTEMPT_RATE_LIMIT)
  )
  if (!attemptLimit.success) return rateLimited(requestId, attemptLimit)

  const bearer = bearerFrom(request)
  if (!bearer || !matchesSecret(bearer, secret)) {
    log.warn('Observability probe rejected a request without a valid bearer', { requestId })
    return notFound(requestId)
  }

  const fireLimit = yield* routePromise('ObservabilityProbe.fireLimit', () =>
    checkRateLimitDistributed('observability-probe:fire', PROBE_FIRE_RATE_LIMIT)
  )
  if (!fireLimit.success) return rateLimited(requestId, fireLimit)

  // El error sintético nace acá y muere acá: nunca sube al boundary de Next,
  // así que ningún otro camino de la app cambia de comportamiento.
  const syntheticError = new Error('Probe sintetico de observabilidad: 5xx forzado')
  syntheticError.name = OBSERVABILITY_PROBE_ERROR_NAME

  log.warn('Observability probe fired a synthetic 5xx', { requestId })

  return apiError(
    requestId,
    500,
    { error: 'Error sintético del probe de observabilidad', synthetic: true },
    { error: syntheticError, route: OBSERVABILITY_PROBE_ROUTE, synthetic: true }
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, OBSERVABILITY_PROBE_ROUTE, fireProbe(request, requestId), {
    requestId,
  })
}
