// ============================================================================
// MEDIDOR DE USO CONVEX POR EMPRESA
// ============================================================================
// Cuenta documentos, versiones y bytes de blob por estado, más las filas de
// bitácora que crecen con cada subida y cada lectura. Es el insumo del plan
// de pruning (`docs/plans/2026-09-01-convex-pruning-plan.md`) y el único
// llamador es `scripts/operator/convex-usage.mjs`.
//
// CONTROL DE ACCESO: `internalQuery`, mismo modelo que `operatorActor.ts` y
// `operatorDeliverables.ts`: no hay sesión de navegador; Convex no expone
// internal* al cliente. Solo la deploy key del deployment llega aquí. No
// escribe `adminAuditLogs` (es un medidor, no una acción). A diferencia de
// los carriles que ESCRIBEN, este sí recorre el fleet: el dato que se pidió
// es MB por cliente, y eso no se responde empresa por empresa a ciegas.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import { internalQuery, type QueryCtx } from './_generated/server'
import { convexPromise, runConvex } from './_helpers/effect'

const DAY_MS = 24 * 60 * 60 * 1000

/** Techo de filas de bitácora por lectura. Un `collect()` del historial
 *  (5 años de `documentAccessLogs`) revienta el límite de la query. */
export const LOG_READ_LIMIT = 5000

export type VersionBucket = 'current' | 'superseded' | 'quarantined' | 'other'

const BLOB_PRIORITY: Record<VersionBucket, number> = {
  current: 3,
  quarantined: 2,
  superseded: 1,
  other: 0,
}

export type VersionCounts = Record<VersionBucket, number> & { currentQuarantined: number }

export type BlobBytes = VersionCounts & { total: number }

export type LogAge = {
  count: number
  oldestAt: number | null
  oldestAgeDays: number | null
  countCapped: boolean
}

export type CompanyUsageRow = {
  companyId: Id<'companies'>
  name: string
  documents: number
  versions: VersionCounts
  blobBytes: BlobBytes
  logs: {
    documentAccessLogs: LogAge
    vdrReadAudits: LogAge
    teamAlerts: LogAge
    adminAuditLogs: LogAge
  }
}

export type UsageReport = {
  generatedAt: number
  companies: CompanyUsageRow[]
  total: {
    companies: number
    documents: number
    versions: VersionCounts
    blobBytes: BlobBytes
    logs: CompanyUsageRow['logs']
    // Filas fleet-wide que no se pudieron atribuir a una sala: sin ellas el
    // total no se descompone en la suma de las filas por empresa.
    unattributed: { adminAuditLogs: LogAge; teamAlerts: LogAge }
  }
  notes: string[]
}

const LEGACY_ACCESS_LOG_NOTE =
  'documentAccessLogs sin companyId (filas legacy anteriores al backfill) no entran al recuento por sala: el índice by_companyId_accessedAt no las lista y no hay otro índice viable sin tocar schema.ts.'

function emptyCounts(): VersionCounts {
  return { current: 0, superseded: 0, quarantined: 0, other: 0, currentQuarantined: 0 }
}

function emptyLogAge(): LogAge {
  return { count: 0, oldestAt: null, oldestAgeDays: null, countCapped: false }
}

function resolveLogReadLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return LOG_READ_LIMIT
  }
  return Math.min(Math.floor(requested), LOG_READ_LIMIT)
}

function bucketVersion(
  version: Doc<'documentVersions'>,
  currentVersionId: Id<'documentVersions'> | undefined
): VersionBucket {
  // La subida vigente del cliente manda aunque esté en cuarentena: si no, el
  // reporte manda sus MB a la bolsa podable y muestra cero vigentes.
  if (version._id === currentVersionId) return 'current'
  if (version.verificationStatus === 'QUARANTINED') return 'quarantined'
  if (version.publicationStatus === 'SUPERSEDED' || version.publicationStatus === 'ARCHIVED') {
    return 'superseded'
  }
  if (version.publicationStatus === 'PUBLISHED') return 'current'
  return 'other'
}

function ageOf(timestamps: number[], now: number, countCapped = false): LogAge {
  if (timestamps.length === 0) {
    return { ...emptyLogAge(), countCapped }
  }
  let oldestAt = timestamps[0]!
  for (const ts of timestamps) {
    if (ts < oldestAt) oldestAt = ts
  }
  return {
    count: timestamps.length,
    oldestAt,
    oldestAgeDays: Math.floor((now - oldestAt) / DAY_MS),
    countCapped,
  }
}

