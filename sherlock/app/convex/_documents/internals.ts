import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { SECURITY_THRESHOLDS, SECURITY_WINDOWS } from '../security'

const EXPIRED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const EXPIRED_GRANT_PURGE_BATCH_SIZE = 500
const DOCUMENT_EXPIRY_BATCH_SIZE = 25
const DOCUMENT_GRANT_REVOCATION_BATCH_SIZE = 100

/**
 * Piso de purga (gate del backlog). El cron de purga estuvo muerto por una ref
 * rota, así que se acumularon grants long-expired cuya provenance de acceso
 * puede seguir siendo útil para auditoría. Para evitar que la reactivación
 * barra ese backlog de golpe, la purga NO corre a menos que se configure
 * explícitamente el env `GRANT_PURGE_FLOOR_MS` (epoch ms):
 *   - unset / vacío / inválido → no se purga nada (default seguro, cron inerte)
 *   - una fecha (p.ej. la de hoy) → protege todo lo expirado ANTES de esa fecha
 *     (el backlog histórico) y purga solo grants que expiren de ahí en adelante,
 *     una vez pasada la retención de 30 días
 *   - 0 → drena todo el backlog aplicando la retención normal de 30 días
 * Solo se eliminan grants con expiresAt en el rango [floor, now − 30d).
 */
