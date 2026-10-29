// ============================================================================
// WEBHOOK EVENTS - Idempotencia y Auditoría
// ============================================================================
// Funciones para registrar y verificar webhooks procesados.
// CRÍTICO para evitar duplicación de créditos/suscripciones.
//
// PATRÓN DE USO:
// 1. registerEvent() - busca y reclama el evento en una sola mutation
// 2. Si isNew es false y el status devuelto es "failed" o "received" → el
//    claim de reintento es de este request: hay que reprocesar. "received"
//    también es un "processing" cuyo claim venció el lease. Cada claim lleva
//    una versión; un request anterior no puede aplicar efectos ni errores.
//    WorkOS exige un nuevo intento mientras el claim siga en processing;
//    completed y skipped sí se confirman sin volver a procesar.
// 3. Si isNew es true → la fila queda con status "processing"
// 4. WorkOS aplica el efecto y deja completed o skipped en UNA mutation,
//    después de registerEvent. markFailed() solo cambia un processing cuyo
//    claim sigue vigente; una respuesta perdida no revierte un completed.
//
// El invariante que sostiene todo esto es de ORDEN: la fila se registra ANTES
// de que el efecto externo ocurra. `registerEvent` no lo delega ni lo reordena:
// lee, reclama y escribe dentro de una sola mutation, que Convex serializa.
// ============================================================================

import { v, type VLiteral } from 'convex/values'
import { Effect, Schema } from 'effect'

import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireAuthAdmin } from './_helpers/auth'
import { convexPromise, runConvex } from './_helpers/effect'
import { invalidState } from './_helpers/errors'
import { clampLimit } from './_helpers/limits'

// ===== TIPOS =====
// La lista se escribe una vez. El tipo que exportamos y el validador que Convex
// verifica en la frontera salen los dos de ella, así que ya no pueden divergir:
// antes eran un `type` y un `v.union` escritos a mano, uno al lado del otro.
function literalValidator<const L extends readonly [string, string, ...Array<string>]>(
  schema: Schema.Literals<L>
) {
  const members: Array<VLiteral<L[number]>> = schema.literals.map((literal) => v.literal(literal))
  return v.union(...members)
}

const WebhookProviders = Schema.Literals([
  'clerk',
  'lemonsqueezy',
  'workos',
  'stripe_identity',
  'checkout',
])
const WebhookStatuses = Schema.Literals([
  'received',
  'processing',
  'completed',
  'failed',
  'skipped',
])
const WebhookErrorCodes = Schema.Literals([
  'VALIDATION_ERROR',
  'SIGNATURE_VERIFICATION_FAILED',
  'INTERNAL_ERROR',
])

export type WebhookProvider = typeof WebhookProviders.Type
export type WebhookStatus = typeof WebhookStatuses.Type
export type WebhookErrorCode = typeof WebhookErrorCodes.Type

const webhookProviderValidator = literalValidator(WebhookProviders)
const webhookStatusValidator = literalValidator(WebhookStatuses)
const webhookErrorCodeValidator = literalValidator(WebhookErrorCodes)

// Ventana en la que un `processing` sigue siendo del request en vuelo.
// `POST /api/webhooks/workos` no exporta `maxDuration` y `vercel.json` no
// define `functions.maxDuration`. Con Fluid Compute (default de Vercel) el
// plan Pro corta una función sin tope propio a los 300s; 800s y 1800s solo
// aplican si la ruta o el dashboard los configuran, y aquí no están.
// El claim se escribe en registerEvent, después de verificar la firma, y
// Vercel mide la duración desde el inicio de la invocación. A los 300s del
// claim la invocación ya murió. Docs leídos 2026-09-22:
// https://vercel.com/docs/functions/configuring-functions/duration
export const WEBHOOK_PROCESSING_LEASE_MS = 300_000

