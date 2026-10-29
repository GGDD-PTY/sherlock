import { Effect } from 'effect'
import type { NextRequest } from 'next/server'

import { rejectNonExactSameOrigin } from '@/lib/api/exact-same-origin'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireApiAuthWithRole } from '@/lib/api/with-auth'
import { parseRoomJourneyJson } from '@/lib/analytics/room-journey-contract'
import {
  roomJourneyAnalyticsEnabled,
  roomJourneyRateLimitKey,
  roomJourneyRequestOptsOut,
  scheduleRoomJourneyEvent,
} from '@/lib/analytics/room-journey-server'
import { checkRateLimitDistributed, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'

const ROUTE = '/api/analytics/journey'

function rateLimited(requestId: string, retryAfterSec: number): Response {
  const response = apiError(requestId, 429, {
    error: 'Demasiadas solicitudes',
    code: 'RATE_LIMITED',
    retryAfter: retryAfterSec,
  })
  response.headers.set('Retry-After', String(retryAfterSec))
  return response
}

const postJourney = Effect.fn('RoomJourney.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (rejectNonExactSameOrigin(request)) {
    return yield* respond(
      apiError(requestId, 403, { error: 'Origen no permitido', code: 'ORIGIN_DENIED' })
    )
  }

  const auth = yield* routePromise('auth.requireCompanyOrAdmin', () =>
    requireApiAuthWithRole(['COMPANY', 'ADMIN'])
  )
  if (auth.error) return yield* respond(withRequestIdHeader(auth.error, requestId))
  if (auth.user.role !== 'COMPANY' && auth.user.role !== 'ADMIN') {
    return yield* respond(apiError(requestId, 403, { error: 'No autorizado', code: 'ROLE_DENIED' }))
  }

  const parsed = yield* routePromise('RoomJourney.parse', () => parseRoomJourneyJson(request))
  if (!parsed.ok) {
    return yield* respond(
      apiError(requestId, parsed.status, {
        error: 'Solicitud inválida',
        code: parsed.code,
      })
    )
  }

  if (roomJourneyRequestOptsOut(request.headers) || !roomJourneyAnalyticsEnabled()) {
    return apiSuccess({ scheduled: false }, requestId, { status: 202 })
  }

  const rateLimit = yield* routePromise('RoomJourney.rateLimit', () =>
    checkRateLimitDistributed(roomJourneyRateLimitKey(auth.user.id), RATE_LIMIT_PRESETS.api)
  )
  if (!rateLimit.success) {
    return yield* respond(rateLimited(requestId, rateLimit.retryAfterSec))
  }

  const scheduled = scheduleRoomJourneyEvent({
    actorId: auth.user.id,
    actorRole: auth.user.role,
    journeyEvent: parsed.data,
    requestHeaders: request.headers,
  })

  // The event is queued after the response. This does not claim provider delivery.
  return apiSuccess({ scheduled }, requestId, { status: 202 })
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, postJourney(request, requestId), { requestId })
}

const methodNotAllowed = (_request: NextRequest, requestId: string) =>
  Effect.succeed(
    apiError(requestId, 405, {
      error: 'Método no permitido',
      code: 'METHOD_NOT_ALLOWED',
      route: ROUTE,
    })
  )

export function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, methodNotAllowed(request, requestId), { requestId })
}
