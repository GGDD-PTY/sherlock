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
import { guestOtpVerifySchema, parseVdrGuestJson } from '@/lib/auth/vdr-guest-request'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import {
  setVdrGuestSessionCookie,
  verifyGuestOtpAndCreateSessionRef,
  VDR_GUEST_SESSION_TTL_SECONDS,
} from '@/lib/auth/vdr-guest-session'
import { guestUnavailable } from '../_unavailable'

const ROUTE = '/api/vdr/guest/verify'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>
type GuestOtpVerify = typeof guestOtpVerifySchema.Type

const verifyGuestOtp = Effect.fn('VdrGuestVerify.verify')(function* (
  client: GuestClient,
  data: GuestOtpVerify,
  requestId: string
) {
  const serverBoundary = createVdrGuestServerProof({
    operation: 'VERIFY_OTP',
    bindingParts: [data.invitationHandle, data.challengeToken, data.code],
  })
  const result = yield* routePromise('vdrGuest.otp.verify', () =>
    client.mutation(verifyGuestOtpAndCreateSessionRef, {
      ...data,
      ...serverBoundary,
    })
  )
  if (!result.verified) {
    return secureGuestResponse(
      NextResponse.json({ verified: false, requestId }, { status: 401 }),
      requestId
    )
  }
  const now = Date.now()
  if (
    !/^[a-zA-Z0-9_-]{32,256}$/.test(result.sessionToken) ||
    result.expiresAt <= now ||
    result.expiresAt > now + VDR_GUEST_SESSION_TTL_SECONDS * 1000 + 5_000 ||
    result.roomAccessGranted !== false
  ) {
    throw new Error('INVALID_GUEST_SESSION_RESPONSE')
  }
  const response = NextResponse.json({
    verified: true,
    expiresAt: result.expiresAt,
    roomAccessGranted: false,
    requestId,
  })
  setVdrGuestSessionCookie(response, result.sessionToken, result.expiresAt, now)
  return secureGuestResponse(response, requestId)
})

const postGuestVerify = Effect.fn('VdrGuestVerify.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.verify.rateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'otp-verify')
  )
  if (limited) return yield* respond(limited)

  const parsed = yield* routePromise('vdrGuest.verify.parse', () =>
    parseVdrGuestJson(request, guestOtpVerifySchema)
  )
  if (!parsed.ok) {
    return yield* respond(invalidGuestRequest(requestId, parsed.status, parsed.code))
  }
  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(guestUnavailable(requestId))

  return yield* Effect.catchCause(verifyGuestOtp(client, parsed.data, requestId), () =>
    Effect.succeed(guestUnavailable(requestId))
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, postGuestVerify(request, requestId), { requestId })
}
