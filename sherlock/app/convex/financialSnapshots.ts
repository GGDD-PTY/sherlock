import { v, type Infer } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { loadDeliverablePublishedVersion } from './_documents/deliverableVersion'
import { logAdminAction } from './_helpers/auditLog'
import { requireAuth } from './_helpers/auth'
import {
  requireCompanyManagementAuthorization,
  resolveCurrentCompanyAuthorization,
} from './_helpers/companyAuthorization'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { notFound, unauthorized, validationFailed } from './_helpers/errors'

const MAX_METRICS = 24
const MAX_PERIOD_LENGTH = 40
const MAX_REVIEW_NOTE_LENGTH = 1_000
const MAX_LOCATOR_LENGTH = 120
const MAX_PAGE_NUMBER = 100_000
const PERIOD_END_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const metricNameValidator = v.union(
  v.literal('REVENUE'),
  v.literal('EBITDA'),
  v.literal('NET_INCOME'),
  v.literal('TOTAL_ASSETS'),
  v.literal('TOTAL_DEBT'),
  v.literal('CASH')
)

const currencyValidator = v.union(
  v.literal('USD'),
  v.literal('PAB'),
  v.literal('EUR'),
  v.literal('MXN'),
  v.literal('COP'),
  v.literal('PEN'),
  v.literal('CLP'),
  v.literal('ARS'),
  v.literal('CRC'),
  v.literal('GTQ')
)

const locatorValidator = v.union(
  v.object({ kind: v.literal('PAGE'), page: v.number() }),
  v.object({ kind: v.literal('CELL'), sheet: v.string(), range: v.string() })
)

const financialMetricValidator = v.object({
  metric: metricNameValidator,
  period: v.string(),
  periodEnd: v.string(),
  value: v.number(),
  currency: currencyValidator,
  source: v.object({
    documentId: v.id('documents'),
    versionId: v.id('documentVersions'),
    locator: locatorValidator,
  }),
})

type FinancialMetric = Infer<typeof financialMetricValidator>
type ReadyMetric = {
  metric: FinancialMetric['metric']
  period: string
  periodEnd: string
  value: number
  currency: FinancialMetric['currency']
  source: {
    documentId: Id<'documents'>
    versionId: Id<'documentVersions'>
    documentName: string
    versionNumber: number
    locator: FinancialMetric['source']['locator']
  }
}

type StaleReason =
  'SOURCE_MISSING' | 'SOURCE_NOT_CENTRAL' | 'SOURCE_NOT_DELIVERABLE' | 'SOURCE_VERSION_CHANGED'
type SnapshotResponse =
  | {
      status: 'READY'
      publishedAt: number
      reviewedBy: 'Equipo de Sherlock'
      reviewNote: string
      metrics: ReadyMetric[]
    }
  | { status: 'STALE'; publishedAt: number; reason: StaleReason }

type PublishArgs = {
  companyId: Id<'companies'>
  operatorProfileId: Id<'profiles'>
  confirmCompanyName: string
  reviewNote: string
  metrics: FinancialMetric[]
}

// Las validaciones de forma siguen siendo síncronas y siguen lanzando: son
// invariantes de entrada, no efectos. Entran al programa por `convexSync`, que
// es lo que las pone en el canal de error de Effect en vez de dejarlas como una
// excepción suelta.

function requireBoundedText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw validationFailed(`${field} es obligatorio.`, field)
  if (trimmed.length > maxLength) {
    throw validationFailed(`${field} no puede exceder ${maxLength} caracteres.`, field)
  }
  return trimmed
}

function requirePeriodEnd(value: string, index: number): string {
  const field = `metrics[${index}].periodEnd`
  if (!PERIOD_END_PATTERN.test(value)) {
    throw validationFailed(`${field} debe usar el formato YYYY-MM-DD.`, 'metrics')
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw validationFailed(`${field} debe ser una fecha válida.`, 'metrics')
  }
  return value
}