export function resolvePurgeFloorMs(): number | null {
  const raw = process.env.GRANT_PURGE_FLOOR_MS
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * ES: Dedupe de alarmas por (usuario, tipo), acotado por índice y por take(1).
 * La invariante de estas mutations es "como máximo un evento sin resolver de
 * este tipo, POR SEVERIDAD, por usuario y por ventana", así que el evento MÁS
 * RECIENTE responde la pregunta completa. Antes se hacía `.collect()` de todos
 * los eventos sin resolver del usuario para filtrarlos en JS.
 * Delta consciente: si un operador RESOLVIÓ el evento hace diez minutos y el
 * usuario sigue extrayendo, ahora entra uno nuevo. Es la dirección correcta de
 * fallo: informar de nuevo, no callar.
 * EN: bounded (user, type) dedupe — the newest event answers the question.
 */
const BULK_EVENT_DEDUPE_LOOKBACK = 1

// Los dos llamadores están en este archivo y ya vienen tipados: no hay frontera
// que decodificar, así que un schema sería un valor muerto.
type BulkEventType = 'DATA_ROOM_BULK_DOWNLOAD' | 'DATA_ROOM_BULK_ACCESS'

/**
 * ES: El dedupe ignoraba la severidad, así que el primer WARNING de la ventana
 * silenciaba el ALERT que venía detrás durante una hora entera. Con el techo de
 * 30 grants/minuto, el WARNING de 80 entregas cae cerca de t+2,7 min y el ALERT
 * de 150 cerca de t+5 min: la consola del operador se quedaba mostrando "80
 * entregas" mientras salían ~1.800, y nada nuevo podía entrar hasta ~t+62 min.
 * El salto 80→150 es mucho más ancho que el 20→50 de descargas, así que el
 * mismo defecto muerde más fuerte del lado de entregas.
 * Regla: se salta solo cuando el evento vigente tiene severidad IGUAL o MAYOR.
 * Escalar siempre pasa; degradar nunca agrega ruido. El tope sigue siendo de dos
 * eventos por ventana (WARNING y luego ALERT), porque una vez insertado el
 * ALERT él pasa a ser el más reciente.
 * EN: escalation breaks the dedupe; same-or-lower severity still collapses.
 *
 * La tabla está tipada por la severidad REAL del schema, así que ya no lleva un
 * `?? 0` de respaldo: ese default silencioso trataba cualquier severidad que la
 * tabla no listara como INFO, la más baja, y por tanto nunca deduplicaba.
 */
const BULK_EVENT_SEVERITY_RANK: Readonly<Record<Doc<'securityEvents'>['severity'], number>> = {
  INFO: 0,
  WARNING: 1,
  ALERT: 2,
  CRITICAL: 3,
}

const hasRecentBulkEvent = Effect.fn('DocumentSecurity.hasRecentBulkEvent')(function* (
  ctx: { db: MutationCtx['db'] },
  userId: Id<'users'>,
  type: BulkEventType,
  severity: 'WARNING' | 'ALERT',
  now = Date.now()
) {
  const [latest] = yield* convexPromise(() =>
    ctx.db
      .query('securityEvents')
      .withIndex('by_userId_type', (q) => q.eq('userId', userId).eq('type', type))
      .order('desc')
      .take(BULK_EVENT_DEDUPE_LOOKBACK)
  )

  if (!latest || latest.resolved) return false
  if (latest._creationTime < now - SECURITY_WINDOWS.DATA_ROOM_WINDOW_MS) return false

  return BULK_EVENT_SEVERITY_RANK[latest.severity] >= BULK_EVENT_SEVERITY_RANK[severity]
})

type BulkDownloadEventArgs = {
  userId: Id<'users'>
  userEmail: string
  profileId: Id<'profiles'>
  ipAddress?: string
  downloadCount: number
  severity: 'WARNING' | 'ALERT'
  companyId: Id<'companies'>
}

const logBulkDownloadEventProgram = Effect.fn('DocumentSecurity.logBulkDownload')(function* (
  ctx: MutationCtx,
  args: BulkDownloadEventArgs
) {
  const duplicate = yield* hasRecentBulkEvent(
    ctx,
    args.userId,
    'DATA_ROOM_BULK_DOWNLOAD',
    args.severity
  )
  if (duplicate) {
    yield* Effect.log(`[SECURITY] Skipping duplicate bulk download event for user ${args.userId}`)
    return
  }

  yield* convexPromise(() =>
    ctx.db.insert('securityEvents', {
      type: 'DATA_ROOM_BULK_DOWNLOAD',
      severity: args.severity,
      userId: args.userId,
      userEmail: args.userEmail,
      ipAddress: args.ipAddress,
      details: {
        downloadCount: args.downloadCount,
        companyId: args.companyId,
        profileId: args.profileId,
        threshold:
          args.severity === 'ALERT'
            ? SECURITY_THRESHOLDS.DATA_ROOM_DOWNLOADS_ALERT
            : SECURITY_THRESHOLDS.DATA_ROOM_DOWNLOADS_WARNING,
        windowMs: SECURITY_WINDOWS.DATA_ROOM_WINDOW_MS,
      },
      resolved: false,
    })
  )

  yield* Effect.log(
    `[SECURITY] Bulk download ${args.severity} for user ${args.userId}: ${args.downloadCount} downloads`
  )
})

export const _logBulkDownloadEvent = internalMutation({
  args: {
    userId: v.id('users'),
    userEmail: v.string(),
    profileId: v.id('profiles'),
    ipAddress: v.optional(v.string()),
    downloadCount: v.number(),
    severity: v.union(v.literal('WARNING'), v.literal('ALERT')),
    companyId: v.id('companies'),
  },
  handler: (ctx, args) => runConvex(logBulkDownloadEventProgram(ctx, args)),
})

type BulkAccessEventArgs = {
  userId: Id<'users'>
  userEmail: string
  profileId: Id<'profiles'>
  ipAddress?: string
  deliveryCount: number
  viewCount: number
  downloadCount: number
  distinctDocuments: number
  severity: 'WARNING' | 'ALERT'
  companyId: Id<'companies'>
}

/**
 * ES: Extracción masiva del data room contando ENTREGAS totales: una vista y una
 * descarga sacan exactamente los mismos bytes de la sala, así que el presupuesto
 * de material entregado tiene que sumarlas. Alarma independiente de la de
 * descargas —umbral propio, dedupe propio— para que la línea estricta de 50
 * descargas siga siendo precisa y hojear no la ensucie.
 * EN: total-delivery alarm; independent thresholds and dedupe.
 */
const logBulkAccessEventProgram = Effect.fn('DocumentSecurity.logBulkAccess')(function* (
  ctx: MutationCtx,
  args: BulkAccessEventArgs
) {
  const duplicate = yield* hasRecentBulkEvent(
    ctx,
    args.userId,
    'DATA_ROOM_BULK_ACCESS',
    args.severity
  )
  if (duplicate) {
    yield* Effect.log(`[SECURITY] Skipping duplicate bulk access event for user ${args.userId}`)
    return
  }

  yield* convexPromise(() =>
    ctx.db.insert('securityEvents', {
      type: 'DATA_ROOM_BULK_ACCESS',
      severity: args.severity,
      userId: args.userId,
      userEmail: args.userEmail,
      ipAddress: args.ipAddress,
      details: {
        // El split es la parte accionable: 150 vistas con 0 descargas es un
        // patrón distinto de 75 y 75, y ninguno se ve en la alarma de descargas.
        deliveryCount: args.deliveryCount,
        viewCount: args.viewCount,
        downloadCount: args.downloadCount,
        distinctDocuments: args.distinctDocuments,
        companyId: args.companyId,
        profileId: args.profileId,
        threshold:
          args.severity === 'ALERT'
            ? SECURITY_THRESHOLDS.DATA_ROOM_DELIVERIES_ALERT
            : SECURITY_THRESHOLDS.DATA_ROOM_DELIVERIES_WARNING,
        windowMs: SECURITY_WINDOWS.DATA_ROOM_WINDOW_MS,
        countedActions: 'VIEW+DOWNLOAD',
      },
      resolved: false,
    })
  )

  yield* Effect.log(
    `[SECURITY] Bulk data room access ${args.severity} for user ${args.userId}: ${args.deliveryCount} deliveries (${args.viewCount} views, ${args.downloadCount} downloads)`
  )
})

export const _logBulkAccessEvent = internalMutation({
  args: {
    userId: v.id('users'),
    userEmail: v.string(),
    profileId: v.id('profiles'),
    ipAddress: v.optional(v.string()),
    deliveryCount: v.number(),
    viewCount: v.number(),
    downloadCount: v.number(),
    distinctDocuments: v.number(),
    severity: v.union(v.literal('WARNING'), v.literal('ALERT')),
    companyId: v.id('companies'),
  },
  handler: (ctx, args) => runConvex(logBulkAccessEventProgram(ctx, args)),
})

const markExpiredDocumentsProgram = Effect.fn('DocumentCron.markExpired')(function* (
  ctx: MutationCtx
): Effect.fn.Return<{ markedCount: number; isDone: boolean }, AppError> {
  const now = Date.now()
  const [legacyActiveDocuments, explicitActiveDocuments] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('documents')
        .withIndex('by_isExpired_expiresAt', (q) =>
          q.eq('isExpired', undefined).gte('expiresAt', 0).lt('expiresAt', now)
        )
        .take(DOCUMENT_EXPIRY_BATCH_SIZE),
      ctx.db
        .query('documents')
        .withIndex('by_isExpired_expiresAt', (q) =>
          q.eq('isExpired', false).gte('expiresAt', 0).lt('expiresAt', now)
        )
        .take(DOCUMENT_EXPIRY_BATCH_SIZE),
    ])
  )
  const expiredDocs = [...legacyActiveDocuments, ...explicitActiveDocuments]
    .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
    .slice(0, DOCUMENT_EXPIRY_BATCH_SIZE)

  for (const document of expiredDocs) {
    yield* convexPromise(() => ctx.db.patch(document._id, { isExpired: true }))
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.documents._revokeDocumentGrantsBatch, {
        documentId: document._id,
        reason: 'DOCUMENT_EXPIRED',
        revokedAt: now,
      })
    )
  }

  if (expiredDocs.length > 0) {
    yield* Effect.log(`[CRON] Marked ${expiredDocs.length} documents as expired`)
  }

  const isDone = expiredDocs.length < DOCUMENT_EXPIRY_BATCH_SIZE
  if (!isDone) {
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.documents._markExpiredDocuments, {})
    )
  }

  return { markedCount: expiredDocs.length, isDone }
})

