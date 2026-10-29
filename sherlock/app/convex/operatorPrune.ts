// ============================================================================
// REPORTE DE PODA DE CONVEX (dry-run)
// ============================================================================
// Convex Starter da 1 GB de storage y 1 GB de egress de archivos al mes. Prod
// hoy pesa ~20 MB con una sala; el riesgo no es el número de hoy sino llegar al
// primer cliente sin saber qué se podría podar. Este módulo CUENTA candidatos y
// escribe una fila `pruneReports`. **No borra nada.** El borrado real vive
// detrás de `deleteDocumentsHard` (a mano, ids explícitos) y llegará como
// corrida `execute` en un PR aparte, con su propio flag exact-true.
//
// CONTROL DE ACCESO: `internalMutation`, mismo modelo que `operatorPurge.ts` y
// `operatorUsage.ts`: Convex no expone `internal*` al cliente y solo la deploy
// key del deployment llega aquí. No recibe ids del llamador, así que no hay
// oráculo de existencia que exponer.
//
// AUDITORÍA: la fila `pruneReports` ES el registro. El cron corre sin sesión y
// sin perfil ADMIN al cual atribuir la escritura, y `logAdminAction` exige uno;
// firmar un dry-run semanal con el perfil de un humano falsearía la bitácora
// del equipo y la inundaría con corridas que no hicieron nada.
//
// Reglas y números: `docs/plans/2026-09-01-convex-pruning-plan.md` §3 y §4.
// ============================================================================

import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { storageHasLiveOwner } from './_documents/purge'
import { convexPromise, runConvex } from './_helpers/effect'

const DAY_MS = 24 * 60 * 60 * 1000

/** Filas leídas por categoría. El reporte marca `capped` cuando toca el techo:
 *  un conteo capado es un piso, no el total. */
export const PRUNE_SCAN_LIMIT = 500

/** [F] 2026-09-01: 90 días de holgura para `restoreVersion` (a menos, un
 *  restore cae en `BLOB_MISSING`). La otra mitad de esa decisión — conservar
 *  las últimas 3 SUPERSEDED por documento — es un PISO DE BORRADO y no vive
 *  aquí: aplicado al reporte escondería el caso que motivó el carril (v1
 *  SUPERSEDED + v2 PUBLISHED, los 38.8 MB del 2026-08-31), porque una única
 *  SUPERSEDED siempre está entre las últimas 3. Un reporte que oculta
 *  candidatos no informa la decisión; el piso protege cuando algo se borra,
 *  y este módulo no borra. Ver plan §3. */
export const SUPERSEDED_RETENTION_MS = 90 * DAY_MS

/** Una cuarentena que sigue siendo la vigente del documento es la subida del
 *  cliente y nunca es candidata; las demás caducan a los 7 días. */
export const QUARANTINE_RETENTION_MS = 7 * DAY_MS

/** Intents terminales y grants vencidos: mismo mes que ya usa
 *  `_purgeExpiredGrants` (`EXPIRED_GRANT_RETENTION_MS`). */
export const TERMINAL_ROW_RETENTION_MS = 30 * DAY_MS

/** Un blob recién subido todavía puede no tener fila: el intent la escribe
 *  después de que el navegador sube los bytes. Sin este piso, el reporte
 *  llamaría huérfana a toda subida en vuelo. */
export const ORPHAN_BLOB_MIN_AGE_MS = DAY_MS

const VDR_INTENT_TERMINAL_STATUSES = ['EXPIRED', 'ABORTED', 'REJECTED'] as const
const INTAKE_INTENT_TERMINAL_STATUSES = ['EXPIRED', 'REJECTED'] as const
const ASSET_INTENT_TERMINAL_STATUSES = ['EXPIRED', 'REJECTED'] as const

