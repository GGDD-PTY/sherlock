import { WorkOS } from '@workos-inc/node'
import type { FunctionReference } from 'convex/server'
import { Duration, Effect, Schema } from 'effect'
import { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import { rejectInvalidOrigin } from '@/lib/api/csrf'
import { respond, routePromise, RouteOperationError, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { hasRecentAdminApiStepUp, requireApiAuth } from '@/lib/api/with-auth'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { createLogger } from '@/lib/logger'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'

const log = createLogger('API:WorkOS:AdminPortal')
const ROUTE = '/api/workos/admin-portal'

const ALLOWED_INTENTS = new Set(['sso', 'domain_verification'])
const ORG_PORTAL_ROLES = new Set(['ADMIN', 'COMPANY_OWNER'])

type WorkOsMembership = {
  betaRole?: string
  status?: string
}

type WorkOsApi = {
  workos: {
    getMyMembershipForOrg: FunctionReference<
      'query',
      'public',
      { workosOrgId: string },
      WorkOsMembership | null
    >
  }
}

const canManageWorkOsOrganization = Effect.fn('WorkOSAdminPortal.canManageOrganization')(function* (
  userRole: string,
  workosOrgId: string
) {
  // El atajo de plataforma (un ADMIN puede administrar cualquier organización)
  // exige step-up reciente; sin él se cae al chequeo de membresía normal.
  if (userRole === 'ADMIN') {
    const hasRecentStepUp = yield* routePromise('workosAdminPortal.checkAdminStepUp', () =>
      hasRecentAdminApiStepUp()
    )
    if (hasRecentStepUp) return true
  }

  const convexAuth = yield* routePromise('workosAdminPortal.authenticateConvex', () =>
    getAuthenticatedConvex()
  )
  if (!convexAuth?.client || !convexAuth.isAuthenticated) {
    return false
  }

  const workosApi = api as unknown as WorkOsApi
  const membership = yield* routePromise('workosAdminPortal.getMembership', () =>
    convexAuth.client.query(workosApi.workos.getMyMembershipForOrg, {
      workosOrgId,
    })
  )

  return membership?.status === 'ACTIVE' && ORG_PORTAL_ROLES.has(membership.betaRole ?? '')
})

// Antes se distinguía el caso "intent inválido" comparando `.message` contra
// el string exacto de este `throw`; un cambio de texto rompía la comparación
// en silencio. El `reason` tipado hace que el compilador lo garantice.
class InvalidAdminPortalBodyError extends Schema.TaggedError<InvalidAdminPortalBodyError>()(
  'InvalidAdminPortalBodyError',
  { reason: Schema.Literals(['invalid-body', 'missing-organization-id', 'invalid-intent']) }
) {}

function parseBody(body: unknown): {
  organizationId: string
  intent: 'sso' | 'domain_verification'
} {
  if (!body || typeof body !== 'object') {
    throw new InvalidAdminPortalBodyError({ reason: 'invalid-body' })
  }

  const record = body as Record<string, unknown>
  const organizationId =
    typeof record.organizationId === 'string' ? record.organizationId.trim() : ''
  const intent = typeof record.intent === 'string' ? record.intent.trim() : ''

  if (!organizationId) {
    throw new InvalidAdminPortalBodyError({ reason: 'missing-organization-id' })
  }

  if (!ALLOWED_INTENTS.has(intent)) {
    throw new InvalidAdminPortalBodyError({ reason: 'invalid-intent' })
  }

  return {
    organizationId,
    intent: intent as 'sso' | 'domain_verification',
  }
}

const postWorkOsAdminPortal = Effect.fn('WorkOSAdminPortal.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrfError = rejectInvalidOrigin(request)
  if (csrfError) return yield* respond(withRequestIdHeader(csrfError, requestId))

  const { user, error } = yield* routePromise('workosAdminPortal.authenticate', () =>
    requireApiAuth()
  )
  if (error) return yield* respond(withRequestIdHeader(error, requestId))

  // Rate limit per authenticated user — portal-link generation hits the WorkOS
  // API and can be abused to enumerate organization IDs.
  const rateLimit = yield* routePromise('workosAdminPortal.rateLimit', () =>
    checkRateLimitDistributed(`workos-admin-portal:${user.id}`, RATE_LIMIT_PRESETS.mutation)
  )
  if (!rateLimit.success) {
    log.warn('Rate limit exceeded', { userId: user.id })
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimit), requestId))
  }

  const parsed = yield* routePromise('workosAdminPortal.parseBody', async () =>
    parseBody(await request.json())
  ).pipe(
    Effect.catchTag('RouteOperationError', (parseError) => {
      const reason =
        parseError.cause instanceof InvalidAdminPortalBodyError
          ? parseError.cause.reason
          : 'invalid-body'
      return Effect.fail(
        respond(
          apiError(requestId, 400, {
            error: reason === 'invalid-intent' ? 'Intent inválido' : 'Solicitud inválida',
          })
        )
      )
    })
  )

  const canManage = yield* canManageWorkOsOrganization(user.role, parsed.organizationId)
  if (!canManage) {
    return yield* respond(
      apiError(requestId, 403, { error: 'No tienes permisos para administrar WorkOS' })
    )
  }

  const apiKey = process.env.WORKOS_API_KEY
  if (!apiKey) {
    log.error('WORKOS_API_KEY is not configured')
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'WorkOS Admin Portal no está configurado' },
        { route: ROUTE }
      )
    )
  }

  // `@workos-inc/node` no acepta un AbortSignal para esta llamada: el timeout
  // corta la espera del Effect, no la request HTTP en curso, igual que
  // `proxy-delivery.ts` documenta para el fetch de Convex Storage.
  const portal = yield* routePromise('workosAdminPortal.generateLink', async () => {
    const workos = new WorkOS(apiKey)
    return workos.adminPortal.generateLink({
      organization: parsed.organizationId,
      intent: parsed.intent,
      adminEmails: user.email ? [user.email] : undefined,
    })
  }).pipe(
    Effect.timeout(Duration.seconds(8)),
    Effect.catchTag('TimeoutError', () =>
      Effect.fail(
        new RouteOperationError({
          operation: 'workosAdminPortal.generateLink',
          message: 'WorkOS no respondió en 8 s.',
        })
      )
    )
  )

  return apiSuccess(
    {
      link: portal.link,
      intent: parsed.intent,
      organizationId: parsed.organizationId,
    },
    requestId
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(
    request,
    ROUTE,
    postWorkOsAdminPortal(request, requestId).pipe(
      Effect.catchTag('RouteOperationError', (error) => {
        log.error('Error generating WorkOS Admin Portal link', { error: error.cause })
        return Effect.fail(
          respond(
            apiError(
              requestId,
              500,
              { error: 'Error al generar el portal administrativo de WorkOS' },
              { route: ROUTE }
            )
          )
        )
      })
    ),
    { internalErrorMessage: 'Error al generar el portal administrativo de WorkOS', requestId }
  )
}
