import { Effect } from 'effect'
import { NextRequest, NextResponse } from 'next/server'
import { api } from '@/../convex/_generated/api'
import {
  requireAdminRouteUser,
  requireRouteRateLimit,
  respond,
  routePromise,
  runRouteEffect,
} from '@/lib/api/effect-route'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { isActivityType } from '@/lib/analytics/activity-types'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { createLogger } from '@/lib/logger'
import { getClientIp, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'
import { formatAdminActivityLog } from './_format'

const log = createLogger('API:AdminActivity')
const ROUTE = '/api/admin/activity'

const getActivity = Effect.fn('AdminActivity.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const clientIp = getClientIp(request)
  yield* requireRouteRateLimit(request, `admin-activity:${clientIp}`, RATE_LIMIT_PRESETS.api)

  // Solo admins con re-autenticación fuerte reciente pueden ver logs globales.
  const user = yield* requireAdminRouteUser()

  const searchParams = request.nextUrl.searchParams
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100
  const activityType = searchParams.get('activityType') ?? undefined
  const startDateStr = searchParams.get('startDate')
  const endDateStr = searchParams.get('endDate')

  if (activityType && !isActivityType(activityType)) {
    return yield* respond(
      apiError(requestId, 400, { error: `activityType inválido: "${activityType}"` })
    )
  }

  let startDate: number | undefined
  let endDate: number | undefined

  if (startDateStr) {
    const parsedStart = new Date(startDateStr).getTime()
    if (!Number.isFinite(parsedStart)) {
      return yield* respond(
        apiError(requestId, 400, {
          error: `Fecha de inicio inválida: "${startDateStr}". Use formato ISO 8601 (ej: 2024-01-01 o 2024-01-01T00:00:00Z)`,
        })
      )
    }
    startDate = parsedStart
  }

  if (endDateStr) {
    const parsedEnd = new Date(endDateStr).getTime()
    if (!Number.isFinite(parsedEnd)) {
      return yield* respond(
        apiError(requestId, 400, {
          error: `Fecha de fin inválida: "${endDateStr}". Use formato ISO 8601 (ej: 2024-12-31 o 2024-12-31T23:59:59Z)`,
        })
      )
    }
    endDate = parsedEnd
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

  const logs = yield* routePromise('activityLogs.getAll', () =>
    convexAuth.client.query(api.activityLogs.getAll, {
      limit,
      activityType,
      startDate,
      endDate,
    })
  )

  const formattedLogs = logs.map(formatAdminActivityLog)

  return withRequestIdHeader(NextResponse.json(formattedLogs), requestId)
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, getActivity(request, requestId), {
    internalErrorMessage: 'Error al obtener actividades',
    requestId,
  })
}