export type PruneCategoryKey =
  | 'SUPERSEDED_VERSIONS'
  | 'ORPHAN_BLOBS'
  | 'EXPIRED_UPLOAD_INTENTS'
  | 'STALE_QUARANTINE'
  | 'EXPIRED_GRANTS'

export type PruneCategory = {
  key: PruneCategoryKey
  candidates: number
  bytes: number
  oldestAgeDays: number | null
  capped: boolean
}

export type PruneReport = {
  generatedAt: number
  mode: 'DRY_RUN'
  categories: PruneCategory[]
  totals: { candidates: number; bytes: number }
  scanLimit: number
}

/** Acumulador de una categoría. `bytes` solo suma blobs únicos: dos versiones
 *  que comparten `storageId` (un restore) liberan un GB, no dos. */
class CategoryTally {
  private readonly blobs = new Set<string>()
  private rows = 0
  private bytes = 0
  private oldestAt: number | null = null
  private capped = false

  constructor(private readonly key: PruneCategoryKey) {}

  add(options: { createdAt: number; storageId?: string; bytes?: number }): void {
    this.rows += 1
    if (this.oldestAt === null || options.createdAt < this.oldestAt) {
      this.oldestAt = options.createdAt
    }
    if (options.storageId === undefined || this.blobs.has(options.storageId)) return
    this.blobs.add(options.storageId)
    this.bytes += options.bytes ?? 0
  }

  markCapped(): void {
    this.capped = true
  }

  toCategory(now: number): PruneCategory {
    return {
      key: this.key,
      candidates: this.rows,
      bytes: this.bytes,
      oldestAgeDays:
        this.oldestAt === null ? null : Math.max(0, Math.floor((now - this.oldestAt) / DAY_MS)),
      capped: this.capped,
    }
  }
}

const hasLiveGrant = Effect.fn('Prune.hasLiveGrant')(function* (
  ctx: MutationCtx,
  documentId: Id<'documents'>,
  versionId: Id<'documentVersions'>,
  now: number
) {
  const grants = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_documentId', (q) => q.eq('documentId', documentId))
      .take(PRUNE_SCAN_LIMIT)
  )
  return grants.some(
    (grant) =>
      grant.documentVersionId === versionId && grant.revokedAt == null && grant.expiresAt > now
  )
})

