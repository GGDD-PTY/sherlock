import { Effect } from 'effect'
import { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import {
  requireAdminRouteUser,
  requireRouteRateLimit,
  respond,
  routePromise,
  runRouteEffect,
} from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId } from '@/lib/api/response'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { createLogger } from '@/lib/logger'
import { getClientIp, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'

const log = createLogger('API:AdminActivityStats')
const ROUTE = '/api/admin/activity/stats'

const getActivityStats = Effect.fn('AdminActivityStats.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const clientIp = getClientIp(request)
  yield* requireRouteRateLimit(request, `admin-activity-stats:${clientIp}`, RATE_LIMIT_PRESETS.api)

  // Solo admins con re-autenticación fuerte reciente pueden ver estadísticas.
  const user = yield* requireAdminRouteUser()

  const daysParam = request.nextUrl.searchParams.get('days')
  // `days` inválido cae a 7 en silencio: un 400 aquí rompía el dashboard admin.
  let days = 7

  if (daysParam) {
    const parsed = Number.parseInt(daysParam, 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      // Tope de un año: sin él un `days` enorme tumba la query de Convex.
      days = Math.min(parsed, 365)
    }
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

  const stats = yield* routePromise('activityLogs.getStats', () =>
    convexAuth.client.query(api.activityLogs.getStats, { days })
  )

  return apiSuccess(stats, requestId)
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, getActivityStats(request, requestId), {
    internalErrorMessage: 'Error al obtener estadísticas',
    requestId,
  })
}