function timestampOf(row: { _creationTime?: number }, preferred?: number): number {
  return preferred ?? row._creationTime ?? 0
}

function logAgeFromOldestAndSample<T extends { _creationTime?: number }>(
  oldest: T | null,
  sample: T[],
  pickTs: (row: T) => number | undefined,
  limit: number,
  now: number
): LogAge {
  if (!oldest) return emptyLogAge()
  const oldestAt = timestampOf(oldest, pickTs(oldest))
  return {
    count: sample.length,
    oldestAt,
    oldestAgeDays: Math.floor((now - oldestAt) / DAY_MS),
    countCapped: sample.length >= limit,
  }
}

const companyIdForAudit = Effect.fn('Usage.companyIdForAudit')(function* (
  ctx: QueryCtx,
  log: Doc<'adminAuditLogs'>,
  documentsById: Map<string, Doc<'documents'>>,
  companyIds: Set<string>,
  cache: Map<string, Id<'companies'> | null>
) {
  if (log.targetType === 'COMPANY' && log.targetId && companyIds.has(log.targetId)) {
    return log.targetId as Id<'companies'>
  }
  if (log.targetType === 'DOCUMENT' && log.targetId) {
    return documentsById.get(log.targetId)?.companyId ?? null
  }
  if (!log.targetId) return null

  const cacheKey = `${log.targetType}:${log.targetId}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  let companyId: Id<'companies'> | null = null
  if (log.targetType === 'DELIVERABLE') {
    const row = yield* convexPromise(() => ctx.db.get(log.targetId as Id<'deliverables'>))
    companyId = row?.companyId ?? null
  } else if (log.targetType === 'SUPPORT_THREAD') {
    const thread = yield* convexPromise(() => ctx.db.get(log.targetId as Id<'supportThreads'>))
    if (thread?.scope.kind === 'COMPANY') companyId = thread.scope.companyId
  }

  if (companyId && !companyIds.has(`${companyId}`)) companyId = null
  cache.set(cacheKey, companyId)
  return companyId
})

function accumulateBytes(
  versions: Doc<'documentVersions'>[],
  documents: Doc<'documents'>[],
  currentByDocument: Map<string, Id<'documentVersions'> | undefined>
): { counts: VersionCounts; blobBytes: BlobBytes } {
  const counts = emptyCounts()
  const bestByBlob = new Map<
    string,
    { bucket: VersionBucket; bytes: number; currentQuarantined: boolean }
  >()

  for (const version of versions) {
    const currentVersionId = currentByDocument.get(version.documentId)
    const bucket = bucketVersion(version, currentVersionId)
    counts[bucket] += 1
    const isCurrentQuarantined =
      bucket === 'current' && version.verificationStatus === 'QUARANTINED'
    if (isCurrentQuarantined) counts.currentQuarantined += 1

    const storageId = `${version.storageId}`
    const previous = bestByBlob.get(storageId)
    if (!previous || BLOB_PRIORITY[bucket] > BLOB_PRIORITY[previous.bucket]) {
      bestByBlob.set(storageId, {
        bucket,
        bytes: version.byteSize,
        currentQuarantined: isCurrentQuarantined,
      })
    }
  }

  const documentsWithVersions = new Set(versions.map((version) => `${version.documentId}`))
  for (const document of documents) {
    if (documentsWithVersions.has(`${document._id}`)) continue
    if (!document.storageId) continue
    const storageId = `${document.storageId}`
    const bytes = document.fileSize ?? 0
    const previous = bestByBlob.get(storageId)
    if (!previous || BLOB_PRIORITY.current > BLOB_PRIORITY[previous.bucket]) {
      bestByBlob.set(storageId, { bucket: 'current', bytes, currentQuarantined: false })
    }
  }

  const blobBytes: BlobBytes = { ...emptyCounts(), total: 0 }
  for (const { bucket, bytes, currentQuarantined } of bestByBlob.values()) {
    blobBytes[bucket] += bytes
    blobBytes.total += bytes
    if (currentQuarantined) blobBytes.currentQuarantined += bytes
  }
  return { counts, blobBytes }
}

function addCounts(left: VersionCounts, right: VersionCounts): VersionCounts {
  return {
    current: left.current + right.current,
    superseded: left.superseded + right.superseded,
    quarantined: left.quarantined + right.quarantined,
    other: left.other + right.other,
    currentQuarantined: left.currentQuarantined + right.currentQuarantined,
  }
}

function addBytes(left: BlobBytes, right: BlobBytes): BlobBytes {
  return {
    ...addCounts(left, right),
    total: left.total + right.total,
  }
}

function mergeAge(left: LogAge, right: LogAge, now: number): LogAge {
  const timestamps = [left.oldestAt, right.oldestAt].filter((ts): ts is number => ts !== null)
  const merged = ageOf(timestamps, now, left.countCapped || right.countCapped)
  return { ...merged, count: left.count + right.count }
}

// Las seis lecturas de una sala, en un solo paso con nombre: cuando el medidor
// se cae, el span dice en qué empresa se cayó y no solo «falló el reporte».
const loadCompanyFootprint = Effect.fn('Usage.loadCompanyFootprint')(function* (
  ctx: QueryCtx,
  companyId: Id<'companies'>,
  logReadLimit: number
) {
  return yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('documents')
        .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
        .collect(),
      ctx.db
        .query('documentVersions')
        .withIndex('by_company_createdAt', (q) => q.eq('companyId', companyId))
        .collect(),
      ctx.db
        .query('documentAccessLogs')
        .withIndex('by_companyId_accessedAt', (q) => q.eq('companyId', companyId))
        .order('asc')
        .first(),
      ctx.db
        .query('documentAccessLogs')
        .withIndex('by_companyId_accessedAt', (q) => q.eq('companyId', companyId))
        .take(logReadLimit),
      ctx.db
        .query('vdrReadAudits')
        .withIndex('by_company_occurredAt', (q) => q.eq('companyId', companyId))
        .order('asc')
        .first(),
      ctx.db
        .query('vdrReadAudits')
        .withIndex('by_company_occurredAt', (q) => q.eq('companyId', companyId))
        .take(logReadLimit),
    ])
  )
})

const buildUsageReport = Effect.fn('Usage.buildReport')(function* (
  ctx: QueryCtx,
  logReadLimit: number
) {
  const now = Date.now()
  const companies = yield* convexPromise(() => ctx.db.query('companies').collect())
  const [oldestAlert, alertSample, oldestAudit, auditSample] = yield* convexPromise(() =>
    Promise.all([
      ctx.db.query('teamAlerts').order('asc').first(),
      ctx.db.query('teamAlerts').take(logReadLimit),
      ctx.db.query('adminAuditLogs').order('asc').first(),
      ctx.db.query('adminAuditLogs').take(logReadLimit),
    ])
  )

  const companyIds = new Set(companies.map((company) => `${company._id}`))
  const documentsById = new Map<string, Doc<'documents'>>()
  const documentsByCompany = new Map<string, Doc<'documents'>[]>()
  const versionsByCompany = new Map<string, Doc<'documentVersions'>[]>()
  const currentByDocument = new Map<string, Id<'documentVersions'> | undefined>()
  const accessByCompany = new Map<string, LogAge>()
  const vdrByCompany = new Map<string, LogAge>()

  // `documents` no se consulta nunca sin índice (contrato
  // convex-unbounded-scan-boundary). Las bitácoras de sala van por companyId
  // con `.first()` + `.take(LIMIT)`: un collect() del historial de 5 años
  // revienta el techo de lectura de la query.
  for (const company of companies) {
    const key = `${company._id}`
    const [docs, versions, oldestAccess, accessSample, oldestVdr, vdrSample] =
      yield* loadCompanyFootprint(ctx, company._id, logReadLimit)
    documentsByCompany.set(key, docs)
    versionsByCompany.set(key, versions)
    accessByCompany.set(
      key,
      logAgeFromOldestAndSample(
        oldestAccess,
        accessSample,
        (log) => log.accessedAt,
        logReadLimit,
        now
      )
    )
    vdrByCompany.set(
      key,
      logAgeFromOldestAndSample(oldestVdr, vdrSample, (log) => log.occurredAt, logReadLimit, now)
    )
    for (const document of docs) {
      documentsById.set(`${document._id}`, document)
      currentByDocument.set(`${document._id}`, document.currentVersionId)
    }
  }

  const alertsCapped = alertSample.length >= logReadLimit
  const alertsByCompany = new Map<string, number[]>()
  const unattributedAlerts: number[] = []
  for (const alert of alertSample) {
    const ts = timestampOf(alert, alert.openedAt)
    // `teamAlerts.companyId` es opcional (schema): un aviso sin sala no puede
    // desaparecer del total, va al bucket no atribuido.
    if (!alert.companyId || !companyIds.has(`${alert.companyId}`)) {
      unattributedAlerts.push(ts)
      continue
    }
    const list = alertsByCompany.get(`${alert.companyId}`) ?? []
    list.push(ts)
    alertsByCompany.set(`${alert.companyId}`, list)
  }
  const unattributedAlertAge = ageOf(unattributedAlerts, now, alertsCapped)
  const fleetAlertAge = logAgeFromOldestAndSample(
    oldestAlert,
    alertSample,
    (alert) => alert.openedAt,
    logReadLimit,
    now
  )

  const auditCache = new Map<string, Id<'companies'> | null>()
  const auditsByCompany = new Map<string, number[]>()
  const unattributedAudits: number[] = []
  for (const log of auditSample) {
    const companyId = yield* companyIdForAudit(ctx, log, documentsById, companyIds, auditCache)
    const ts = timestampOf(log)
    if (!companyId) {
      unattributedAudits.push(ts)
      continue
    }
    const list = auditsByCompany.get(`${companyId}`) ?? []
    list.push(ts)
    auditsByCompany.set(`${companyId}`, list)
  }
  const auditsCapped = auditSample.length >= logReadLimit
  const unattributedAuditAge = ageOf(unattributedAudits, now, auditsCapped)
  const fleetAuditAge = logAgeFromOldestAndSample(
    oldestAudit,
    auditSample,
    (log) => log._creationTime,
    logReadLimit,
    now
  )

  const rows: CompanyUsageRow[] = companies
    .map((company) => {
      const key = `${company._id}`
      const docs = documentsByCompany.get(key) ?? []
      const { counts, blobBytes } = accumulateBytes(
        versionsByCompany.get(key) ?? [],
        docs,
        currentByDocument
      )
      return {
        companyId: company._id,
        name: company.name,
        documents: docs.length,
        versions: counts,
        blobBytes,
        logs: {
          documentAccessLogs: accessByCompany.get(key) ?? emptyLogAge(),
          vdrReadAudits: vdrByCompany.get(key) ?? emptyLogAge(),
          teamAlerts: ageOf(alertsByCompany.get(key) ?? [], now, alertsCapped),
          adminAuditLogs: ageOf(auditsByCompany.get(key) ?? [], now, auditsCapped),
        },
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))

  const totalVersions = rows.reduce((acc, row) => addCounts(acc, row.versions), emptyCounts())
  const totalBytes = rows.reduce((acc, row) => addBytes(acc, row.blobBytes), {
    ...emptyCounts(),
    total: 0,
  } as BlobBytes)
  return {
    generatedAt: now,
    companies: rows,
    total: {
      companies: rows.length,
      documents: rows.reduce((n, row) => n + row.documents, 0),
      versions: totalVersions,
      blobBytes: totalBytes,
      logs: {
        documentAccessLogs: rows.reduce(
          (acc, row) => mergeAge(acc, row.logs.documentAccessLogs, now),
          emptyLogAge()
        ),
        vdrReadAudits: rows.reduce(
          (acc, row) => mergeAge(acc, row.logs.vdrReadAudits, now),
          emptyLogAge()
        ),
        teamAlerts: fleetAlertAge,
        adminAuditLogs: fleetAuditAge,
      },
      unattributed: {
        adminAuditLogs: unattributedAuditAge,
        teamAlerts: unattributedAlertAge,
      },
    },
    notes: [LEGACY_ACCESS_LOG_NOTE],
  } satisfies UsageReport
})

export const getUsageByCompany = internalQuery({
  args: {
    logReadLimit: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<UsageReport> =>
    runConvex(buildUsageReport(ctx, resolveLogReadLimit(args.logReadLimit))),
})