const tallyVersions = Effect.fn('Prune.tallyVersions')(function* (
  ctx: MutationCtx,
  now: number,
  superseded: CategoryTally,
  quarantine: CategoryTally
) {
  const companies = yield* convexPromise(() => ctx.db.query('companies').take(PRUNE_SCAN_LIMIT))

  for (const company of companies) {
    const [documents, versions, holds] = yield* convexPromise(() =>
      Promise.all([
        ctx.db
          .query('documents')
          .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
          .take(PRUNE_SCAN_LIMIT),
        ctx.db
          .query('documentVersions')
          .withIndex('by_company_createdAt', (q) => q.eq('companyId', company._id))
          .take(PRUNE_SCAN_LIMIT),
        ctx.db
          .query('documentLegalHolds')
          .withIndex('by_company_status', (q) =>
            q.eq('companyId', company._id).eq('status', 'ACTIVE')
          )
          .take(PRUNE_SCAN_LIMIT),
      ])
    )
    if (documents.length >= PRUNE_SCAN_LIMIT || versions.length >= PRUNE_SCAN_LIMIT) {
      superseded.markCapped()
      quarantine.markCapped()
    }

    const heldDocumentIds = new Set(holds.map((hold) => `${hold.documentId}`))
    const versionsByDocument = new Map<string, Doc<'documentVersions'>[]>()
    for (const version of versions) {
      const key = `${version.documentId}`
      versionsByDocument.set(key, [...(versionsByDocument.get(key) ?? []), version])
    }

    for (const document of documents) {
      if (heldDocumentIds.has(`${document._id}`)) continue
      const siblings = versionsByDocument.get(`${document._id}`) ?? []
      // "Vigente" es la fila PUBLISHED que hoy sirve bytes, no el puntero:
      // documentos legacy no tienen `publishedVersionId` y aun así publican.
      const hasLivePublished = siblings.some(
        (version) =>
          version.publicationStatus === 'PUBLISHED' ||
          version._id === document.publishedVersionId ||
          version._id === document.currentVersionId
      )
      for (const version of siblings) {
        if (version._id === document.currentVersionId) continue
        if (version._id === document.publishedVersionId) continue

        const ageMs = now - version.createdAt
        const stored = yield* convexPromise(() => ctx.db.system.get(version.storageId))

        if (version.verificationStatus === 'QUARANTINED') {
          if (ageMs <= QUARANTINE_RETENTION_MS) continue
          if (yield* hasLiveGrant(ctx, document._id, version._id, now)) continue
          quarantine.add({
            createdAt: version.createdAt,
            storageId: stored ? `${version.storageId}` : undefined,
            bytes: stored?.size ?? version.byteSize,
          })
          continue
        }

        if (version.publicationStatus !== 'SUPERSEDED') continue
        if (!hasLivePublished) continue
        if (ageMs <= SUPERSEDED_RETENTION_MS) continue
        if (!stored) continue
        if (yield* hasLiveGrant(ctx, document._id, version._id, now)) continue
        // Un restore deja la PUBLISHED vigente sobre el mismo blob: podar la
        // fila SUPERSEDED no libera nada y borrar el blob rompería la vigente.
        const shared = yield* convexPromise(() =>
          storageHasLiveOwner(ctx, version.storageId, {
            ignoreVersionIds: new Set([`${version._id}`]),
          })
        )
        if (shared) continue

        superseded.add({
          createdAt: version.createdAt,
          storageId: `${version.storageId}`,
          // `_storage.size` es lo que factura el plan; `byteSize` es lo que la
          // versión declaró al subir. Se prefiere el primero.
          bytes: stored.size,
        })
      }
    }
  }
})

const tallyOrphanBlobs = Effect.fn('Prune.tallyOrphanBlobs')(function* (
  ctx: MutationCtx,
  now: number,
  orphans: CategoryTally
) {
  const blobs = yield* convexPromise(() => ctx.db.system.query('_storage').take(PRUNE_SCAN_LIMIT))
  if (blobs.length >= PRUNE_SCAN_LIMIT) orphans.markCapped()

  for (const blob of blobs) {
    if (now - blob._creationTime < ORPHAN_BLOB_MIN_AGE_MS) continue
    if (yield* convexPromise(() => storageHasLiveOwner(ctx, blob._id))) continue
    orphans.add({
      createdAt: blob._creationTime,
      storageId: `${blob._id}`,
      bytes: blob.size,
    })
  }
})

