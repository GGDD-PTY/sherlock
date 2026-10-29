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
  rejectIntakeRateLimit,
  rejectIntakeReadOrigin,
} from '@/lib/intake/api'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { createIntakeServerProof } from '@/lib/intake/proof'
import {
  projectIntakeWorkspaceRef,
  readIntakeSessionToken,
  type IntakeDocumentView,
} from '@/lib/intake/session'
import { projectIntakeDocument } from '../_project-document'

const ROUTE = '/api/intake/documents'

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const listIntakeDocuments = Effect.fn('IntakeDocuments.list')(function* (
  client: IntakeClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('intake.documents.projectWorkspace', () =>
    client.mutation(projectIntakeWorkspaceRef, {
      sessionToken,
      ...createIntakeServerProof({
        operation: 'PROJECT_WORKSPACE',
        bindingParts: [sessionToken],
      }),
    })
  )
  if (!result.authenticated || !Array.isArray(result.documents)) {
    return intakeUnauthorized(requestId)
  }
  const documents = result.documents.map(projectIntakeDocument)
  if (documents.some((document) => document === null)) {
    return intakeTemporarilyUnavailable(requestId, ROUTE)
  }
  return intakeJson({ documents: documents as IntakeDocumentView[] }, requestId)
})

const getIntakeDocuments = Effect.fn('IntakeDocuments.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const origin = rejectIntakeReadOrigin(request, requestId)
  if (origin) return yield* respond(origin)
  const limited = yield* routePromise('intake.documents.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'read')
  )
  if (limited) return yield* respond(limited)
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(listIntakeDocuments(client, sessionToken, requestId), () =>
    Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, getIntakeDocuments(request, requestId), { requestId })
}
