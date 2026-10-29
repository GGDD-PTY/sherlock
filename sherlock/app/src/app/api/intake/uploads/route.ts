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
import { intakeUploadIntentSchema, parseIntakeJson } from '@/lib/intake/request'
import { issueIntakeUploadIntentRef, readIntakeSessionToken } from '@/lib/intake/session'

const ROUTE = '/api/intake/uploads'

function validUploadUrl(value: unknown): value is string {
  const configuredUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (
    typeof value !== 'string' ||
    value.length > 2_048 ||
    !configuredUrl ||
    !URL.canParse(value) ||
    !URL.canParse(configuredUrl)
  ) {
    return false
  }
  const url = new URL(value)
  const configuredOrigin = new URL(configuredUrl).origin
  return (
    url.origin === configuredOrigin &&
    (url.protocol === 'https:' ||
      (process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  )
}

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>
type IntakeUploadIntent = typeof intakeUploadIntentSchema.Type

const issueIntakeUpload = Effect.fn('IntakeUploads.issue')(function* (
  client: IntakeClient,
  sessionToken: string,
  data: IntakeUploadIntent,
  requestId: string
) {
  const result = yield* routePromise('intake.uploads.issue', () =>
    client.mutation(issueIntakeUploadIntentRef, {
      sessionToken,
      ...data,
      ...createIntakeServerProof({
        operation: 'ISSUE_UPLOAD',
        bindingParts: [
          sessionToken,
          data.fileName,
          data.declaredMimeType,
          `${data.declaredByteSize}`,
          data.declaredSha256,
        ],
      }),
    })
  )
  if ('registered' in result) {
    return intakeInvalidRequest(requestId, 413, result.code)
  }
  if (result.alreadyRegistered) {
    return intakeJson(
      {
        alreadyRegistered: true,
        document: result.document,
      },
      requestId
    )
  }
  const now = Date.now()
  if (
    typeof result.intentId !== 'string' ||
    !validUploadUrl(result.uploadUrl) ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= now ||
    result.expiresAt > now + 10 * 60 * 1000 + 5_000
  ) {
    return intakeTemporarilyUnavailable(requestId, ROUTE)
  }
  return intakeJson(
    {
      alreadyRegistered: false,
      intentId: result.intentId as Id<'intakeUploadIntents'>,
      uploadUrl: result.uploadUrl,
      expiresAt: result.expiresAt,
    },
    requestId,
    { status: 201 }
  )
})

const postIntakeUpload = Effect.fn('IntakeUploads.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.uploads.rateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'upload')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('intake.uploads.parse', () =>
    parseIntakeJson(request, intakeUploadIntentSchema)
  )
  if (!parsed.ok) {
    return yield* respond(intakeInvalidRequest(requestId, parsed.status, parsed.code))
  }

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(
    issueIntakeUpload(client, sessionToken, parsed.data, requestId),
    () => Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, postIntakeUpload(request, requestId), { requestId })
}