// ===== REDACCIÓN DEL PAYLOAD =====
// El payload se guarda para depurar la entrega (qué evento llegó y con qué
// forma), no para conservar a la persona. Una lista negra de claves se queda
// corta (WorkOS también manda `name`, `username`, `emails[].value`,
// `raw_attributes` en Directory Sync), así que la regla es al revés: solo
// sobreviven en claro los valores bajo claves técnicas (ids, tipos, estados,
// fechas); todo lo demás se tapa a cualquier profundidad y la clave queda para
// que la forma siga siendo legible.
const TECHNICAL_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'object',
  'event',
  'type',
  'state',
  'status',
  'primary',
  'email_verified',
  'created_at',
  'updated_at',
  'organization_id',
  'organization_membership_id',
  'directory_id',
  'connection_id',
  'environment_id',
  'idp_id',
  'user_id',
  'slug',
])
const REDACTED_PAYLOAD_VALUE = '[redacted]'
const PayloadObject = Schema.Record(Schema.String, Schema.Unknown)
const isPayloadObject = Schema.is(PayloadObject)

function redactWebhookPayload(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactWebhookPayload(item, key))
  if (isPayloadObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        redactWebhookPayload(nested, nestedKey),
      ])
    )
  }
  if (value === null || value === undefined) return value
  return key !== undefined && TECHNICAL_PAYLOAD_KEYS.has(key) ? value : REDACTED_PAYLOAD_VALUE
}

// ============================================================================
// IDEMPOTENCY CHECK
// ============================================================================

const findEvent = Effect.fn('WebhookEvents.findEvent')(function* (
  ctx: QueryCtx | MutationCtx,
  args: { provider: WebhookProvider; eventId: string }
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('webhookEvents')
      .withIndex('by_provider_eventId', (q) =>
        q.eq('provider', args.provider).eq('eventId', args.eventId)
      )
      .unique()
  )
})

// ============================================================================
// REGISTRO DE EVENTOS
// ============================================================================

const registerEventProgram = Effect.fn('WebhookEvents.registerEvent')(function* (
  ctx: MutationCtx,
  args: {
    provider: WebhookProvider
    eventId: string
    eventType: string
    payload?: unknown
    requestId?: string
    correlationId?: string
    ipAddress?: string
    userAgent?: string
  }
) {
  // ===== VERIFICAR IDEMPOTENCIA =====
  // `Date.now()` en una mutation es el timestamp de la transacción.
  const now = Date.now()
  const existing = yield* findEvent(ctx, args)

  if (existing) {
    // CLAIM ATÓMICO DE REINTENTO: las mutations de Convex se serializan. El
    // primer retry que vea failed, received, o un processing con el claim
    // vencido, mueve la fila a processing dentro de esta misma transacción
    // y refresca `receivedAt` (el reloj del claim). El retry siguiente ya ve
    // processing dentro del lease y el caller lo descarta. Sin este patch,
    // dos retries aplicaban el efecto externo.
    const claimExpired =
      existing.status === 'processing' && now - existing.receivedAt > WEBHOOK_PROCESSING_LEASE_MS
    if (existing.provider === 'workos' && existing.status === 'processing' && !claimExpired) {
      // No confirmar una entrega todavía pendiente, también durante un rollout
      // en el que el handler anterior no puede guardar el fallo con claimVersion.
      return yield* Effect.fail(invalidState('El webhook de WorkOS sigue en proceso'))
    }
    const claimed = existing.status === 'failed' || existing.status === 'received' || claimExpired
    const claimVersion = (existing.claimVersion ?? 0) + (claimed ? 1 : 0)
    if (claimed) {
      yield* convexPromise(() =>
        ctx.db.patch(existing._id, {
          status: 'processing',
          claimVersion,
          receivedAt: now,
          processedAt: undefined,
          error: undefined,
          errorCode: undefined,
          result: undefined,
        })
      )
    }

    // Se devuelve el status PREVIO, salvo el processing vencido: ese status
    // no es reintentable para el caller. Se informa como `received` para que
    // el request que ganó el claim reprocese. Un claim vencido no demuestra
    // que el efecto no se haya aplicado; los siguientes, dentro del lease,
    // reciben `processing`.
    const status = claimExpired ? 'received' : existing.status
    return {
      isNew: false,
      eventId: existing._id,
      claimVersion,
      status,
      message: claimExpired
        ? `Evento ${args.eventId} con claim vencido; se vuelve a procesar`
        : `Evento ${args.eventId} ya procesado con status: ${existing.status}`,
    }
  }

  // ===== CREAR NUEVO EVENTO =====
  const newEventId = yield* convexPromise(() =>
    ctx.db.insert('webhookEvents', {
      provider: args.provider,
      eventId: args.eventId,
      eventType: args.eventType,
      status: 'processing',
      claimVersion: 1,
      payload: redactWebhookPayload(args.payload),
      receivedAt: now,
      requestId: args.requestId,
      correlationId: args.correlationId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    })
  )

  return {
    isNew: true,
    eventId: newEventId,
    claimVersion: 1,
    status: 'processing' as const,
    message: 'Evento registrado, procesando...',
  }
})

