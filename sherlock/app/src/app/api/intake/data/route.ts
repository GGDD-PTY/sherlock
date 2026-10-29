import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import {
  intakeJson,
  intakeModeUnavailable,
  intakeRequestId,
  intakeTemporarilyUnavailable,
  intakeUnauthorized,
  rejectIntakeMutation,
  rejectIntakeRateLimit,
} from '@/lib/intake/api'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { clearIntakeCsrfCookie } from '@/lib/intake/csrf'
import { createIntakeServerProof } from '@/lib/intake/proof'
import {
  clearIntakeSessionCookie,
  deleteIntakeDataRef,
  readIntakeSessionToken,
} from '@/lib/intake/session'

const ROUTE = '/api/intake/data'

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const deleteIntakeData = Effect.fn('IntakeData.delete')(function* (
  client: IntakeClient,
  sessionToken: string,
  requestId: string
) {
  yield* routePromise('intake.data.delete', () =>
    client.mutation(deleteIntakeDataRef, {
      sessionToken,
      ...createIntakeServerProof({
        operation: 'DELETE_DATA',
        bindingParts: [sessionToken],
      }),
    })
  )
  const response = intakeJson({ deleted: true }, requestId)
  clearIntakeSessionCookie(response)
  clearIntakeCsrfCookie(response)
  return response
})

const deleteIntake = Effect.fn('IntakeData.DELETE')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.data.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'mutation')
  )
  if (limited) return yield* respond(limited)

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(deleteIntakeData(client, sessionToken, requestId), () =>
    Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function DELETE(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, deleteIntake(request, requestId), { requestId })
}