export const _markExpiredDocuments = internalMutation({
  args: {},
  handler: (ctx) => runConvex(markExpiredDocumentsProgram(ctx)),
})

type RevokeGrantsBatchArgs = {
  documentId: Id<'documents'>
  reason: string
  revokedAt: number
}

const revokeDocumentGrantsBatchProgram = Effect.fn('DocumentCron.revokeGrantsBatch')(function* (
  ctx: MutationCtx,
  args: RevokeGrantsBatchArgs
): Effect.fn.Return<{ revokedCount: number; isDone: boolean }, AppError> {
  const grants = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_documentId_revokedAt_expiresAt', (q) =>
        q
          .eq('documentId', args.documentId)
          .eq('revokedAt', undefined)
          .gt('expiresAt', args.revokedAt)
      )
      .take(DOCUMENT_GRANT_REVOCATION_BATCH_SIZE)
  )

  for (const grant of grants) {
    yield* convexPromise(() =>
      ctx.db.patch(grant._id, {
        revokedAt: args.revokedAt,
        outcome: args.reason,
      })
    )
  }

  const isDone = grants.length < DOCUMENT_GRANT_REVOCATION_BATCH_SIZE
  if (!isDone) {
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.documents._revokeDocumentGrantsBatch, args)
    )
  }

  return { revokedCount: grants.length, isDone }
})

