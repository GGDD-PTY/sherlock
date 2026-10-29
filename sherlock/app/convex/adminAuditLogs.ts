// ============================================================================
// ADMIN AUDIT LOGS - QUERIES & MUTATIONS
// ============================================================================
// Query and manage admin audit logs for compliance and accountability.
// ============================================================================

import { paginationOptsValidator, type PaginationOptions } from 'convex/server'
import { v } from 'convex/values'
import { Effect } from 'effect'

import { query, type QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireAuthAdmin } from './_helpers/auth'
import { convexPromise, runConvex } from './_helpers/effect'

type AuditAction = Doc<'adminAuditLogs'>['action']
type AuditTargetType = Doc<'adminAuditLogs'>['targetType']

const listProgram = Effect.fn('AdminAuditLogs.list')(function* (
  ctx: QueryCtx,
  args: {
    paginationOpts: PaginationOptions
    action?: string
    targetType?: string
    adminProfileId?: Id<'profiles'>
  }
) {
  // ===== AUTH: Only admins can view audit logs =====
  yield* convexPromise(() => requireAuthAdmin(ctx))

  // Build query with appropriate index based on filters
  // We use a single query builder approach to avoid type incompatibility
  let indexedField: 'adminProfileId' | 'action' | 'targetType' | null = null
  const adminProfileId = args.adminProfileId
  const action = args.action
  const targetType = args.targetType
  const buildQuery = () => {
    if (adminProfileId) {
      indexedField = 'adminProfileId'
      return ctx.db
        .query('adminAuditLogs')
        .withIndex('by_adminProfileId', (q) => q.eq('adminProfileId', adminProfileId))
        .order('desc')
    }
    if (action) {
      indexedField = 'action'
      return ctx.db
        .query('adminAuditLogs')
        .withIndex('by_action', (q) => q.eq('action', action as AuditAction))
        .order('desc')
    }
    if (targetType) {
      indexedField = 'targetType'
      return ctx.db
        .query('adminAuditLogs')
        .withIndex('by_targetType', (q) => q.eq('targetType', targetType as AuditTargetType))
        .order('desc')
    }
    // Default: use creation time index for efficient ordering
    return ctx.db.query('adminAuditLogs').order('desc')
  }

  // Execute query with ordering and cursor-based pagination
  let baseQuery = buildQuery()

  if (adminProfileId && indexedField !== 'adminProfileId') {
    baseQuery = baseQuery.filter((q) => q.eq(q.field('adminProfileId'), adminProfileId))
  }

  if (action && indexedField !== 'action') {
    baseQuery = baseQuery.filter((q) => q.eq(q.field('action'), action))
  }

  if (targetType && indexedField !== 'targetType') {
    baseQuery = baseQuery.filter((q) => q.eq(q.field('targetType'), targetType))
  }

  // Native cursor-based pagination
  const result = yield* convexPromise(() => baseQuery.paginate(args.paginationOpts))

  // Enrich the page with admin names
  const enrichedPage = yield* convexPromise(() =>
    Promise.all(
      result.page.map(async (log) => {
        const adminProfile = await ctx.db.get(log.adminProfileId)
        return {
          ...log,
          adminName: adminProfile?.fullName ?? log.adminEmail,
        }
      })
    )
  )

  return {
    ...result,
    page: enrichedPage,
  }
})

/**
 * List admin audit logs with pagination and filters.
 * Only accessible by ADMINs.
 *
 * Paginación NATIVA de Convex (.paginate + paginationOpts): el cursor
 * artesanal anterior filtraba por `_id` mientras ordenaba por _creationTime,
 * o sea, cursor roto por construcción (los _id de Convex no ordenan por
 * creación). El shape del resultado es { page, isDone, continueCursor } y el
 * cliente consume via usePaginatedQuery.
 */
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    action: v.optional(v.string()),
    targetType: v.optional(v.string()),
    adminProfileId: v.optional(v.id('profiles')),
  },
  handler: (ctx, args) => runConvex(listProgram(ctx, args)),
})

// La tabla de audit logs solo crece (append-only, nunca se borra) — un
// .collect() sin cota trae la tabla entera a memoria en cada dashboard load.
// Cota honesta: pedimos TOTAL_LOGS_CAP + 1 filas via .take() (barato, usa el
// índice implícito by_creation_time) y si llegamos al tope exponemos
// totalLogsCapped=true en vez de sub-contar en silencio.
const TOTAL_LOGS_CAP = 5000

const getStatsProgram = Effect.fn('AdminAuditLogs.getStats')(function* (ctx: QueryCtx) {
  // ===== AUTH: Only admins =====
  yield* convexPromise(() => requireAuthAdmin(ctx))

  // Get counts by action type (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  // Rango sobre el índice implícito by_creation_time: lee SOLO la ventana
  // de 7 días. Un .filter() sin índice escanea la tabla completa (append-only)
  // y descarta en memoria.
  const recentLogs = yield* convexPromise(() =>
    ctx.db
      .query('adminAuditLogs')
      .withIndex('by_creation_time', (q) => q.gte('_creationTime', sevenDaysAgo))
      .collect()
  )

  // Conteo histórico acotado — nunca un .collect() abierto sobre la tabla
  // completa. Si el probe de TOTAL_LOGS_CAP + 1 se llena, el conteo real es
  // >= TOTAL_LOGS_CAP y lo declaramos explícitamente via totalLogsCapped.
  const totalLogsProbe = yield* convexPromise(() =>
    ctx.db.query('adminAuditLogs').take(TOTAL_LOGS_CAP + 1)
  )
  const totalLogsCapped = totalLogsProbe.length > TOTAL_LOGS_CAP
  const totalLogs = totalLogsCapped ? TOTAL_LOGS_CAP : totalLogsProbe.length

  // Count by action category
  const userActions = recentLogs.filter((log) => log.action.startsWith('USER_')).length
  const kycActions = recentLogs.filter((log) => log.action.startsWith('KYC_')).length
  const ndaActions = recentLogs.filter((log) => log.action.startsWith('NDA_')).length

  // Count by admin
  const actionsByAdmin = new Map<string, number>()
  for (const log of recentLogs) {
    actionsByAdmin.set(log.adminEmail, (actionsByAdmin.get(log.adminEmail) ?? 0) + 1)
  }

  return {
    totalLogs,
    totalLogsCapped,
    recentLogs: recentLogs.length,
    byCategory: {
      user: userActions,
      kyc: kycActions,
      nda: ndaActions,
      other: recentLogs.length - userActions - kycActions - ndaActions,
    },
    topAdmins: [...actionsByAdmin.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([email, count]) => ({ email, count })),
  }
})

/**
 * Get audit log stats for dashboard.
 * Only accessible by ADMINs.
 */
export const getStats = query({
  args: {},
  handler: (ctx) => runConvex(getStatsProgram(ctx)),
})
