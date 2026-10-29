import { Effect, Schema } from 'effect'
import type { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess } from '@/lib/api/response'
import {
  invalidGuestRequest,
  rejectGuestCsrf,
  rejectGuestRateLimit,
  vdrGuestRequestId,
} from '@/lib/auth/vdr-guest-api'
import { parseVdrGuestJson } from '@/lib/auth/vdr-guest-request'
import { readVdrGuestSessionToken } from '@/lib/auth/vdr-guest-session'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'

const acceptanceSchema = Schema.Struct({
  contentHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  signatoryName: Schema.Trim.pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(150))),
})

// Sin `route` un 5xx avisa como `/unknown` y se agrupa con el 5xx de cualquier
// otro handler que comparta nombre de error.
const ROUTE = '/api/vdr/guest/nda'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const fetchCompanyNda = Effect.fn('VdrGuestNda.fetch')(function* (
  client: GuestClient,
  sessionToken: string,
  requestId: string
) {
  const nda = yield* routePromise('vdrGuest.nda.fetch', () =>
    client.mutation(api.guestAccess.getCompanyNda, {
      sessionToken,
      ...createVdrGuestServerProof({ operation: 'READ_NDA', bindingParts: [sessionToken] }),
    })
  )
  return nda
    ? apiSuccess({ nda }, requestId)
    : apiError(requestId, 403, { code: 'GUEST_NDA_UNAVAILABLE' })
})

const getGuestNda = Effect.fn('VdrGuestNda.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.nda.readRateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'room-read')
  )
  if (limited) return yield* respond(limited)
  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) {
    return yield* respond(apiError(requestId, 401, { code: 'GUEST_SESSION_REQUIRED' }))
  }
  const client = getUnauthenticatedConvex()
  if (!client) {
    return yield* respond(apiError(requestId, 503, { code: 'GUEST_UNAVAILABLE' }, { route: ROUTE }))
  }
  return yield* Effect.catchCause(fetchCompanyNda(client, sessionToken, requestId), () =>
    Effect.succeed(apiError(requestId, 403, { code: 'GUEST_NDA_UNAVAILABLE' }))
  )
})

const acceptCompanyNda = Effect.fn('VdrGuestNda.accept')(function* (
  client: GuestClient,
  sessionToken: string,
  data: typeof acceptanceSchema.Type,
  requestId: string
) {
  const result = yield* routePromise('vdrGuest.nda.accept', () =>
    client.mutation(api.guestAccess.acceptCompanyNda, {
      sessionToken,
      ...data,
      ...createVdrGuestServerProof({
        operation: 'ACCEPT_NDA',
        bindingParts: [sessionToken, data.contentHash, data.signatoryName],
      }),
    })
  )
  return apiSuccess(result, requestId)
})

const postGuestNda = Effect.fn('VdrGuestNda.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.nda.acceptRateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'otp-verify')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('vdrGuest.nda.acceptParse', () =>
    parseVdrGuestJson(request, acceptanceSchema)
  )
  if (!parsed.ok) {
    return yield* respond(invalidGuestRequest(requestId, parsed.status, parsed.code))
  }
  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) {
    return yield* respond(apiError(requestId, 401, { code: 'GUEST_SESSION_REQUIRED' }))
  }
  const client = getUnauthenticatedConvex()
  if (!client) {
    return yield* respond(apiError(requestId, 503, { code: 'GUEST_UNAVAILABLE' }, { route: ROUTE }))
  }
  return yield* Effect.catchCause(
    acceptCompanyNda(client, sessionToken, parsed.data, requestId),
    () => Effect.succeed(apiError(requestId, 403, { code: 'GUEST_NDA_DENIED' }))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, getGuestNda(request, requestId), { requestId })
}

export function POST(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, postGuestNda(request, requestId), { requestId })
}