/**
 * Registra un nuevo evento de webhook.
 * Retorna el ID del evento o null si ya existe (duplicado).
 *
 * PATRÓN: Usar esto al INICIO del procesamiento del webhook.
 */
export const registerEvent = internalMutation({
  args: {
    provider: webhookProviderValidator,
    eventId: v.string(),
    eventType: v.string(),
    payload: v.optional(v.any()),
    requestId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(registerEventProgram(ctx, args)),
})

export const markCompletedProgram = Effect.fn('WebhookEvents.markCompleted')(function* (
  ctx: MutationCtx,
  args: {
    eventId: Id<'webhookEvents'>
    action?: string
    resourceId?: string
    details?: string
  }
) {
  yield* convexPromise(() =>
    ctx.db.patch(args.eventId, {
      status: 'completed',
      processedAt: Date.now(),
      result: {
        action: args.action,
        resourceId: args.resourceId,
        details: args.details,
      },
    })
  )
})

/**
 * Marca un evento como completado exitosamente.
 */
export const markCompleted = internalMutation({
  args: {
    eventId: v.id('webhookEvents'),
    action: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    details: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(markCompletedProgram(ctx, args)),
})

const markFailedProgram = Effect.fn('WebhookEvents.markFailed')(function* (
  ctx: MutationCtx,
  args: {
    eventId: Id<'webhookEvents'>
    error: string
    errorCode?: WebhookErrorCode
    errorContext?: unknown
    claimVersion?: number
  }
) {
  const event = yield* convexPromise(() => ctx.db.get(args.eventId))
  if (!event || event.status !== 'processing') return
  if (event.provider === 'workos' && (event.claimVersion ?? 0) !== args.claimVersion) return
  yield* convexPromise(() =>
    ctx.db.patch(args.eventId, {
      status: 'failed',
      processedAt: Date.now(),
      error: args.error,
      errorCode: args.errorCode,
      result: args.errorContext ? { details: JSON.stringify(args.errorContext) } : undefined,
    })
  )
})

/**
 * Marca un evento como fallido.
 */
export const markFailed = internalMutation({
  args: {
    eventId: v.id('webhookEvents'),
    error: v.string(),
    errorCode: v.optional(webhookErrorCodeValidator),
    errorContext: v.optional(v.any()),
    claimVersion: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(markFailedProgram(ctx, args)),
})

export const markSkippedProgram = Effect.fn('WebhookEvents.markSkipped')(function* (
  ctx: MutationCtx,
  args: { eventId: Id<'webhookEvents'>; reason?: string; errorCode?: WebhookErrorCode }
) {
  yield* convexPromise(() =>
    ctx.db.patch(args.eventId, {
      status: 'skipped',
      processedAt: Date.now(),
      errorCode: args.errorCode,
      result: {
        details: args.reason || 'Evento ignorado',
      },
    })
  )
})

/**
 * Marca un evento como ignorado (no relevante).
 */
export const markSkipped = internalMutation({
  args: {
    eventId: v.id('webhookEvents'),
    reason: v.optional(v.string()),
    errorCode: v.optional(webhookErrorCodeValidator),
  },
  handler: (ctx, args) => runConvex(markSkippedProgram(ctx, args)),
})

// ============================================================================
// QUERIES PARA ADMIN/DEBUG
// ============================================================================

const RECENT_EVENTS_LIMIT = { fallback: 50, max: 200 } as const
const STATS_HOURS_BACK = { fallback: 24, max: 30 * 24 } as const

// El panel ve el rastro de la entrega, nunca el `payload`: aunque se redacta
// al persistir, sigue siendo el cuerpo crudo de un tercero y no hace falta
// para diagnosticar (proveedor, tipo, estado, error, ids de correlación).
function projectWebhookEvent(event: Doc<'webhookEvents'>) {
  return {
    _id: event._id,
    _creationTime: event._creationTime,
    provider: event.provider,
    eventId: event.eventId,
    eventType: event.eventType,
    status: event.status,
    result: event.result,
    error: event.error,
    errorCode: event.errorCode,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
    requestId: event.requestId,
    correlationId: event.correlationId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
  }
}

const getRecentEventsProgram = Effect.fn('WebhookEvents.getRecentEvents')(function* (
  ctx: QueryCtx,
  args: { provider?: WebhookProvider; status?: WebhookStatus; limit?: number }
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))

  const limit = clampLimit(args.limit, RECENT_EVENTS_LIMIT)
  const { provider, status } = args

  // Cada filtro tiene su índice. Con los dos, `by_provider` acota el rango y
  // el `status` se filtra en la base, así que la página vuelve completa: el
  // `take(limit * 2)` en memoria de antes devolvía menos de `limit` en cuanto
  // el filtro era selectivo.
  const events = yield* convexPromise(() => {
    if (provider !== undefined) {
      const byProvider = ctx.db
        .query('webhookEvents')
        .withIndex('by_provider', (q) => q.eq('provider', provider))
      const scoped =
        status === undefined
          ? byProvider
          : byProvider.filter((q) => q.eq(q.field('status'), status))
      return scoped.order('desc').take(limit)
    }
    if (status !== undefined) {
      return ctx.db
        .query('webhookEvents')
        .withIndex('by_status', (q) => q.eq('status', status))
        .order('desc')
        .take(limit)
    }
    return ctx.db.query('webhookEvents').order('desc').take(limit)
  })

  return events.map(projectWebhookEvent)
})

/**
 * Obtener eventos recientes (para dashboard admin).
 */
export const getRecentEvents = query({
  args: {
    provider: v.optional(webhookProviderValidator),
    status: v.optional(webhookStatusValidator),
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(getRecentEventsProgram(ctx, args)),
})

const getStatsProgram = Effect.fn('WebhookEvents.getStats')(function* (
  ctx: QueryCtx,
  args: { hoursBack?: number }
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))

  const hoursBack = clampLimit(args.hoursBack, STATS_HOURS_BACK)
  const since = Date.now() - hoursBack * 60 * 60 * 1000

  // ===== OPTIMIZADO: Usar índice en lugar de full scan =====
  const recentEvents = yield* convexPromise(() =>
    ctx.db
      .query('webhookEvents')
      .withIndex('by_receivedAt', (q) => q.gt('receivedAt', since))
      .collect()
  )

  // Contar por status
  const byStatusCounts = new Map<string, number>()
  for (const event of recentEvents) {
    byStatusCounts.set(event.status, (byStatusCounts.get(event.status) ?? 0) + 1)
  }
  const byStatus = Object.fromEntries(byStatusCounts)

  // Contar por provider
  const byProviderCounts = new Map<string, number>()
  for (const event of recentEvents) {
    byProviderCounts.set(event.provider, (byProviderCounts.get(event.provider) ?? 0) + 1)
  }
  const byProvider = Object.fromEntries(byProviderCounts)

  return {
    total: recentEvents.length,
    byStatus,
    byProvider,
    hoursBack,
  }
})

/**
 * Obtener estadísticas de webhooks (para monitoreo).
 *
 * OPTIMIZACIÓN: Usa índice by_receivedAt en lugar de full scan + filter.
 */
export const getStats = query({
  args: {
    hoursBack: v.optional(v.number()), // Default: 24 horas
  },
  handler: (ctx, args) => runConvex(getStatsProgram(ctx, args)),
})
