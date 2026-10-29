import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import { query, type QueryCtx } from '../_generated/server'
// `requireAuth` se cruza por `convexPromise` en vez de usar `requireAuthEffect`:
// las suites de estas queries reemplazan `_helpers/auth` entero con `vi.mock`,
// así que el nombre importado es parte del contrato.
import { requireAuth } from '../_helpers/auth'
import { mapExistingDocs } from '../_helpers/batch'
import { convexPromise, runConvex } from '../_helpers/effect'
import { clampLimit } from '../_helpers/limits'
import { adminRequired, notFound, unauthorized } from '../_helpers/errors'
import { requireCompanyReadAuthorization } from '../_helpers/companyAuthorization'
import {
  assertDocumentAccessEffect,
  getCompanyDocumentsEffect,
  loadCompanyOrThrowEffect,
  projectCompanyMemberDocumentIndex,
  requireCompanyOwnerOrAdminEffect,
  projectCompanyOwnerDocument,
} from './shared'
import { buildRoomActivity, type ResolvedCounterparty } from './activity'

/** Techo duro de filas leídas por la vista de actividad de la sala. */
const ROOM_ACTIVITY_SCAN_CAP = 500
/** Perfiles distintos a los que se les resuelve identidad en una corrida. */
const ROOM_ACTIVITY_COUNTERPARTY_CAP = 60
const ROOM_ACTIVITY_DEFAULT_WINDOW_DAYS = 30
const ROOM_ACTIVITY_MAX_WINDOW_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

function clampWindowDays(windowDays?: number): number {
  if (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays <= 0) {
    return ROOM_ACTIVITY_DEFAULT_WINDOW_DAYS
  }

  return Math.min(Math.floor(windowDays), ROOM_ACTIVITY_MAX_WINDOW_DAYS)
}

const getProgram = Effect.fn('Documents.get')(function* (
  ctx: QueryCtx,
  args: { documentId: Id<'documents'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) return null

  yield* assertDocumentAccessEffect(ctx, auth, document)
  // Proyección por lista blanca (`convex/AGENTS.md:8`): la fila cruda trae
  // storageId/storagePath, que ningún consumidor de esta query lee hoy.
  return projectCompanyMemberDocumentIndex(document)
})

export const get = query({
  args: { documentId: v.id('documents') },
  handler: (ctx, args) => runConvex(getProgram(ctx, args)),
})

const listVersionsProgram = Effect.fn('Documents.listVersions')(function* (
  ctx: QueryCtx,
  args: { documentId: Id<'documents'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { profile } = auth
  const denied = 'No tienes permiso para ver el historial de este documento.'
  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) {
    return yield* Effect.fail(
      profile.role === 'ADMIN' ? notFound('Documento', args.documentId) : unauthorized(denied)
    )
  }
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) return yield* Effect.fail(unauthorized(denied))
  yield* requireCompanyOwnerOrAdminEffect(ctx, auth, company, denied)

  const versions = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_document_version', (q) => q.eq('documentId', document._id))
      .order('desc')
      .take(100)
  )

  // EL CLIENTE NO VE LA CUARENTENA. Un push cuya firma no se pudo verificar
  // entra como DRAFT en cuarentena y NO mueve los punteros del documento
  // (`operatorDeliverables.publishDeliverable`, rama `keepsLiveDocument`): la
  // sala sigue sirviendo la versión anterior. Mostrarle esa fila al dueño
  // COMPANY le anuncia una entrega que no puede abrir y que el equipo todavía
  // no dio por buena. El ADMIN sí la ve: es su cola de trabajo.
  //
  // El corte es el borrador que nadie sirvió, no "todo lo QUARANTINED": el v1
  // sintético del ingest es QUARANTINED y SUPERSEDED, y es la historia real
  // de un documento legacy — esconderla dejaría el historial en blanco.
  const visible =
    profile.role === 'ADMIN'
      ? versions
      : versions.filter(
          (version) =>
            version.publicationStatus !== 'DRAFT' || version._id === document.currentVersionId
        )

  return visible.map((version) => ({
    versionId: version._id,
    versionNumber: version.versionNumber,
    displayName: version.displayName,
    declaredMimeType: version.declaredMimeType,
    detectedMimeType: version.detectedMimeType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    signatureKind: version.signatureKind,
    verificationStatus: version.verificationStatus,
    malwareScanStatus: version.malwareScanStatus,
    publicationStatus: version.publicationStatus,
    deliveryLabel: version.deliveryLabel ?? null,
    deliveryNote: version.deliveryNote ?? null,
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
    isCurrent: version._id === document.currentVersionId,
  }))
})

