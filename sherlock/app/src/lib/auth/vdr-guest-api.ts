import { Effect } from 'effect'
import { NextResponse, type NextRequest } from 'next/server'
import { rejectInvalidOrigin } from '@/lib/api/csrf'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'

// Las operaciones de invitado: una sola lista para el core y para el puente,
// para que ninguna entre sin elegir cubo.
type GuestRateLimitOperation =
  'otp-request' | 'otp-verify' | 'session-read' | 'session-rotate' | 'room-read' | 'logout'

export function vdrGuestRequestId(request: NextRequest): string {
  return getOrCreateRequestId(request)
}

export function secureGuestResponse<T extends NextResponse>(response: T, requestId: string): T {
  return withRequestIdHeader(response, requestId)
}

export function rejectGuestCsrf(request: NextRequest, requestId: string): NextResponse | null {
  const rejected = rejectInvalidOrigin(request)
  return rejected ? secureGuestResponse(rejected, requestId) : null
}

const rejectGuestRateLimitEffect = Effect.fn('VdrGuestApi.rateLimit')(function* (
  request: NextRequest,
  requestId: string,
  operation: GuestRateLimitOperation
) {
  const preset =
    operation === 'session-read' || operation === 'room-read'
      ? RATE_LIMIT_PRESETS.api
      : RATE_LIMIT_PRESETS.auth
  const result = yield* Effect.promise(() =>
    checkRateLimitDistributed(`vdr-guest-${operation}:${getClientIp(request)}`, preset)
  )
  return result.success ? null : withRequestIdHeader(createRateLimitResponse(result), requestId)
})

export function rejectGuestRateLimit(
  request: NextRequest,
  requestId: string,
  operation: GuestRateLimitOperation
): Promise<Response | null> {
  return runServerEffect(rejectGuestRateLimitEffect(request, requestId, operation))
}

export function invalidGuestRequest(
  requestId: string,
  status: 400 | 413 | 415,
  code: string
): Response {
  return apiError(requestId, status, { error: 'Solicitud inválida', code })
}
