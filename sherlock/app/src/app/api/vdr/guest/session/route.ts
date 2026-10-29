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
  resolveGuestSessionRef,
  rotateGuestSessionRef,
  setVdrGuestSessionCookie,
  VDR_GUEST_SESSION_TTL_SECONDS,
} from '@/lib/auth/vdr-guest-session'
import { guestUnavailable } from '../_unavailable'

const ROUTE = '/api/vdr/guest/session'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const resolveGuestSession = Effect.fn('VdrGuestSession.resolve')(function* (
  client: GuestClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('vdrGuest.session.resolve', () =>
    client.mutation(resolveGuestSessionRef, {
      sessionToken,
      ...createVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [sessionToken],
      }),
    })
  )
  if (!result.authenticated || result.roomAccessGranted !== false) {
    const response = NextResponse.json({ authenticated: false, requestId })
    clearVdrGuestSessionCookie(response)
    return secureGuestResponse(response, requestId)
  }
  return secureGuestResponse(
    NextResponse.json({
      authenticated: true,
      expiresAt: result.expiresAt,
      roomAccessGranted: false,
      requiredGates: result.requiredGates,
      requestId,
    }),
    requestId
  )
})

const rotateGuestSession = Effect.fn('VdrGuestSession.rotate')(function* (
  client: GuestClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('vdrGuest.session.rotate', () =>
    client.mutation(rotateGuestSessionRef, {
      sessionToken,
      ...createVdrGuestServerProof({
        operation: 'ROTATE_SESSION',
        bindingParts: [sessionToken],
      }),
    })
  )
  if (!result.rotated) {
    const response = NextResponse.json({ rotated: false, requestId }, { status: 401 })
    clearVdrGuestSessionCookie(response)
    return secureGuestResponse(response, requestId)
  }
  const now = Date.now()
  if (
    !/^[a-zA-Z0-9_-]{32,256}$/.test(result.sessionToken) ||
    result.expiresAt <= now ||
    result.expiresAt > now + VDR_GUEST_SESSION_TTL_SECONDS * 1000 + 5_000 ||
    result.roomAccessGranted !== false
  ) {
    throw new Error('INVALID_GUEST_SESSION_ROTATION')
  }
  const response = NextResponse.json({
    rotated: true,
    expiresAt: result.expiresAt,
    roomAccessGranted: false,
    requestId,
  })
  setVdrGuestSessionCookie(response, result.sessionToken, result.expiresAt, now)
  return secureGuestResponse(response, requestId)
})

const getGuestSession = Effect.fn('VdrGuestSession.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.session.readRateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'session-read')
  )
  if (limited) return yield* respond(limited)
  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) {
    return yield* respond(
      secureGuestResponse(NextResponse.json({ authenticated: false, requestId }), requestId)
    )
  }
  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(guestUnavailable(requestId))
  return yield* Effect.catchCause(resolveGuestSession(client, sessionToken, requestId), () =>
    Effect.succeed(guestUnavailable(requestId))
  )
})

const postGuestSession = Effect.fn('VdrGuestSession.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.session.rotateRateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'session-rotate')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('vdrGuest.session.rotateParse', () =>
    parseVdrGuestJson(request, emptyGuestMutationSchema)
  )
  if (!parsed.ok) {
    return yield* respond(invalidGuestRequest(requestId, parsed.status, parsed.code))
  }
  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) {
    return yield* respond(
      secureGuestResponse(
        NextResponse.json({ rotated: false, requestId }, { status: 401 }),
        requestId
      )
    )
  }
  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(guestUnavailable(requestId))
  return yield* Effect.catchCause(rotateGuestSession(client, sessionToken, requestId), () =>
    Effect.succeed(guestUnavailable(requestId))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, getGuestSession(request, requestId), { requestId })
}

export function POST(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, postGuestSession(request, requestId), { requestId })
}