export const listVersions = query({
  args: { documentId: v.id('documents') },
  handler: (ctx, args) => runConvex(listVersionsProgram(ctx, args)),
})

type GetByCompanyArgs = {
  companyId: Id<'companies'>
  folder?: string
  accessLevel?: NonNullable<Doc<'documents'>['accessLevel']>
}

const getByCompanyProgram = Effect.fn('Documents.getByCompany')(function* (
  ctx: QueryCtx,
  args: GetByCompanyArgs
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  const authorization = yield* convexPromise(() =>
    requireCompanyReadAuthorization(
      ctx,
      auth,
      company,
      'No tienes permiso para listar estos documentos'
    )
  )

  // La sala es una por empresa: no queda un segundo scope del que separar esta
  // lista, así que la consulta ya no acepta uno.
  let documents = yield* getCompanyDocumentsEffect(ctx, args.companyId)

  documents = documents.filter((document) => document.lifecycleStatus !== 'ARCHIVED')

  if (args.folder) {
    documents = documents.filter((document) => document.folder === args.folder)
  }
  if (args.accessLevel) {
    documents = documents.filter((document) => document.accessLevel === args.accessLevel)
  }

  return authorization.access === 'READ_ONLY'
    ? documents.map(projectCompanyMemberDocumentIndex)
    : documents.map(projectCompanyOwnerDocument)
})

export const getByCompany = query({
  args: {
    companyId: v.id('companies'),
    folder: v.optional(v.string()),
    accessLevel: v.optional(
      v.union(v.literal('PUBLIC'), v.literal('NDA_REQUIRED'), v.literal('PRIVATE'))
    ),
  },
  handler: (ctx, args) => runConvex(getByCompanyProgram(ctx, args)),
})


const getFoldersProgram = Effect.fn('Documents.getFolders')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  yield* requireCompanyOwnerOrAdminEffect(
    ctx,
    auth,
    company,
    'No tienes permiso para ver estos folders'
  )

  const documents = yield* getCompanyDocumentsEffect(ctx, args.companyId)
  return Array.from(new Set(documents.map((document) => document.folder || 'General'))).sort()
})

export const getFolders = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(getFoldersProgram(ctx, args)),
})

// ES: La identidad de la contraparte ya no exige lecturas encadenadas: solo el
// equipo (ADMIN) aparece con nombre y todo lo demás queda anónimo.
function resolveCounterparty(
  accessor: Doc<'profiles'> | undefined
): ResolvedCounterparty {
  if (!accessor) {
    return { kind: 'UNKNOWN', displayName: null, identityRevealed: false }
  }

  if (accessor.role === 'ADMIN') {
    return { kind: 'TEAM', displayName: null, identityRevealed: true }
  }

  // La contraparte con identidad propia ya no existe. Lo que queda en la sala
  // son invitados sin perfil de producto: la fila de actividad no puede
  // ponerles nombre.
  return { kind: 'UNKNOWN', displayName: null, identityRevealed: false }
}