function normalizeMetrics(metrics: FinancialMetric[]): FinancialMetric[] {
  if (metrics.length === 0 || metrics.length > MAX_METRICS) {
    throw validationFailed(`metrics debe contener entre 1 y ${MAX_METRICS} métricas.`, 'metrics')
  }

  const metricDates = new Set<string>()
  const normalized = metrics.map<FinancialMetric>((metric, index) => {
    const period = requireBoundedText(metric.period, `metrics[${index}].period`, MAX_PERIOD_LENGTH)
    const periodEnd = requirePeriodEnd(metric.periodEnd, index)
    if (!Number.isFinite(metric.value)) {
      throw validationFailed(`metrics[${index}].value debe ser un número finito.`, 'metrics')
    }

    const metricDate = `${metric.metric}\u0000${metric.currency}\u0000${periodEnd}`
    if (metricDates.has(metricDate)) {
      throw validationFailed(
        `metrics contiene más de un valor ${metric.metric} ${metric.currency} con fecha ${periodEnd}.`,
        'metrics'
      )
    }
    metricDates.add(metricDate)

    if (metric.source.locator.kind === 'PAGE') {
      const { page } = metric.source.locator
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) {
        throw validationFailed(
          `metrics[${index}].source.locator.page debe ser un entero entre 1 y ${MAX_PAGE_NUMBER}.`,
          'metrics'
        )
      }
      return {
        metric: metric.metric,
        period,
        periodEnd,
        value: metric.value,
        currency: metric.currency,
        source: {
          documentId: metric.source.documentId,
          versionId: metric.source.versionId,
          locator: { kind: 'PAGE', page },
        },
      }
    }

    const sheet = requireBoundedText(
      metric.source.locator.sheet,
      `metrics[${index}].source.locator.sheet`,
      MAX_LOCATOR_LENGTH
    )
    const range = requireBoundedText(
      metric.source.locator.range,
      `metrics[${index}].source.locator.range`,
      MAX_LOCATOR_LENGTH
    )
    return {
      metric: metric.metric,
      period,
      periodEnd,
      value: metric.value,
      currency: metric.currency,
      source: {
        documentId: metric.source.documentId,
        versionId: metric.source.versionId,
        locator: { kind: 'CELL', sheet, range },
      },
    }
  })

  return normalized.sort(
    (left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) ||
      left.metric.localeCompare(right.metric) ||
      left.currency.localeCompare(right.currency) ||
      left.period.localeCompare(right.period)
  )
}

/**
 * Cada métrica publicada tiene que apuntar a la versión entregable vigente de un
 * documento de la sala central de la empresa confirmada. El primer incumplimiento
 * corta la publicación entera: un resumen a medias es peor que ninguno.
 */
const requireCurrentSources = Effect.fn('FinancialSnapshots.requireCurrentSources')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  metrics: FinancialMetric[],
  now: number
) {
  for (const [index, metric] of metrics.entries()) {
    const document = yield* convexPromise(() => ctx.db.get(metric.source.documentId))
    if (!document || document.companyId !== companyId) {
      return yield* Effect.fail(
        validationFailed(
          `La fuente de metrics[${index}] no pertenece a la empresa confirmada.`,
          'metrics'
        )
      )
    }
    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document, now))
    if (!version || version._id !== metric.source.versionId) {
      return yield* Effect.fail(
        validationFailed(
          `La versión fuente de metrics[${index}] no es la versión vigente entregable del documento.`,
          'metrics'
        )
      )
    }
  }
})

/**
 * La proyección de lectura. Una sola fuente vencida vuelve STALE el resumen
 * entero y ninguna métrica sale: el cliente no puede ver una cifra cuyo respaldo
 * ya no existe.
 */
const projectSnapshot = Effect.fn('FinancialSnapshots.projectSnapshot')(function* (
  ctx: QueryCtx,
  snapshot: Doc<'financialSnapshots'>,
  now: number
): Effect.fn.Return<SnapshotResponse, AppError> {
  const metrics: ReadyMetric[] = []
  for (const metric of snapshot.metrics) {
    const document = yield* convexPromise(() => ctx.db.get(metric.source.documentId))
    if (!document || document.companyId !== snapshot.companyId) {
      return { status: 'STALE', publishedAt: snapshot.publishedAt, reason: 'SOURCE_MISSING' }
    }
    const sourceVersionChanged =
      document.currentVersionId !== metric.source.versionId ||
      document.publishedVersionId !== metric.source.versionId
    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document, now))
    if (sourceVersionChanged || (version && version._id !== metric.source.versionId)) {
      return {
        status: 'STALE',
        publishedAt: snapshot.publishedAt,
        reason: 'SOURCE_VERSION_CHANGED',
      }
    }
    if (!version) {
      return {
        status: 'STALE',
        publishedAt: snapshot.publishedAt,
        reason: 'SOURCE_NOT_DELIVERABLE',
      }
    }

    metrics.push({
      metric: metric.metric,
      period: metric.period,
      periodEnd: metric.periodEnd,
      value: metric.value,
      currency: metric.currency,
      source: {
        documentId: document._id,
        versionId: version._id,
        documentName: document.name,
        versionNumber: version.versionNumber,
        locator: metric.source.locator,
      },
    })
  }

  return {
    status: 'READY',
    publishedAt: snapshot.publishedAt,
    reviewedBy: 'Equipo de Sherlock',
    reviewNote: snapshot.reviewNote,
    metrics,
  }
})

