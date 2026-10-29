// ============================================================================
// SECURITY EVENTS - CONVEX MUTATIONS
// ============================================================================
// Funciones de Convex para registrar y consultar eventos de seguridad.
// Usa la tabla 'securityEvents' definida en schema.ts.
//
// EL DOMINIO SE ESCRIBE UNA VEZ. Los once tipos de evento y las cuatro
// severidades vivían dos veces en este archivo: como `as const` para el
// `ReadonlySet` que valida la entrada interna, y otra vez desplegados a mano
// como `v.literal(...)` en tres registros distintos. Ahora la lista es un
// `Schema.Literals` de `_security/shared.ts` y los `v.union` se construyen
// desde ella con `literalsUnion`, así que agregar un tipo de evento es una
// línea y no cuatro lugares que se pueden olvidar.
// ============================================================================

import { v, type VLiteral, type VUnion } from 'convex/values'
import { Effect } from 'effect'

import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireAuthAdmin } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, runConvex } from './_helpers/effect'
import { notFound } from './_helpers/errors'
import {
  isSecurityEventType,
  isSecuritySeverity,
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
  SecurityEventTypeSchema,
  SecuritySeveritySchema,
  type SecurityEventType,
  type SecuritySeverity,
} from './_security/shared'

// ============================================================================
// TIPOS
// ============================================================================
// El vocabulario vive en `_security/shared.ts` y se reexporta desde acá: el
// navegador lo necesita para `/es/admin/security` y este archivo registra
// funciones de Convex, que no se importan en el navegador (tarjeta OB-RES-3).

export {
  isSecurityEventType,
  isSecuritySeverity,
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
  SecurityEventTypeSchema,
  SecuritySeveritySchema,
  type SecurityEventType,
  type SecuritySeverity,
}

/**
 * El validador de Convex derivado de la misma lista de literales que usa el
 * schema. Una definición, dos consumidores: el codegen sigue viendo un
 * `v.union(v.literal(...))` y el dominio deja de repetirse.
 */
function literalsUnion<T extends readonly [string, ...string[]]>(
  literals: T
): VUnion<T[number], VLiteral<T[number]>[]> {
  const members: VLiteral<T[number]>[] = literals.map((literal) => v.literal(literal as T[number]))
  return v.union(...members)
}

const securityEventTypeValidator = literalsUnion(SECURITY_EVENT_TYPES)
const securitySeverityValidator = literalsUnion(SECURITY_SEVERITIES)

// ============================================================================
// CONFIGURACIÓN DE UMBRALES
// ============================================================================
// Estos valores determinan cuándo un patrón se considera sospechoso.
// Puedes ajustarlos según el comportamiento de tu aplicación.

export const SECURITY_THRESHOLDS = {
  // Login fallido
  FAILED_LOGINS_WARNING: 3, // Warning después de 3 intentos
  FAILED_LOGINS_ALERT: 5, // Alert después de 5 intentos

  // Rate limit
  RATE_LIMIT_WARNING: 3, // Warning después de 3 violaciones
  RATE_LIMIT_ALERT: 10, // Alert después de 10 violaciones

  // Data room
  DATA_ROOM_DOWNLOADS_WARNING: 20, // Warning después de 20 descargas/hora
  DATA_ROOM_DOWNLOADS_ALERT: 50, // Alert después de 50 descargas/hora

  // ES: Entregas TOTALES (vista + descarga) del mismo perfil en la ventana. La
  // ruta de entrega devuelve los MISMOS bytes en ambos casos —solo cambia el
  // header Content-Disposition—, así que contar el presupuesto solo en la rama
  // DOWNLOAD dejaba una salida gratis: pedir la sala entera como VIEW. Con 30
  // grants/min de rate limit eso eran ~1.800 entregas/hora sin una sola señal.
  // EN: total deliveries; VIEW and DOWNLOAD ship identical bytes.
  DATA_ROOM_DELIVERIES_WARNING: 80, // ~1,3 archivos/min sostenido durante una hora
  DATA_ROOM_DELIVERIES_ALERT: 150, // ~2,5/min: ritmo de máquina, no de lectura

  // NDA
  NDA_ACCESS_DENIED_WARNING: 3, // Warning después de 3 intentos denegados
  NDA_ACCESS_DENIED_ALERT: 5, // Alert después de 5 intentos denegados

  // Password reset
  PASSWORD_RESET_WARNING: 3, // Warning después de 3 resets/hora
  PASSWORD_RESET_ALERT: 5, // Alert después de 5 resets/hora
} as const

