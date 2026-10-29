import { Effect } from 'effect'
import { NextRequest, NextResponse } from 'next/server'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import {
  invalidGuestRequest,
  rejectGuestCsrf,
  rejectGuestRateLimit,
  secureGuestResponse,
  vdrGuestRequestId,
} from '@/lib/auth/vdr-guest-api'
import { guestOtpRequestSchema, parseVdrGuestJson } from '@/lib/auth/vdr-guest-request'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import { requestGuestOtpRef } from '@/lib/auth/vdr-guest-session'
import { guestUnavailable } from '../../_unavailable'

const ROUTE = '/api/vdr/guest/otp/request'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>
type GuestOtpRequest = typeof guestOtpRequestSchema.Type

const requestGuestOtp = Effect.fn('VdrGuestOtpRequest.request')(function* (
  client: GuestClient,
  data: GuestOtpRequest,
  requestId: string
) {
  const serverBoundary = createVdrGuestServerProof({
    operation: 'REQUEST_OTP',
    bindingParts: [data.invitationHandle, data.email],
  })
  const result = yield* routePromise('vdrGuest.otp.request', () =>
    client.mutation(requestGuestOtpRef, {
      invitationHandle: data.invitationHandle,
      email: data.email,
      ...serverBoundary,
    })
  )
  if (
    result.accepted !== true ||
    result.expiresInSeconds !== 600 ||
    typeof result.challengeToken !== 'string' ||
    result.challengeToken.length < 32 ||
    result.challengeToken.length > 256
  ) {
    throw new Error('INVALID_GUEST_OTP_RESPONSE')
  }
  return secureGuestResponse(
    NextResponse.json(
      {
        accepted: true,
        challengeToken: result.challengeToken,
        expiresInSeconds: result.expiresInSeconds,
        requestId,
      },
      { status: 202 }
    ),
    requestId
  )
})

const postGuestOtpRequest = Effect.fn('VdrGuestOtpRequest.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.otp.request.rateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'otp-request')
  )
  if (limited) return yield* respond(limited)

  const parsed = yield* routePromise('vdrGuest.otp.request.parse', () =>
    parseVdrGuestJson(request, guestOtpRequestSchema)
  )
  if (!parsed.ok) {
    return yield* respond(invalidGuestRequest(requestId, parsed.status, parsed.code))
  }
  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(guestUnavailable(requestId))

  return yield* Effect.catchCause(requestGuestOtp(client, parsed.data, requestId), () =>
    Effect.succeed(guestUnavailable(requestId))
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, postGuestOtpRequest(request, requestId), { requestId })
}
