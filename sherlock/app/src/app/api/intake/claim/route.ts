import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { scheduleIntakeClaimConversion } from '@/lib/analytics/server'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { isDevAuthEnabled } from '@/lib/dev-auth/config'
import { isLoopbackConvexUrl, localConvexAdminKey } from '@/lib/dev-auth/local-convex-identity'
import {
  intakeJson,
  intakeModeUnavailable,
  intakeRequestId,
  intakeTemporarilyUnavailable,
  intakeUnauthorized,
  rejectIntakeMutation,
  rejectIntakeRateLimit,
} from '@/lib/intake/api'
import { provisionAndClaimIntake, readWorkosSubjectFromAccessToken } from '@/lib/intake/claim'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { clearIntakeCsrfCookie } from '@/lib/intake/csrf'
import { clearIntakeSessionCookie, readIntakeSessionToken } from '@/lib/intake/session'

const ROUTE = '/api/intake/claim'

type AuthenticatedConvex = NonNullable<Awaited<ReturnType<typeof getAuthenticatedConvex>>>

const claimIntake = Effect.fn('IntakeClaim.claim')(function* (
  request: NextRequest,
  requestId: string,
  authenticated: AuthenticatedConvex,
  sessionToken: string,
  workosSubject: string
) {
  const result = yield* routePromise('intake.claim.provision', () =>
    provisionAndClaimIntake({
      client: authenticated.client,
      sessionToken,
      workosSubject,
    })
  )
  scheduleIntakeClaimConversion({
    claimDigest: result.claimDigest,
    claimedDocumentCount: result.claimedDocumentCount,
    locale: 'es',
    requestHeaders: request.headers,
  })
  const response = intakeJson(
    {
      status: result.status,
      claimDigest: result.claimDigest,
      companyId: result.companyId,
      documentIds: result.documentIds,
      claimedDocumentCount: result.claimedDocumentCount,
      skippedDocumentCount: result.skippedDocumentCount,
      completedAt: result.completedAt,
    },
    requestId
  )
  clearIntakeSessionCookie(response)
  clearIntakeCsrfCookie(response)
  return response
})

const postIntakeClaim = Effect.fn('IntakeClaim.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))

  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.claim.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'mutation')
  )
  if (limited) return yield* respond(limited)

  const authenticated = yield* routePromise('intake.claim.authenticate', () =>
    getAuthenticatedConvex()
  )
  const localAuthority =
    isLoopbackConvexUrl(request.nextUrl.origin) &&
    localConvexAdminKey(
      {
        NODE_ENV: process.env.NODE_ENV,
        NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
        NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
      },
      isDevAuthEnabled()
    ) !== null
  const workosSubject = authenticated?.token
    ? readWorkosSubjectFromAccessToken(authenticated.token)
    : localAuthority
      ? (authenticated?.localSubject ?? null)
      : null
  if (!authenticated?.isAuthenticated || !workosSubject) {
    return yield* respond(intakeUnauthorized(requestId))
  }

  return yield* Effect.catchCause(
    claimIntake(request, requestId, authenticated, sessionToken, workosSubject),
    () => Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, postIntakeClaim(request, requestId), { requestId })
}
