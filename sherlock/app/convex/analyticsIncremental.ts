// ============================================================================
// ANALYTICS INCREMENTAL
// ============================================================================
// Contadores de `systemStats`. Ningún caller de producción los agenda: el cron
// `reconcile-system-stats` y el `scheduler.runAfter` de `companies.ts` salieron.
// La tabla y este módulo se quedan hasta borrar las filas en prod y en dev.
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import { convexPromise, runConvex } from './_helpers/effect'

// ============================================================================
// INTERNAL MUTATIONS (llamadas desde otras mutations)
// ============================================================================

/**
 * Los contadores que `systemStats` mantiene. `incrementMultipleStats` recibe el
 * nombre como `string` —su validador es contrato con los llamadores y no cambia
 * en esta ola—, así que la lista existe para que el nombre se pueda reconocer en
 * vez de indexar a ciegas un `Record<string, unknown>`.
 */
export const STAT_COUNTERS = ['totalUsers', 'totalCompanies', 'totalAdmins'] as const

export const StatCounterSchema = Schema.Literals(STAT_COUNTERS)
type StatCounter = typeof StatCounterSchema.Type

const STAT_COUNTER_SET: ReadonlySet<string> = new Set(StatCounterSchema.literals)

function isStatCounter(value: string): value is StatCounter {
  return STAT_COUNTER_SET.has(value)
}

/**
 * El valor actual de un contador. Un nombre que no sea de la lista devuelve
 * `undefined` y el incremento arranca desde el delta — exactamente lo que hacía
 * la lectura a ciegas, pero ahora se ve que el nombre es un dato sin validar.
 */
function currentCounter(stats: Doc<'systemStats'>, stat: string): number | undefined {
  if (!isStatCounter(stat)) return undefined
  return stats[stat]
}

// ===== DEFAULT STATS RECORD (used for auto-initialization) =====
// Valores por defecto cuando se crea el registro de stats automáticamente.
// Esto asegura que no perdamos incrementos antes de que reconcileStats se ejecute.
const DEFAULT_STATS_DATA = {
  key: 'global' as const,
  totalUsers: 0,
  totalCompanies: 0,
  totalAdmins: 0,
  lastUpdated: 0, // Will be updated on first increment
}

const globalStats = Effect.fn('Analytics.globalStats')(function* (ctx: QueryCtx) {
  return yield* convexPromise(() =>
    ctx.db
      .query('systemStats')
      .withIndex('by_key', (q) => q.eq('key', 'global'))
      .first()
  )
})

const incrementMultipleStatsProgram = Effect.fn('Analytics.incrementMultipleStats')(function* (
  ctx: MutationCtx,
  args: { updates: Array<{ stat: string; delta: number }> }
) {
  const stats = yield* globalStats(ctx)

  if (stats) {
    // Registro existe - aplicar todos los updates
    const patch: Record<string, number> = { lastUpdated: Date.now() }

    for (const update of args.updates) {
      const currentValue = currentCounter(stats, update.stat)
      const newValue = typeof currentValue === 'number' ? currentValue + update.delta : update.delta
      patch[update.stat] = Math.max(0, newValue)
    }

    yield* convexPromise(() => ctx.db.patch(stats._id, patch))
  } else {
    // ===== AUTO-INICIALIZACIÓN =====
    // El registro no existe todavía. Crear con valores por defecto + todos los updates.
    yield* Effect.logWarning(
      `[analyticsIncremental] Stats record missing, auto-creating with ${args.updates.length} updates.`
    )

    const initialData = { ...DEFAULT_STATS_DATA, lastUpdated: Date.now() }

    // Aplicar todos los updates a los valores iniciales
    for (const update of args.updates) {
      const key = update.stat as keyof typeof initialData
      const currentValue = initialData[key]
      if (typeof currentValue === 'number') {
        ;(initialData as Record<string, number | string>)[key] = Math.max(
          0,
          currentValue + update.delta
        )
      } else {
        // Campo no existe en defaults, crear con el delta
        ;(initialData as Record<string, number | string>)[key] = Math.max(0, update.delta)
      }
    }

    yield* convexPromise(() => ctx.db.insert('systemStats', initialData))
  }
})

/**
 * Incrementar múltiples contadores a la vez.
 * Más eficiente cuando hay que actualizar varios campos.
 *
 * IMPORTANTE: Si el registro global no existe, lo crea automáticamente
 * para evitar pérdida de incrementos antes de que reconcileStats se ejecute.
 */
export const incrementMultipleStats = internalMutation({
  args: {
    updates: v.array(
      v.object({
        stat: v.string(),
        delta: v.number(),
      })
    ),
  },
  handler: (ctx, args) => runConvex(incrementMultipleStatsProgram(ctx, args)),
})

// ============================================================================
// RECONCILIATION - Cron job para asegurar consistencia
// ============================================================================

/**
 * Recalcula los contadores desde las tablas y hace upsert del registro global.
 */
const recomputeGlobalStats = Effect.fn('Analytics.recomputeGlobalStats')(function* (
  ctx: MutationCtx
) {
  // ===== CARGAR DATOS (una vez, como migración/reconciliación) =====
  const profiles = yield* convexPromise(() => ctx.db.query('profiles').collect())

  // ===== CALCULAR CONTADORES =====
  const profileCounts = profiles.reduce(
    (acc, p) => {
      acc.total++
      if (p.role === 'COMPANY') acc.companies++
      else if (p.role === 'ADMIN') acc.admins++
      return acc
    },
    { total: 0, companies: 0, admins: 0 }
  )

  // ===== UPSERT REGISTRO GLOBAL =====
  const existing = yield* globalStats(ctx)

  const statsData = {
    key: 'global' as const,
    totalUsers: profileCounts.total,
    totalCompanies: profileCounts.companies,
    totalAdmins: profileCounts.admins,
    lastUpdated: Date.now(),
  }

  if (existing) {
    yield* convexPromise(() => ctx.db.patch(existing._id, statsData))
  } else {
    yield* convexPromise(() => ctx.db.insert('systemStats', statsData))
  }

  return {
    success: true as const,
    stats: statsData,
  }
})

/**
 * Recalcular todos los contadores desde cero.
 * Se ejecuta semanalmente para corregir cualquier drift.
 * También sirve como migración inicial.
 */
export const reconcileStats = internalMutation({
  args: {},
  handler: (ctx) => runConvex(recomputeGlobalStats(ctx)),
})
