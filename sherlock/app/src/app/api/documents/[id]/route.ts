import { Effect } from 'effect'
import { NextRequest } from 'next/server'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { rejectNonExactSameOrigin } from '@/lib/api/exact-same-origin'
import { requireAdminApiAuth, requireApiAuth } from '@/lib/api/with-auth'
import { issueAdminVdrCapability } from '@/lib/auth/admin-vdr-capability-server'
import { adminVdrTarget } from '@/../convex/_adminVdr/capabilityFormat'
import { api } from '@/../convex/_generated/api'
import { Id } from '@/../convex/_generated/dataModel'
import { isValidConvexId, toConvexId } from '@/lib/validations'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:Documents')
const ROUTE = '/api/documents/[id]'

interface RouteContext {
  params: Promise<{ id: string }>
}

const getApiConvexClient = Effect.fn('Documents.getApiConvexClient')(function* () {
  const convexAuth = yield* routePromise('documents.delete.convex.authenticate', () =>
    getAuthenticatedConvex()
  )

  if (!convexAuth?.client || (!convexAuth.isAuthenticated && !DEV_AUTH_ENABLED)) {
    return null
  }

  return convexAuth.client
})

const deleteDocument = Effect.fn('Documents.DELETE')(function* (
  request: NextRequest,
  context: RouteContext,
  requestId: string
) {
  const csrfError = rejectNonExactSameOrigin(request)
  if (csrfError) return yield* respond(withRequestIdHeader(csrfError, requestId))

  const clientIp = getClientIp(request)
  const rateLimitResult = yield* routePromise('documents.delete.rateLimit', () =>
    checkRateLimitDistributed(`documents:delete:${clientIp}`, RATE_LIMIT_PRESETS.api)
  )
  if (!rateLimitResult.success) {
    log.warn('Rate limit exceeded', { clientIp })
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId))
  }

  const { id } = yield* routePromise('documents.delete.params', () => context.params)

  const baseAuth = yield* routePromise('documents.delete.authenticate', () => requireApiAuth())
  if (baseAuth.error) return yield* respond(withRequestIdHeader(baseAuth.error, requestId))
  let user = baseAuth.user
  if (user.role === 'ADMIN') {
    const adminAuth = yield* routePromise('documents.delete.authenticateAdmin', () =>
      requireAdminApiAuth()
    )
    if (adminAuth.error) return yield* respond(withRequestIdHeader(adminAuth.error, requestId))
    user = adminAuth.user
  }

  if (!isValidConvexId(id)) {
    return yield* respond(apiError(requestId, 400, { error: 'ID inválido' }))
  }
  const documentId = toConvexId<'documents'>(id)

  if (user.role !== 'COMPANY' && user.role !== 'ADMIN') {
    return yield* respond(apiError(requestId, 403, { error: 'Prohibido' }))
  }

  const convexClient = yield* getApiConvexClient()
  if (!convexClient) {
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'No se pudo verificar autorización en Convex' },
        { route: ROUTE }
      )
    )
  }

  const document = yield* routePromise('documents.delete.getDocument', () =>
    convexClient.query(api.documents.get, {
      documentId,
    })
  )
  if (!document) {
    return yield* respond(apiError(requestId, 404, { error: 'Documento no encontrado' }))
  }

  if (user.role === 'COMPANY') {
    const company = yield* routePromise('documents.delete.getCompanyByOwner', () =>
      convexClient.query(api.companies.getCompanyByOwner, {
        ownerId: user.profileId as Id<'profiles'>,
      })
    )

    if (!company || document.companyId !== company._id) {
      return yield* respond(
        apiError(requestId, 403, { error: 'No tienes permiso para eliminar este documento' })
      )
    }
  }

  const mutationInput = {
    documentId,
  }
  const adminCapability =
    user.role === 'ADMIN'
      ? yield* routePromise('documents.delete.issueAdminCapability', () =>
          issueAdminVdrCapability({
            user,
            companyId: document.companyId,
            action: 'DOCUMENT_ARCHIVE',
            target: adminVdrTarget('DOCUMENT', id),
            input: mutationInput,
          })
        )
      : null
  yield* routePromise('documents.delete.remove', () =>
    convexClient.mutation(api.documents.remove, {
      ...mutationInput,
      ...(adminCapability ? { adminCapability: adminCapability.capability } : {}),
    })
  )

  log.info('Document deleted successfully', { documentId: id })

  return apiSuccess({ success: true, message: 'Documento eliminado' }, requestId)
})

export function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, deleteDocument(request, context, requestId), {
    internalErrorMessage: 'Error interno',
    requestId,
  })
}
