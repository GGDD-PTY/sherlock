import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { normalizeSupportMessage } from '@/../convex/_support/model'
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
  rejectIntakeReadOrigin,
} from '@/lib/intake/api'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { createIntakeServerProof } from '@/lib/intake/proof'
import { intakeSupportMessageSchema, parseIntakeJson } from '@/lib/intake/request'
import { readIntakeSessionToken } from '@/lib/intake/session'
import {
  getIntakeSupportRef,
  sendIntakeSupportMessageRef,
  type IntakeSupportMessage,
} from '@/lib/intake/support'

const ROUTE = '/api/intake/support'

function projectMessage(value: unknown): IntakeSupportMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (
    typeof message.messageId !== 'string' ||
    !Number.isSafeInteger(message.sequence) ||
    !['COMPANY', 'ADMIN', 'INTAKE'].includes(String(message.authorKind)) ||
    typeof message.body !== 'string' ||
    message.body.length === 0 ||
    message.body.length > 2_000 ||
    !Number.isSafeInteger(message.createdAt)
  ) {
    return null
  }
  return message as IntakeSupportMessage
}

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const readIntakeSupport = Effect.fn('IntakeSupport.read')(function* (
  client: IntakeClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('intake.support.read', () =>
    client.mutation(getIntakeSupportRef, {
      sessionToken,
      ...createIntakeServerProof({ operation: 'SUPPORT_READ', bindingParts: [sessionToken] }),
    })
  )
  if (!Array.isArray(result.messages) || result.messages.length > 30) {
    return intakeTemporarilyUnavailable(requestId, ROUTE)
  }
  const messages = result.messages.map(projectMessage)
  if (messages.some((message) => message === null))
    return intakeTemporarilyUnavailable(requestId, ROUTE)
  return intakeJson(
    { messages: messages as IntakeSupportMessage[], truncated: result.truncated === true },
    requestId
  )
})

const sendIntakeSupport = Effect.fn('IntakeSupport.send')(function* (
  client: IntakeClient,
  sessionToken: string,
  rawBody: string,
  requestId: string
) {
  const body = normalizeSupportMessage(rawBody)
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const result = yield* routePromise('intake.support.send', () =>
    client.mutation(sendIntakeSupportMessageRef, {
      sessionToken,
      body,
      ...createIntakeServerProof({
        operation: 'SUPPORT_SEND',
        bindingParts: [sessionToken, bodyDigest],
      }),
    })
  )
  const message = projectMessage(result.message)
  if (!message) return intakeTemporarilyUnavailable(requestId, ROUTE)
  return intakeJson({ message }, requestId, { status: 201 })
})

const getIntakeSupport = Effect.fn('IntakeSupport.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const origin = rejectIntakeReadOrigin(request, requestId)
  if (origin) return yield* respond(origin)
  const limited = yield* routePromise('intake.support.readRateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'read')
  )
  if (limited) return yield* respond(limited)
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(readIntakeSupport(client, sessionToken, requestId), () =>
    Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

const postIntakeSupport = Effect.fn('IntakeSupport.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.support.writeRateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'mutation')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('intake.support.parse', () =>
    parseIntakeJson(request, intakeSupportMessageSchema)
  )
  if (!parsed.ok) {
    return yield* respond(intakeInvalidRequest(requestId, parsed.status, parsed.code))
  }

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(
    sendIntakeSupport(client, sessionToken, parsed.data.body, requestId),
    () => Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, getIntakeSupport(request, requestId), { requestId })
}

export function POST(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, postIntakeSupport(request, requestId), { requestId })
}