// Ventanas de tiempo (en milisegundos)
export const SECURITY_WINDOWS = {
  LOGIN_WINDOW_MS: 60 * 60 * 1000, // 1 hora
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000, // 15 minutos
  DATA_ROOM_WINDOW_MS: 60 * 60 * 1000, // 1 hora
  PASSWORD_RESET_WINDOW_MS: 60 * 60 * 1000, // 1 hora
} as const

// ============================================================================
// PROGRAMAS
// ============================================================================

const resolveEvent = Effect.fn('Security.resolveEvent')(function* (
  ctx: MutationCtx,
  args: { eventId: Id<'securityEvents'>; notes?: string }
) {
  // ===== AUTH: Verificar autenticación y rol admin =====
  const { user, profile } = yield* convexPromise(() => requireAuthAdmin(ctx))

  // Verificar que el evento existe
  const event = yield* convexPromise(() => ctx.db.get(args.eventId))
  if (!event) {
    return yield* Effect.fail(notFound('Evento de seguridad', args.eventId))
  }

  yield* convexPromise(() =>
    ctx.db.patch(args.eventId, {
      resolved: true,
      resolvedByProfileId: profile._id,
      resolvedAt: Date.now(),
      resolutionNotes: args.notes,
    })
  )

  // ===== AUDIT: resolver un evento de seguridad es acción admin trazable =====
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'SECURITY_EVENT_RESOLVE',
      targetType: 'SECURITY_EVENT',
      targetId: args.eventId,
      previousValue: { resolved: event.resolved ?? false },
      newValue: { resolved: true },
      notes: args.notes,
    })
  )
})

const recentSecurityEvents = Effect.fn('Security.getRecentEvents')(function* (
  ctx: QueryCtx,
  args: {
    limit?: number
    includeResolved?: boolean
    severity?: SecuritySeverity
    type?: SecurityEventType
  }
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))

  const limit = args.limit || 50
  const includeResolved = args.includeResolved ?? false
  const type = args.type

  // El tipo entra por su índice `by_type`. Cuando el panel lo filtraba en el
  // navegador, un evento de ese tipo más viejo que los 50 traídos quedaba
  // invisible aunque fuera el único de su clase.
  let eventsQuery = type
    ? ctx.db
        .query('securityEvents')
        .withIndex('by_type', (q) => q.eq('type', type))
        .order('desc')
    : ctx.db.query('securityEvents').order('desc')

  // Filtrar por resolved si es necesario
  if (!includeResolved) {
    eventsQuery = eventsQuery.filter((q) => q.eq(q.field('resolved'), false))
  }

  // Filtrar por severidad si se especifica
  if (args.severity) {
    eventsQuery = eventsQuery.filter((q) => q.eq(q.field('severity'), args.severity))
  }

  return yield* convexPromise(() => eventsQuery.take(limit))
})

const securityEventsCounts = Effect.fn('Security.getEventCounts')(function* (ctx: QueryCtx) {
  yield* convexPromise(() => requireAuthAdmin(ctx))

  const unresolvedEvents = yield* convexPromise(() =>
    ctx.db
      .query('securityEvents')
      .withIndex('by_resolved', (q) => q.eq('resolved', false))
      .collect()
  )

  return {
    total: unresolvedEvents.length,
    critical: unresolvedEvents.filter((e) => e.severity === 'CRITICAL').length,
    alert: unresolvedEvents.filter((e) => e.severity === 'ALERT').length,
    warning: unresolvedEvents.filter((e) => e.severity === 'WARNING').length,
    info: unresolvedEvents.filter((e) => e.severity === 'INFO').length,
  }
})

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Marcar un evento como resuelto
 * SEGURIDAD: Solo administradores pueden resolver eventos de seguridad
 */
export const resolveSecurityEvent = mutation({
  args: {
    eventId: v.id('securityEvents'),
    notes: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(resolveEvent(ctx, args)),
})

// ============================================================================
// QUERIES - CONSULTAR EVENTOS
// ============================================================================

/**
 * Obtener eventos de seguridad recientes
 */
export const getRecentSecurityEvents = query({
  args: {
    limit: v.optional(v.number()),
    includeResolved: v.optional(v.boolean()),
    severity: v.optional(securitySeverityValidator),
    type: v.optional(securityEventTypeValidator),
  },
  handler: (ctx, args) => runConvex(recentSecurityEvents(ctx, args)),
})

/**
 * Contar eventos no resueltos por severidad
 * Útil para dashboard de seguridad
 */
export const getSecurityEventsCounts = query({
  args: {},
  handler: (ctx) => runConvex(securityEventsCounts(ctx)),
})
