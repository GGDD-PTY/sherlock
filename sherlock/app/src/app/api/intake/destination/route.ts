import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { api } from '@/../convex/_generated/api'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import {
  intakeJson,
  intakeRequestId,
  intakeTemporarilyUnavailable,
  intakeUnauthorized,
  rejectIntakeRateLimit,
  rejectIntakeReadOrigin,
} from '@/lib/intake/api'

const ROUTE = '/api/intake/destination'

type DestinationWorkspace = {
  access: 'MANAGE' | 'READ_ONLY'
  company: { name: string }
} | null

const getIntakeDestination = Effect.fn('IntakeDestination.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const origin = rejectIntakeReadOrigin(request, requestId)
  if (origin) return yield* respond(origin)
  const limited = yield* routePromise('intake.destination.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'read')
  )
  if (limited) return yield* respond(limited)

  const authenticated = yield* routePromise('intake.destination.authenticate', () =>
    getAuthenticatedConvex()
  )
  if (!authenticated?.isAuthenticated) {
    return yield* respond(intakeUnauthorized(requestId))
  }

  const workspace = yield* Effect.catchCause(
    routePromise('intake.destination.workspace', () =>
      authenticated.client.query(api.companies.getMyVdrWorkspace, {})
    ),
    () => Effect.succeed('UNAVAILABLE' as const)
  )
  if (workspace === 'UNAVAILABLE') {
    return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  }

  return intakeJson({ companyName: projectOwnedRoomName(workspace) }, requestId)
})

function projectOwnedRoomName(workspace: DestinationWorkspace): string | null {
  if (!workspace || workspace.access !== 'MANAGE') return null
  const name = workspace.company.name.trim()
  return name.length > 0 ? name : null
}

export function GET(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, getIntakeDestination(request, requestId), {
    requestId,
  })
}
