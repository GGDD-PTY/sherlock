import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import type { Id } from '@/../convex/_generated/dataModel'
import {
  canonicalizeAdminVdrInput,
  isAdminVdrAction,
  isValidAdminVdrBindingIdentifier,
  type AdminVdrAction,
} from '@/../convex/_adminVdr/capabilityFormat'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { rejectNonExactSameOrigin } from '@/lib/api/exact-same-origin'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireAdminApiAuth } from '@/lib/api/with-auth'
import { issueAdminVdrCapability } from '@/lib/auth/admin-vdr-capability-server'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'

const ROUTE = '/api/admin/vdr-capabilities'

function parseRequestBody(value: unknown): {
  companyId: Id<'companies'>
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).some((key) => !['companyId', 'action', 'target', 'input'].includes(key)) ||
    typeof body.companyId !== 'string' ||
    !isValidAdminVdrBindingIdentifier(body.companyId) ||
    !isAdminVdrAction(body.action) ||
    typeof body.target !== 'string' ||
    !isValidAdminVdrBindingIdentifier(body.target, 1_024) ||
    !body.input ||
    typeof body.input !== 'object' ||
    Array.isArray(body.input) ||
    !canonicalizeAdminVdrInput(body.input)
  ) {
    return null
  }
  return {
    companyId: body.companyId as Id<'companies'>,
    action: body.action,
    target: body.target,
    input: body.input as Record<string, unknown>,
  }
}

const postAdminVdrCapability = Effect.fn('AdminVdrCapabilities.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrfError = rejectNonExactSameOrigin(request)
  if (csrfError) return yield* respond(withRequestIdHeader(csrfError, requestId))

  const { user, error: authError } = yield* routePromise('adminVdrCapabilities.authenticate', () =>
    requireAdminApiAuth()
  )
  if (authError) return yield* respond(withRequestIdHeader(authError, requestId))
  if (!user.profileId || !user.sessionId) {
    return yield* respond(
      apiError(requestId, 403, { error: 'Autorización administrativa no disponible' })
    )
  }

  const rateLimit = yield* routePromise('adminVdrCapabilities.rateLimit', () =>
    checkRateLimitDistributed(`admin-vdr-capability:${user.profileId}`, RATE_LIMIT_PRESETS.mutation)
  )
  if (!rateLimit.success)
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimit), requestId))

  const body = parseRequestBody(
    yield* routePromise('adminVdrCapabilities.parseBody', () => request.json().catch(() => null))
  )
  if (!body) {
    return yield* respond(apiError(requestId, 400, { error: 'Solicitud inválida' }))
  }

  const issued = yield* routePromise('adminVdrCapabilities.issue', () =>
    issueAdminVdrCapability({ user, ...body })
  ).pipe(
    Effect.catchTag('RouteOperationError', () =>
      Effect.fail(
        respond(apiError(requestId, 403, { error: 'No se pudo autorizar la operación VDR' }))
      )
    )
  )
  return apiSuccess(issued, requestId, { status: 201 })
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, postAdminVdrCapability(request, requestId), { requestId })
}
