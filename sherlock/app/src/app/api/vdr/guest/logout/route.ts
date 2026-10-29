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
import { emptyGuestMutationSchema, parseVdrGuestJson } from '@/lib/auth/vdr-guest-request'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import {
  clearVdrGuestSessionCookie,
  readVdrGuestSessionToken,
  revokeGuestSessionRef,
} from '@/lib/auth/vdr-guest-session'
import { guestUnavailable } from '../_unavailable'

const ROUTE = '/api/vdr/guest/logout'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const revokeGuestSession = Effect.fn('VdrGuestLogout.revoke')(function* (
  client: GuestClient,
  sessionToken: string
) {
  yield* routePromise('vdrGuest.logout.revoke', () =>
    client.mutation(revokeGuestSessionRef, {
      sessionToken,
      ...createVdrGuestServerProof({
        operation: 'REVOKE_SESSION',
        bindingParts: [sessionToken],
      }),
    })
  )
  return true
})

const postGuestLogout = Effect.fn('VdrGuestLogout.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.logout.rateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'logout')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('vdrGuest.logout.parse', () =>
    parseVdrGuestJson(request, emptyGuestMutationSchema)
  )
  if (!parsed.ok) {
    return yield* respond(invalidGuestRequest(requestId, parsed.status, parsed.code))
  }

  const sessionToken = readVdrGuestSessionToken(request)
  if (sessionToken) {
    const client = getUnauthenticatedConvex()
    if (!client) return yield* respond(guestUnavailable(requestId))
    const revoked = yield* Effect.catchCause(revokeGuestSession(client, sessionToken), () =>
      Effect.succeed(false)
    )
    if (!revoked) return yield* respond(guestUnavailable(requestId))
  }

  const response = NextResponse.json({ loggedOut: true, requestId })
  clearVdrGuestSessionCookie(response)
  return secureGuestResponse(response, requestId)
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, postGuestLogout(request, requestId), { requestId })
}