const getRoomActivityProgram = Effect.fn('Documents.getRoomActivity')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'>; windowDays?: number }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  yield* requireCompanyOwnerOrAdminEffect(
    ctx,
    auth,
    company,
    'No tienes permiso para ver la actividad de este data room'
  )

  const windowDays = clampWindowDays(args.windowDays)
  const since = Date.now() - windowDays * DAY_MS

  // Acotado por índice y por techo, nunca una lectura completa de la tabla.
  // Esta query es reactiva — se vuelve a correr en CADA acceso a la sala — así
  // que el costo por corrida es el presupuesto real, no el peor caso teórico.
  const logs = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessLogs')
      .withIndex('by_companyId_accessedAt', (q) =>
        q.eq('companyId', args.companyId).gte('accessedAt', since)
      )
      .order('desc')
      .take(ROOM_ACTIVITY_SCAN_CAP)
  )

  // El emisor abriendo sus propios archivos no es señal: inflaría "descargas"
  // con su propia actividad. El equipo (ADMIN) sí se muestra.
  const relevantLogs = logs.filter((log) => log.accessedById !== company.ownerId)

  const documentIds = [...new Set(relevantLogs.map((log) => log.documentId))]
  const documents = mapExistingDocs(
    yield* convexPromise(() => Promise.all(documentIds.map((documentId) => ctx.db.get(documentId))))
  )

  const profileIds = [...new Set(relevantLogs.map((log) => log.accessedById))].slice(
    0,
    ROOM_ACTIVITY_COUNTERPARTY_CAP
  )
  const profiles = mapExistingDocs(
    yield* convexPromise(() => Promise.all(profileIds.map((profileId) => ctx.db.get(profileId))))
  )

  const counterparties = new Map<Id<'profiles'>, ResolvedCounterparty>(
    profileIds.map((profileId) => [profileId, resolveCounterparty(profiles.get(profileId))])
  )

  // Proyección por lista blanca. La IP, el user agent, la razón de la policy,
  // el step-up y el riesgo NO salen de acá: son material de seguridad del
  // equipo, no del emisor. Exponerlos convertiría una pantalla de actividad en
  // vigilancia de la contraparte. El id del perfil tampoco sale: `roomScope`
  // convierte la clave de contraparte en un derivado propio de esta sala.
  return buildRoomActivity({
    logs: relevantLogs,
    documents,
    counterparties,
    roomScope: args.companyId,
    windowDays,
    scanCap: ROOM_ACTIVITY_SCAN_CAP,
    scannedCount: logs.length,
  })
})

export const getRoomActivity = query({
  args: {
    companyId: v.id('companies'),
    windowDays: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(getRoomActivityProgram(ctx, args)),
})

/** Tamaño por defecto y techo duro de la cola de revisión manual. */
const MANUAL_REVIEW_PAGE = { fallback: 25, max: 100 } as const
/** Filas de bitácora leídas por documento para hallar el último intento. */
const MANUAL_REVIEW_LOG_SCAN_CAP = 50

const getManualReviewQueueProgram = Effect.fn('Documents.getManualReviewQueue')(function* (
  ctx: QueryCtx,
  args: { limit?: number }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  if (profile.role !== 'ADMIN') {
    return yield* Effect.fail(adminRequired())
  }

  const limit = clampLimit(args.limit, MANUAL_REVIEW_PAGE)

  const [legacyActiveDocuments, explicitActiveDocuments] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('documents')
        .withIndex('by_classification_isExpired', (q) =>
          q.eq('classification', 'KYC_SENSITIVE').eq('isExpired', undefined)
        )
        .order('desc')
        .take(limit),
      ctx.db
        .query('documents')
        .withIndex('by_classification_isExpired', (q) =>
          q.eq('classification', 'KYC_SENSITIVE').eq('isExpired', false)
        )
        .order('desc')
        .take(limit),
    ])
  )
  const documents = [...legacyActiveDocuments, ...explicitActiveDocuments]
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, limit)

  return yield* convexPromise(() =>
    Promise.all(
      documents.map(async (document) => {
        const company = await ctx.db.get(document.companyId)
        // Bitácora acotada y más reciente primero: el primer match ES el
        // último intento que requirió revisión.
        const recentLogs = await ctx.db
          .query('documentAccessLogs')
          .withIndex('by_documentId_accessedAt', (q) => q.eq('documentId', document._id))
          .order('desc')
          .take(MANUAL_REVIEW_LOG_SCAN_CAP)
        const latestReviewLog =
          recentLogs.find(
            (log) =>
              log.decision === 'REQUIRE_REVIEW' || log.outcome === 'REVIEW_REQUIRED_KYC_SENSITIVE'
          ) || null

        // Proyección por lista blanca: la fila cruda de `documents` trae
        // storageId/storagePath y la de la bitácora trae IP/user agent y
        // material de policy. El panel admin solo necesita lo de abajo.
        return {
          _id: document._id,
          _creationTime: document._creationTime,
          name: document.name,
          accessLevel: document.accessLevel,
          classification: document.classification,
          company: company ? { _id: company._id, name: company.name } : null,
          latestReviewLog: latestReviewLog
            ? {
                accessedAt: latestReviewLog.accessedAt,
                outcome: latestReviewLog.outcome,
                reason: latestReviewLog.reason,
              }
            : null,
        }
      })
    )
  )
})

export const getManualReviewQueue = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(getManualReviewQueueProgram(ctx, args)),
})
