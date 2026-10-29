// ============================================================================
// CONVEX ACTIVITY LOGS QUERIES
// ============================================================================
// Funciones para consultar la actividad del usuario.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Id } from './_generated/dataModel'
import { query, type QueryCtx } from './_generated/server'
import { dayKey } from './_analytics/shared'
import { requireAuth, requireAdmin, requireOwnership } from './_helpers/auth'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'

// ============================================================================
// QUERIES
// ============================================================================

const getByUserIdProgram = Effect.fn('ActivityLogs.getByUserId')(function* (
  ctx: QueryCtx,
  args: { userId: Id<'profiles'>; limit?: number }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() =>
    requireOwnership(profile, args.userId, 'No autorizado: Solo puedes ver tu propia actividad')
  )

  return yield* convexPromise(() =>
    ctx.db
      .query('activityLogs')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .order('desc') // Convex ordena por _creationTime cuando el campo del índice está fijo
      .take(args.limit || 50)
  )
})

/**
 * Obtiene los logs de actividad de un usuario.
 */
export const getByUserId = query({
  args: { userId: v.id('profiles'), limit: v.optional(v.number()) },
  handler: (ctx, args) => runConvex(getByUserIdProgram(ctx, args)),
})

const getAllProgram = Effect.fn('ActivityLogs.getAll')(function* (
  ctx: QueryCtx,
  args: { limit?: number; activityType?: string; startDate?: number; endDate?: number }
) {
  // ===== ADMIN ONLY =====
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() => requireAdmin(profile))

  // ===== CONSTRUIR QUERY BASE =====
  const activityType = args.activityType
  const logs = yield* convexPromise(() =>
    activityType
      ? // Si hay filtro de tipo, usar índice by_action
        ctx.db
          .query('activityLogs')
          .withIndex('by_action', (q) => q.eq('action', activityType))
          .order('desc')
          .take(args.limit || 100)
      : // Sin filtro, obtener todos ordenados por tiempo
        ctx.db
          .query('activityLogs')
          .order('desc')
          .take(args.limit || 100)
  )

  // ===== FILTRAR POR FECHAS (en memoria) =====
  // Convex no soporta filtros compuestos en queries, así que filtramos después
  if (!args.startDate && !args.endDate) {
    return logs
  }

  return logs.filter((log) => {
    const creationTime = log._creationTime
    if (args.startDate && creationTime < args.startDate) return false
    if (args.endDate && creationTime > args.endDate) return false
    return true
  })
})

/**
 * Obtiene todos los logs de actividad (admin).
 * Soporta filtros opcionales por tipo de acción y rango de fechas.
 */
export const getAll = query({
  args: {
    limit: v.optional(v.number()),
    activityType: v.optional(v.string()),
    startDate: v.optional(v.number()), // Timestamp en ms
    endDate: v.optional(v.number()), // Timestamp en ms
  },
  handler: (ctx, args) => runConvex(getAllProgram(ctx, args)),
})

const getStatsProgram = Effect.fn('ActivityLogs.getStats')(function* (
  ctx: QueryCtx,
  args: { days?: number }
) {
  // ===== ADMIN ONLY =====
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() => requireAdmin(profile))

  const daysBack = args.days || 7
  const startDate = Date.now() - daysBack * 24 * 60 * 60 * 1000

  // ===== QUERY CON FILTRO POR TIEMPO =====
  // Rango sobre el índice implícito by_creation_time, igual que
  // `adminAuditLogs.getStats`. El `.filter()` que había aquí escaneaba la tabla
  // completa y descartaba en memoria mientras el comentario de arriba prometía
  // lo contrario; la ventana ahora la resuelve la base.
  const recentLogs = yield* convexPromise(
    () =>
      ctx.db
        .query('activityLogs')
        .withIndex('by_creation_time', (q) => q.gte('_creationTime', startDate))
        .order('desc')
        .take(10000) // Límite de seguridad: máximo 10k registros por período
  )

  // ===== CALCULAR ESTADÍSTICAS =====
  const byType: Record<string, number> = {}
  const byDay: Record<string, number> = {}

  for (const log of recentLogs) {
    // Contar por tipo
    byType[log.action] = (byType[log.action] || 0) + 1

    const day = dayKey(log._creationTime)
    byDay[day] = (byDay[day] || 0) + 1
  }

  return {
    totalActivities: recentLogs.length,
    byType,
    byDay,
  }
})

/**
 * Obtiene estadísticas de actividad para el dashboard admin.
 * Calcula totales, desglose por tipo, y por día.
 *
 * Usa el índice implícito by_creation_time para acotar la ventana a nivel de
 * base, no en memoria.
 */
export const getStats = query({
  args: {
    days: v.optional(v.number()), // Número de días hacia atrás (default: 7)
  },
  handler: (ctx, args) => runConvex(getStatsProgram(ctx, args)),
})
