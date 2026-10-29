import { Effect } from 'effect'
import { NextRequest, NextResponse } from 'next/server'
import { api } from '@/../convex/_generated/api'
import { Id } from '@/../convex/_generated/dataModel'
import {
  requireAdminRouteUser,
  requireRouteRateLimit,
  respond,
  routePromise,
  runRouteEffect,
} from '@/lib/api/effect-route'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { createLogger } from '@/lib/logger'
import { getClientIp, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'
import { formatAdminActivityLog } from '../../_format'

const log = createLogger('API:AdminUserActivity')
const ROUTE = '/api/admin/activity/user/[userId]'

interface RouteContext {
  params: Promise<{ userId: string }>
}

const getUserActivity = Effect.fn('AdminUserActivity.GET')(function* (
  request: NextRequest,
  context: RouteContext,
  requestId: string
) {
  const clientIp = getClientIp(request)
  yield* requireRouteRateLimit(request, `admin-activity-user:${clientIp}`, RATE_LIMIT_PRESETS.api)

  // Solo admins con re-autenticación fuerte reciente pueden ver logs ajenos.
  const user = yield* requireAdminRouteUser()

  const { userId } = yield* routePromise('route.params', () => context.params)
  const limitParam = request.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50

  if (!userId || userId.length < 10) {
    return yield* respond(apiError(requestId, 400, { error: 'ID de usuario inválido' }))
  }

  const convexAuth = yield* routePromise('convex.authenticate', () => getAuthenticatedConvex())
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

  const logs = yield* routePromise('activityLogs.getByUserId', () =>
    convexAuth.client.query(api.activityLogs.getByUserId, {
      userId: userId as Id<'profiles'>,
      limit,
    })
  )

  const formattedLogs = logs.map(formatAdminActivityLog)

  return withRequestIdHeader(NextResponse.json(formattedLogs), requestId)
})

export function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, getUserActivity(request, context, requestId), {
    internalErrorMessage: 'Error al obtener actividades del usuario',
    requestId,
  })
}