const tallyExpiredIntents = Effect.fn('Prune.tallyExpiredIntents')(function* (
  ctx: MutationCtx,
  now: number,
  intents: CategoryTally
) {
  const cutoff = now - TERMINAL_ROW_RETENTION_MS

  for (const status of VDR_INTENT_TERMINAL_STATUSES) {
    const rows = yield* convexPromise(() =>
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', status).lt('expiresAt', cutoff))
        .take(PRUNE_SCAN_LIMIT)
    )
    if (rows.length >= PRUNE_SCAN_LIMIT) intents.markCapped()
    for (const row of rows) {
      const stored = yield* convexPromise(() =>
        row.storageId ? ctx.db.system.get(row.storageId) : Promise.resolve(null)
      )
      intents.add({
        createdAt: row.createdAt,
        storageId: stored ? `${row.storageId}` : undefined,
        bytes: stored?.size ?? row.declaredByteSize,
      })
    }
  }

  for (const status of INTAKE_INTENT_TERMINAL_STATUSES) {
    const rows = yield* convexPromise(() =>
      ctx.db
        .query('intakeUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', status).lt('expiresAt', cutoff))
        .take(PRUNE_SCAN_LIMIT)
    )
    if (rows.length >= PRUNE_SCAN_LIMIT) intents.markCapped()
    for (const row of rows) {
      const stored = yield* convexPromise(() =>
        row.storageId ? ctx.db.system.get(row.storageId) : Promise.resolve(null)
      )
      intents.add({
        createdAt: row.createdAt,
        storageId: stored ? `${row.storageId}` : undefined,
        bytes: stored?.size ?? row.declaredByteSize,
      })
    }
  }

  for (const status of ASSET_INTENT_TERMINAL_STATUSES) {
    const rows = yield* convexPromise(() =>
      ctx.db
        .query('assetUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', status).lt('expiresAt', cutoff))
        .take(PRUNE_SCAN_LIMIT)
    )
    if (rows.length >= PRUNE_SCAN_LIMIT) intents.markCapped()
    for (const row of rows) {
      const stored = yield* convexPromise(() =>
        row.storageId ? ctx.db.system.get(row.storageId) : Promise.resolve(null)
      )
      intents.add({
        createdAt: row.createdAt,
        storageId: stored ? `${row.storageId}` : undefined,
        bytes: stored?.size ?? row.declaredByteSize,
      })
    }
  }
})

const tallyExpiredGrants = Effect.fn('Prune.tallyExpiredGrants')(function* (
  ctx: MutationCtx,
  now: number,
  grants: CategoryTally
) {
  // Cota inferior obligatoria: `undefined` ordena antes que cualquier número,
  // así que un `lt(cutoff)` a secas barrería filas sin `expiresAt`.
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_expiresAt', (q) =>
        q.gte('expiresAt', 0).lt('expiresAt', now - TERMINAL_ROW_RETENTION_MS)
      )
      .take(PRUNE_SCAN_LIMIT)
  )
  if (rows.length >= PRUNE_SCAN_LIMIT) grants.markCapped()
  // Solo filas: un grant no guarda bytes, y contarlos como ahorro de storage
  // inventaría MB que no existen.
  for (const row of rows) grants.add({ createdAt: row.createdAt })
})

// Las cuatro categorías se cuentan en orden y cada una lleva su nombre de span:
// un reporte que se cae a mitad ya no deja «falló la poda», deja cuál de los
// cuatro recorridos falló.
const pruneDryRunProgram = Effect.fn('Prune.dryRun')(function* (ctx: MutationCtx) {
  const now = Date.now()
  const superseded = new CategoryTally('SUPERSEDED_VERSIONS')
  const quarantine = new CategoryTally('STALE_QUARANTINE')
  const orphans = new CategoryTally('ORPHAN_BLOBS')
  const intents = new CategoryTally('EXPIRED_UPLOAD_INTENTS')
  const grants = new CategoryTally('EXPIRED_GRANTS')

  yield* tallyVersions(ctx, now, superseded, quarantine)
  yield* tallyOrphanBlobs(ctx, now, orphans)
  yield* tallyExpiredIntents(ctx, now, intents)
  yield* tallyExpiredGrants(ctx, now, grants)

  const categories = [superseded, orphans, intents, quarantine, grants].map((tally) =>
    tally.toCategory(now)
  )
  const totals = categories.reduce(
    (acc, category) => ({
      candidates: acc.candidates + category.candidates,
      bytes: acc.bytes + category.bytes,
    }),
    { candidates: 0, bytes: 0 }
  )

  const report: PruneReport = {
    generatedAt: now,
    mode: 'DRY_RUN',
    categories,
    totals,
    scanLimit: PRUNE_SCAN_LIMIT,
  }
  yield* convexPromise(() => ctx.db.insert('pruneReports', report))
  return report
})

export const pruneDryRun = internalMutation({
  args: {},
  handler: (ctx): Promise<PruneReport> => runConvex(pruneDryRunProgram(ctx)),
})