export const _revokeDocumentGrantsBatch = internalMutation({
  args: {
    documentId: v.id('documents'),
    reason: v.string(),
    revokedAt: v.number(),
  },
  handler: (ctx, args) => runConvex(revokeDocumentGrantsBatchProgram(ctx, args)),
})

const purgeExpiredGrantsProgram = Effect.fn('DocumentCron.purgeExpiredGrants')(function* (
  ctx: MutationCtx
) {
  const floor = resolvePurgeFloorMs()
  if (floor === null) {
    // Gate: sin GRANT_PURGE_FLOOR_MS configurado no se purga nada — protege el
    // backlog acumulado hasta que se habilite la purga de forma deliberada.
    return { purgedCount: 0, skipped: true as const }
  }

  const cutoff = Date.now() - EXPIRED_GRANT_RETENTION_MS
  const expiredGrants = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_expiresAt', (q) => q.gte('expiresAt', floor).lt('expiresAt', cutoff))
      .take(EXPIRED_GRANT_PURGE_BATCH_SIZE)
  )

  for (const grant of expiredGrants) {
    yield* convexPromise(() => ctx.db.delete(grant._id))
  }

  return { purgedCount: expiredGrants.length }
})

export const _purgeExpiredGrants = internalMutation({
  args: {},
  handler: (ctx) => runConvex(purgeExpiredGrantsProgram(ctx)),
})

/** Filas por lote: acotado para no chocar con el techo por transacción. */
const ACCESS_LOG_BACKFILL_BATCH = 200

/**
 * Backfill de `companyId` en `documentAccessLogs`.
 *
 * Toda fila escrita antes de la denormalización queda FUERA del rango con
 * companyId del índice `by_companyId_accessedAt`, así que es invisible para la
 * vista de actividad — en silencio. Un emisor que ve "0 descargas" sobre un
 * documento que sí se descargó la semana pasada no vuelve a confiar en la
 * pantalla.
 *
 * Nadie lo invocaba automáticamente (dependía de un run manual desde el
 * dashboard), así que ahora tiene runner propio: un cron diario lo dispara y la
 * primera lectura es el guard — Convex indexa los documentos con el campo
 * AUSENTE bajo `eq(campo, undefined)`, de modo que cuando el backlog llega a
 * cero el run diario cuesta una sola lectura vacía. Es idempotente (cada fila
 * parchada sale del rango `undefined`) y se auto-encadena por lotes hasta
 * agotar el backlog en el mismo día del deploy.
 *
 * Filas huérfanas (documento borrado) no tienen sala que asignar: se dejan tal
 * cual y, para no re-encadenar sobre un lote que ya no avanza, el encadenado
 * exige progreso (`patched > 0`) además de lote lleno.
 */
const backfillAccessLogCompanyIdProgram = Effect.fn('DocumentCron.backfillAccessLogCompanyId')(
  function* (
    ctx: MutationCtx
  ): Effect.fn.Return<{ patched: number; remaining: number; isDone: boolean }, AppError> {
    const missing = yield* convexPromise(() =>
      ctx.db
        .query('documentAccessLogs')
        .withIndex('by_companyId_accessedAt', (q) => q.eq('companyId', undefined))
        .take(ACCESS_LOG_BACKFILL_BATCH)
    )

    let patched = 0
    for (const log of missing) {
      const document = yield* convexPromise(() => ctx.db.get(log.documentId))
      if (!document) continue
      yield* convexPromise(() => ctx.db.patch(log._id, { companyId: document.companyId }))
      patched += 1
    }

    const isDone = missing.length < ACCESS_LOG_BACKFILL_BATCH || patched === 0
    if (!isDone) {
      yield* convexPromise(() =>
        ctx.scheduler.runAfter(0, internal.documents._backfillAccessLogCompanyId, {})
      )
    }

    return { patched, remaining: missing.length, isDone }
  }
)

export const _backfillAccessLogCompanyId = internalMutation({
  args: {},
  handler: (ctx) => runConvex(backfillAccessLogCompanyIdProgram(ctx)),
})
