import { Effect } from 'effect'
import { NextResponse, type NextRequest } from 'next/server'

import { validateOrigin } from '@/lib/api/csrf'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  checkRateLimitDistributedEffect,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { validateIntakeMutationRequest } from './csrf'

export function intakeRequestId(request: NextRequest): string {
  return getOrCreateRequestId(request)
}

function secureIntakeResponse<T extends Response>(response: T, requestId: string): T {
  return withRequestIdHeader(response, requestId)
}

export function intakeModeUnavailable(requestId: string): Response {
  return apiError(requestId, 404, { error: 'Recurso no disponible' })
}

export function intakeUnauthorized(requestId: string): Response {
  return apiError(requestId, 403, { error: 'Solicitud no autorizada' })
}

export function intakeInvalidRequest(
  requestId: string,
  status: 400 | 413 | 415,
  code: string
): Response {
  return apiError(requestId, status, { error: 'Solicitud inválida', code })
}

// `route` es obligatoria: un 503 sin ella avisa como `/unknown` y se agrupa con
// el 5xx de cualquier otro handler que comparta nombre de error.
export function intakeTemporarilyUnavailable(requestId: string, route: string): Response {
  return apiError(requestId, 503, { error: 'Acceso temporalmente no disponible' }, { route })
}

export function rejectIntakeReadOrigin(request: NextRequest, requestId: string): Response | null {
  return validateOrigin(request) ? null : intakeUnauthorized(requestId)
}

export function rejectIntakeMutation(
  request: NextRequest,
  requestId: string,
  binding: string
): Response | null {
  return validateIntakeMutationRequest(request, binding) ? null : intakeUnauthorized(requestId)
}

const rejectIntakeRateLimitEffect = Effect.fn('IntakeApi.rejectRateLimit')(function* (
  request: NextRequest,
  requestId: string,
  operation: 'session' | 'read' | 'upload' | 'mutation'
) {
  const preset =
    operation === 'upload'
      ? RATE_LIMIT_PRESETS.upload
      : operation === 'session'
        ? RATE_LIMIT_PRESETS.auth
        : operation === 'mutation'
          ? RATE_LIMIT_PRESETS.mutation
          : RATE_LIMIT_PRESETS.api
  const result = yield* checkRateLimitDistributedEffect(
    `intake-${operation}:${getClientIp(request)}`,
    preset
  )
  return result.success ? null : secureIntakeResponse(createRateLimitResponse(result), requestId)
})

/** Puente a Promise: las seis rutas del intake lo llaman desde `routePromise`. */
export function rejectIntakeRateLimit(
  request: NextRequest,
  requestId: string,
  operation: 'session' | 'read' | 'upload' | 'mutation'
): Promise<Response | null> {
  return runServerEffect(rejectIntakeRateLimitEffect(request, requestId, operation))
}

export function intakeJson(
  body: Record<string, unknown>,
  requestId: string,
  init?: ResponseInit
): NextResponse {
  return secureIntakeResponse(NextResponse.json({ requestId, ...body }, init), requestId)
}
