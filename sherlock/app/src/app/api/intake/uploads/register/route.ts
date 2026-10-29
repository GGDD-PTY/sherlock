import type { Id } from '@/../convex/_generated/dataModel'
import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import {
  intakeInvalidRequest,
  intakeJson,
  intakeModeUnavailable,
  intakeRequestId,
  intakeTemporarilyUnavailable,
  intakeUnauthorized,
  rejectIntakeMutation,
  rejectIntakeRateLimit,
} from '@/lib/intake/api'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { createIntakeServerProof } from '@/lib/intake/proof'
import { intakeUploadRegistrationSchema, parseIntakeJson } from '@/lib/intake/request'
import { readIntakeSessionToken, registerIntakeUploadRef } from '@/lib/intake/session'
import { projectIntakeDocument } from '../../_project-document'

const ROUTE = '/api/intake/uploads/register'

const SAFE_UPLOAD_CODES = new Set([
  'INVALID_FILE_SIGNATURE',
  'INVALID_ARCHIVE',
  'ENCRYPTED_ARCHIVE',
  'ZIP_BOMB',
  'MALWARE_DETECTED',
  'SCAN_UNAVAILABLE',
  'UPLOAD_QUARANTINED',
])

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>
type IntakeUploadRegistration = typeof intakeUploadRegistrationSchema.Type

const registerIntakeUpload = Effect.fn('IntakeUploadRegistration.register')(function* (
  client: IntakeClient,
  sessionToken: string,
  data: IntakeUploadRegistration,
  requestId: string
) {
  const result = yield* routePromise('intake.uploads.register', () =>
    client.action(registerIntakeUploadRef, {
      sessionToken,
      intentId: data.intentId as Id<'intakeUploadIntents'>,
      storageId: data.storageId as Id<'_storage'>,
      ...createIntakeServerProof({
        operation: 'REGISTER_UPLOAD',
        bindingParts: [sessionToken, data.intentId, data.storageId],
      }),
    })
  )
  const document = result.document ? projectIntakeDocument(result.document) : null
  if (result.document && !document) return intakeTemporarilyUnavailable(requestId, ROUTE)
  if (!result.registered && !document) {
    return intakeInvalidRequest(requestId, 400, 'UPLOAD_REJECTED')
  }
  const code =
    typeof result.code === 'string' && SAFE_UPLOAD_CODES.has(result.code) ? result.code : undefined
  return intakeJson(
    {
      registered: result.registered === true,
      ...(code ? { code } : {}),
      ...(document ? { document } : {}),
    },
    requestId
  )
})

const postIntakeUploadRegistration = Effect.fn('IntakeUploadRegistration.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.uploads.register.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'upload')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('intake.uploads.register.parse', () =>
    parseIntakeJson(request, intakeUploadRegistrationSchema)
  )
  if (!parsed.ok) {
    return yield* respond(intakeInvalidRequest(requestId, parsed.status, parsed.code))
  }

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(
    registerIntakeUpload(client, sessionToken, parsed.data, requestId),
    () => Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, postIntakeUploadRegistration(request, requestId), {
    requestId,
  })
}