const publishSnapshot = Effect.fn('FinancialSnapshots.publish')(function* (
  ctx: MutationCtx,
  args: PublishArgs
) {
  const operator = yield* convexPromise(() => ctx.db.get(args.operatorProfileId))
  if (!operator || operator.role !== 'ADMIN') {
    return yield* Effect.fail(
      validationFailed('operatorProfileId debe identificar un perfil ADMIN real.')
    )
  }
  if (operator.isActive === false) {
    return yield* Effect.fail(validationFailed('El perfil ADMIN operador debe estar activo.'))
  }
  const operatorUser = yield* convexPromise(() => ctx.db.get(operator.userId))
  if (!operatorUser) {
    return yield* Effect.fail(notFound('Usuario del operador ADMIN', `${operator.userId}`))
  }

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Company', args.companyId))
  if (args.confirmCompanyName !== company.name) {
    return yield* Effect.fail(
      validationFailed(
        `confirmCompanyName no coincide con el nombre de la empresa. Escribe exactamente: ${company.name}`
      )
    )
  }

  const reviewNote = yield* convexSync(() =>
    requireBoundedText(args.reviewNote, 'reviewNote', MAX_REVIEW_NOTE_LENGTH)
  )
  const metrics = yield* convexSync(() => normalizeMetrics(args.metrics))
  const publishedAt = Date.now()
  yield* requireCurrentSources(ctx, company._id, metrics, publishedAt)

  const existing = yield* convexPromise(() =>
    ctx.db
      .query('financialSnapshots')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .first()
  )
  const previousSnapshot = existing
    ? {
        financialSnapshot: {
          publishedAt: existing.publishedAt,
          metricCount: existing.metrics.length,
        },
      }
    : undefined
  const snapshot = {
    companyId: company._id,
    publishedAt,
    reviewedByProfileId: operator._id,
    reviewNote,
    metrics,
  }

  let snapshotId: Id<'financialSnapshots'>
  if (existing) {
    yield* convexPromise(() => ctx.db.replace(existing._id, snapshot))
    snapshotId = existing._id
  } else {
    snapshotId = yield* convexPromise(() => ctx.db.insert('financialSnapshots', snapshot))
  }

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: operator._id,
      adminEmail: operatorUser.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      previousValue: previousSnapshot,
      newValue: {
        financialSnapshot: {
          publishedAt,
          metricCount: metrics.length,
          sourceDocumentCount: new Set(metrics.map((metric) => `${metric.source.documentId}`)).size,
        },
      },
      notes: reviewNote,
    })
  )

  return {
    snapshotId,
    companyId: company._id,
    publishedAt,
    metricCount: metrics.length,
    replaced: existing !== null,
  }
})

const getSnapshotForCompany = Effect.fn('FinancialSnapshots.getForCompany')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
): Effect.fn.Return<SnapshotResponse | null, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const companyAuthorization =
    auth.profile.role === 'ADMIN'
      ? null
      : yield* convexPromise(() => resolveCurrentCompanyAuthorization(ctx, auth))
  const company =
    auth.profile.role === 'ADMIN'
      ? yield* convexPromise(() => ctx.db.get(args.companyId))
      : (companyAuthorization?.company ?? null)

  if (
    auth.profile.role !== 'ADMIN' &&
    (companyAuthorization?.access !== 'MANAGE' || company?._id !== args.companyId)
  ) {
    return yield* Effect.fail(unauthorized('No tienes permiso para abrir este data room'))
  }
  if (!company) return yield* Effect.fail(notFound('Company', args.companyId))

  // El rol ADMIN se decidió antes de cargar el id elegido. La comprobación
  // posterior conserva el vínculo de identidad vigente del admin.
  if (auth.profile.role === 'ADMIN') {
    yield* convexPromise(() => requireCompanyManagementAuthorization(ctx, auth, company))
  }

  const snapshot = yield* convexPromise(() =>
    ctx.db
      .query('financialSnapshots')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .first()
  )
  return snapshot ? yield* projectSnapshot(ctx, snapshot, Date.now()) : null
})

export const publish = internalMutation({
  args: {
    companyId: v.id('companies'),
    operatorProfileId: v.id('profiles'),
    confirmCompanyName: v.string(),
    reviewNote: v.string(),
    metrics: v.array(financialMetricValidator),
  },
  handler: (ctx, args) => runConvex(publishSnapshot(ctx, args)),
})

export const getForCompany = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args): Promise<SnapshotResponse | null> =>
    runConvex(getSnapshotForCompany(ctx, args)),
})
