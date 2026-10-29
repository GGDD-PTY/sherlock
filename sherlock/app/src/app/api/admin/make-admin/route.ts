import { createHash } from 'node:crypto'

import { Effect, Schema } from 'effect'
import { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import { rejectInvalidOrigin } from '@/lib/api/csrf'
import {
  requireAdminRouteUser,
  respond,
  routePromise,
  runRouteEffect,
} from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId } from '@/lib/api/response'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:Admin:MakeAdmin')
const ROUTE = '/api/admin/make-admin'
const makeAdminBodySchema = Schema.Struct({
  email: Schema.Trim.pipe(Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))),
})

// ===== TODA SALIDA DE ESTA RUTA PASA POR `apiError` / `apiSuccess` =====
// Tres de las cuatro salidas de error eran `NextResponse.json({ error })`
// pelado: sin `requestId` en el cuerpo ni en las cabeceras, sin `no-store` y
// sin `nosniff`. El panel no tenía con qué distinguir «email inválido» de «se
// cayó la sesión admin», y quien reportaba el fallo no tenía código con el cual
// encontrar la línea del log del servidor.
const postMakeAdmin = Effect.fn('AdminMakeAdmin.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrfError = rejectInvalidOrigin(request)
  if (csrfError) return yield* respond(csrfError)

  const clientIp = getClientIp(request)
  const rateLimitResult = yield* routePromise('adminMakeAdmin.rateLimit', () =>
    checkRateLimitDistributed(`admin-make-admin:${clientIp}`, RATE_LIMIT_PRESETS.api)
  )
  if (!rateLimitResult.success) {
    log.warn('Rate limit exceeded', { clientIp })
    return yield* respond(createRateLimitResponse(rateLimitResult))
  }

  // Rol ADMIN + step-up (SSO/Passkey ≤10 min), igual que las páginas SSR.
  const user = yield* requireAdminRouteUser()

  const body = yield* routePromise(
    'adminMakeAdmin.parseBody',
    async () => (await request.json().catch(() => null)) as unknown
  )
  const parsed = yield* Schema.decodeUnknownEffect(makeAdminBodySchema)(body).pipe(
    Effect.catch(() => respond(apiError(requestId, 400, { error: 'Email inválido' })))
  )
  const email = parsed.email.toLowerCase()

  const convexAuth = yield* routePromise('adminMakeAdmin.authenticateConvex', () =>
    getAuthenticatedConvex()
  )
  if (!convexAuth?.client || !convexAuth.isAuthenticated) {
    log.warn('Authenticated Convex client unavailable', { adminUserId: user.id })
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'No se pudo verificar la sesión administrativa' },
        { route: ROUTE }
      )
    )
  }

  const result = yield* routePromise('adminMakeAdmin.promoteUser', () =>
    convexAuth.client.mutation(api.users.makeAdmin, { email })
  )
  // El correo del promovido no se escribe en claro: el log del servidor sale
  // del proceso hacia el agregador, y para cruzar dos líneas del mismo caso
  // alcanza el digest. Mismo trato que el IP del webhook de WorkOS.
  log.info('User promoted to admin', {
    adminUserId: user.id,
    targetEmailHash: createHash('sha256').update(email).digest('hex'),
  })

  return apiSuccess(result, requestId)
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(
    request,
    ROUTE,
    postMakeAdmin(request, requestId).pipe(
      Effect.catchTag('RouteOperationError', (error) => {
        log.error('Error promoting user to admin', { error: error.cause })
        return Effect.fail(
          respond(
            apiError(
              requestId,
              500,
              { error: 'Error al hacer admin al usuario' },
              { route: ROUTE, error: error.cause }
            )
          )
        )
      })
    ),
    { internalErrorMessage: 'Error al hacer admin al usuario', requestId }
  )
}
