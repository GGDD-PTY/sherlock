import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { internalMutation, mutation, type MutationCtx } from '../_generated/server'
// Las fronteras de `_helpers/auth`, `shared.ts`, `deliverableVersion.ts` y
// `uploadIntents.ts` se cruzan por `convexPromise` en vez de usar sus variantes
// `...Effect`: las suites de este módulo reemplazan esos módulos enteros con
// `vi.mock`, así que el nombre importado es parte del contrato.
import { requireAuth, type AuthResult } from '../_helpers/auth'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { unauthorized, invalidState } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { SECURITY_THRESHOLDS, SECURITY_WINDOWS } from '../security'
import { deniedDocumentAccess, type DeniedDocumentAccess } from './accessResult'
import { verifyDocumentDeliveryProof } from './deliveryProof'
import { loadDeliverablePublishedVersion } from './deliverableVersion'
import {
  documentAccessActionValidator,
  resolveDocumentAccessIntent,
  type DocumentAccessAction,
} from './accessIntent'
import { findVdrUploadIntentByStorageId } from './uploadIntents'
import { inferDocumentClassification } from './policy'
import {
  createDocumentAccessGrantToken,
  findDocumentByStorageId,
  findDocumentByStoragePath,
  hashDocumentAccessGrantToken,
  recordDocumentAccessLog,
  resolveDownloadAccess,
} from './shared'

const DOCUMENT_ACCESS_GRANT_TTL_MS = 5 * 60 * 1000

// Raw upload authority stays internal. Public assets and direct VDR uploads
// mint purpose/scope-bound intents; the legacy server route invokes this only
// through its authenticated admin client.
export const generateUploadUrlInternal = internalMutation({
  handler: (ctx) => runConvex(convexPromise(() => ctx.storage.generateUploadUrl())),
})

const getStorageUrlProgram = Effect.fn('DocumentStorage.getStorageUrl')(function* (
  ctx: MutationCtx,
  args: { storageId: Id<'_storage'>; assetIntentId: Id<'assetUploadIntents'> }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `storageUrl:${profile._id}`,
      limit: 30,
      windowMs: 60 * 1000,
    })
  )

  // A raw storageId is never read authority. Public profile assets must first
  // consume a purpose-bound upload intent owned by this exact profile. VDR
  // bytes always stay on the download-grant path, regardless of any asset row.
  const assetIntent = yield* convexPromise(() => ctx.db.get(args.assetIntentId))
  if (
    !assetIntent ||
    assetIntent.requestedByProfileId !== profile._id ||
    assetIntent.status !== 'CONSUMED' ||
    assetIntent.storageId !== args.storageId
  ) {
    return yield* Effect.fail(
      unauthorized('No autorizado para resolver este archivo de almacenamiento')
    )
  }

  const [backingDocument, vdrIntent] = yield* convexPromise(() =>
    Promise.all([
      findDocumentByStorageId(ctx, args.storageId),
      findVdrUploadIntentByStorageId(ctx, args.storageId),
    ])
  )
  if (backingDocument || vdrIntent) {
    return yield* Effect.fail(
      unauthorized('No autorizado para resolver este archivo de almacenamiento')
    )
  }

  return yield* convexPromise(() => ctx.storage.getUrl(args.storageId))
})

export const getStorageUrl = mutation({
  args: {
    storageId: v.id('_storage'),
    assetIntentId: v.id('assetUploadIntents'),
  },
  handler: (ctx, args) => runConvex(getStorageUrlProgram(ctx, args)),
})

// ES: ipAddress/userAgent NO se aceptan del cliente — serían un rastro de
// auditoría falsificable. El identity confiable del acceso es el profile de la
// sesión (requireAuth). Si en el futuro se necesita IP/UA real, debe derivarse
// en un contexto server confiable (httpAction), nunca de args del cliente.
// EN: ipAddress/userAgent are intentionally NOT client-supplied — they would be
// a spoofable audit trail. The trusted actor identity is the authenticated profile.
const logLocalStorageAccessProgram = Effect.fn('DocumentStorage.logLocalAccess')(function* (
  ctx: MutationCtx,
  args: { relativePath: string; action: DocumentAccessAction }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { profile } = auth

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `localStorageAccess:${profile._id}`,
      limit: 60,
      windowMs: 60 * 1000,
    })
  )

  const document = yield* convexPromise(() =>
    findDocumentByStoragePath(ctx, args.relativePath)
  )
  if (!document) {
    return yield* Effect.fail(unauthorized('Acceso a documento no autorizado'))
  }

  const evaluation = yield* convexPromise(() =>
    resolveDownloadAccess(ctx, auth, document)
  )
  yield* convexPromise(() =>
    recordDocumentAccessLog(ctx, {
      documentId: document._id,
      companyId: document.companyId,
      accessedById: profile._id,
      action: args.action,
      evaluation,
      accessLevel: document.accessLevel,
    })
  )

  // ES: NO lanzar en la rama deny: un throw revertiría la fila de auditoría
  // recién insertada (los DENY nunca persistían). El caller (ruta de storage)
  // traduce el resultado a 403.
  if (evaluation.decision !== 'ALLOW') {
    return { ...deniedDocumentAccess(evaluation), logged: true as const }
  }

  return { allowed: true as const, logged: true as const }
})

export const logLocalStorageAccess = mutation({
  args: {
    relativePath: v.string(),
    action: documentAccessActionValidator,
  },
  handler: (ctx, args) => runConvex(logLocalStorageAccessProgram(ctx, args)),
})

const documentAccessGrantArgs = {
  documentId: v.id('documents'),
  versionId: v.optional(v.id('documentVersions')),
  // Opcional a propósito: sin este arg la mutation se comporta exactamente
  // como antes (DOWNLOAD). DocumentsList y MyCompanyDocuments no lo mandan.
  // El rate limit `docDownload` es COMPARTIDO entre vistas y descargas: partir
  // el bucket duplicaría el techo real de grants por minuto.
  action: v.optional(documentAccessActionValidator),
}

type DocumentAccessGrantArgs = {
  documentId: Id<'documents'>
  versionId?: Id<'documentVersions'>
  action?: DocumentAccessAction
}

type IssuedGrant = {
  allowed: true
  url: string
  action: DocumentAccessAction
  versionId: Id<'documentVersions'>
  displayName: string
  detectedMimeType: string
}

const issueDocumentAccessGrant = Effect.fn('DocumentStorage.issueGrant')(function* (
  ctx: MutationCtx,
  args: DocumentAccessGrantArgs,
  auth: AuthResult
): Effect.fn.Return<IssuedGrant | DeniedDocumentAccess | null, AppError> {
  const { profile } = auth

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `docDownload:${profile._id}`,
      limit: 30,
      windowMs: 60 * 1000,
    })
  )

  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) return null

  if (document.expiresAt && document.expiresAt < Date.now()) {
    yield* Effect.logWarning('Acceso documental denegado: el documento ha expirado')
    if (!document.isExpired) {
      yield* convexPromise(() => ctx.db.patch(args.documentId, { isExpired: true }))
    }
    return null
  }

  const deliverableVersion = yield* convexPromise(() =>
    loadDeliverablePublishedVersion(ctx, document, Date.now(), args.versionId)
  )
  if (!deliverableVersion) return null

  const intent = resolveDocumentAccessIntent(args.action, {
    name: deliverableVersion.displayName,
    fileType: deliverableVersion.detectedMimeType,
  })
  const evaluation = yield* convexPromise(() =>
    resolveDownloadAccess(ctx, auth, document)
  )
  const issuedAction = intent === 'VIEW' ? 'VIEW_GRANT_ISSUED' : 'DOWNLOAD_GRANT_ISSUED'
  const deniedAction = intent === 'VIEW' ? 'VIEW_DENIED' : 'DOWNLOAD_DENIED'

  yield* convexPromise(() =>
    recordDocumentAccessLog(ctx, {
      documentId: args.documentId,
      companyId: document.companyId,
      accessedById: profile._id,
      action: evaluation.decision === 'ALLOW' ? issuedAction : deniedAction,
      evaluation,
      accessLevel: document.accessLevel,
    })
  )

  // Do not throw after audit: Convex would roll back the persisted denial.
  if (evaluation.decision !== 'ALLOW') return deniedDocumentAccess(evaluation)

  const token = createDocumentAccessGrantToken()
  const tokenHash = yield* convexPromise(() => hashDocumentAccessGrantToken(token))
  const expiresAt = Date.now() + DOCUMENT_ACCESS_GRANT_TTL_MS
  const grantId = yield* convexPromise(() =>
    ctx.db.insert('documentAccessGrants', {
      documentId: args.documentId,
      documentVersionId: deliverableVersion._id,
      documentSha256: deliverableVersion.sha256,
      companyId: document.companyId,
      protectionPolicyVersion: document.protectionPolicyVersion,
      profileId: profile._id,
      action: intent,
      tokenHash,
      createdAt: Date.now(),
      expiresAt,
      useCount: 0,
      classification: evaluation.classification,
      accessLevel: document.accessLevel,
      outcome: evaluation.outcome,
      riskScore: evaluation.riskScore,
    })
  )

  return {
    allowed: true as const,
    url: `/api/documents/access/${grantId}?token=${encodeURIComponent(token)}`,
    action: intent,
    versionId: deliverableVersion._id,
    displayName: deliverableVersion.displayName,
    detectedMimeType: deliverableVersion.detectedMimeType,
  }
})

/** Version-aware viewer boundary: the server returns the exact renderer contract. */
const getDocumentAccessGrantProgram = Effect.fn('DocumentStorage.getAccessGrant')(function* (
  ctx: MutationCtx,
  args: DocumentAccessGrantArgs
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  return yield* issueDocumentAccessGrant(ctx, args, auth)
})

export const getDocumentAccessGrant = mutation({
  args: documentAccessGrantArgs,
  handler: (ctx, args) => runConvex(getDocumentAccessGrantProgram(ctx, args)),
})

/** Legacy URL/denial contract retained for existing callers. */
const getDownloadUrlProgram = Effect.fn('DocumentStorage.getDownloadUrl')(function* (
  ctx: MutationCtx,
  args: DocumentAccessGrantArgs
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const result = yield* issueDocumentAccessGrant(ctx, args, auth)
  return result?.allowed === true ? result.url : result
})

export const getDownloadUrl = mutation({
  args: documentAccessGrantArgs,
  handler: (ctx, args) => runConvex(getDownloadUrlProgram(ctx, args)),
})

type ConsumeDownloadGrantArgs = {
  grantId: Id<'documentAccessGrants'>
  token: string
  deliveryIssuedAt: number
  deliveryProof: string
  ipAddress?: string
  userAgent?: string
}

/** Lo que la ruta HTTP recibe cuando la entrega procede. */
type ConsumedDelivery = {
  downloadUrl: string
  fileName: string
  fileType: string
  documentId: Id<'documents'>
  action: DocumentAccessAction
}

const consumeDownloadGrantProgram = Effect.fn('DocumentStorage.consumeGrant')(function* (
  ctx: MutationCtx,
  args: ConsumeDownloadGrantArgs
): Effect.fn.Return<ConsumedDelivery | DeniedDocumentAccess | null, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth
  const now = Date.now()

  // `consumeDownloadGrant` debe seguir siendo una mutation autenticada porque
  // la ruta Next usa el token WorkOS del usuario (nunca una deploy/admin key).
  // El HMAC separa esa ruta server-side de una llamada directa desde devtools:
  // grantId+token solos ya no alcanzan para obtener la URL permanente de
  // Convex Storage y saltarse proxy, watermark y auditoría por acceso.
  // The server proof is mandatory in code. A deployment flag must never turn
  // grantId+token into enough authority to resolve the permanent storage URL.
  const deliverySecret = process.env.STORAGE_SECRET
  const proofAccepted = deliverySecret
    ? yield* convexPromise(() =>
        verifyDocumentDeliveryProof(deliverySecret, {
          grantId: args.grantId,
          token: args.token,
          profileId: profile._id,
          issuedAt: args.deliveryIssuedAt,
          proof: args.deliveryProof,
        })
      )
    : false
  if (!proofAccepted) {
    return yield* Effect.fail(unauthorized('Entrega documental no autorizada.'))
  }

  const grant = yield* convexPromise(() => ctx.db.get(args.grantId))
  if (!grant || grant.profileId !== profile._id) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  if (grant.revokedAt || grant.expiresAt <= now) {
    return yield* Effect.fail(invalidState('Grant de acceso expirado.', 'EXPIRED'))
  }

  const tokenHash = yield* convexPromise(() => hashDocumentAccessGrantToken(args.token))
  if (tokenHash !== grant.tokenHash) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  const document = yield* convexPromise(() => ctx.db.get(grant.documentId))
  if (!document || !grant.documentVersionId || !grant.documentSha256 || !grant.companyId) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  const deliverableVersion = yield* convexPromise(() =>
    loadDeliverablePublishedVersion(ctx, document, now, grant.documentVersionId)
  )
  if (
    !deliverableVersion ||
    deliverableVersion._id !== grant.documentVersionId ||
    deliverableVersion.sha256 !== grant.documentSha256 ||
    document.companyId !== grant.companyId ||
    document.protectionPolicyVersion !== grant.protectionPolicyVersion ||
    document.accessLevel !== grant.accessLevel ||
    // ES: El grant persiste la clasificación EVALUADA (inferida cuando el
    // documento legado no trae `classification`); comparar contra el valor
    // crudo rechazaría todo grant válido de esos documentos.
    inferDocumentClassification(document.accessLevel, document.classification) !==
      grant.classification
  ) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  // ES: La intención vive en el grant, no en la URL. Un grant emitido por el
  // deploy anterior no trae `action` y se lee como DOWNLOAD, que es su
  // significado real: hasta ahora todo grant era una descarga.
  // EN: intent is grant-bound; grants issued before this change read as DOWNLOAD.
  const intent = grant.action === 'VIEW' ? 'VIEW' : 'DOWNLOAD'
  const evaluation = yield* convexPromise(() =>
    resolveDownloadAccess(ctx, auth, document)
  )
  const deniedAction = intent === 'VIEW' ? 'VIEW_DENIED' : 'DOWNLOAD_DENIED'

  yield* convexPromise(() =>
    recordDocumentAccessLog(ctx, {
      documentId: grant.documentId,
      companyId: document.companyId,
      accessedById: profile._id,
      action: evaluation.decision === 'ALLOW' ? intent : deniedAction,
      evaluation,
      accessLevel: document.accessLevel,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      grantId: grant._id,
    })
  )

  // ES: NO lanzar en la rama deny: la fila VIEW_DENIED/DOWNLOAD_DENIED debe
  // commitear (un throw la revertiría). La ruta HTTP traduce a 403.
  if (evaluation.decision !== 'ALLOW') {
    return deniedDocumentAccess(evaluation)
  }

  yield* convexPromise(() =>
    ctx.db.patch(grant._id, {
      lastUsedAt: now,
      useCount: (grant.useCount || 0) + 1,
      revokedAt: now,
      outcome: 'CONSUMED',
    })
  )

  // ES: Dos contadores, dos alarmas, una lectura acotada por acción. La
  // bitácora se lee SIEMPRE por las dos acciones porque VIEW y DOWNLOAD
  // entregan exactamente los mismos bytes: la ruta solo cambia el header
  // Content-Disposition (src/app/api/documents/access/[grantId]/route.ts). Si
  // el presupuesto se contara solo en la rama DOWNLOAD, pedir el data room
  // entero con `action: 'VIEW'` costaría cero.
  // EN: VIEW and DOWNLOAD deliver identical bytes; both feed the total counter.
  const windowStart = now - SECURITY_WINDOWS.DATA_ROOM_WINDOW_MS

  // Tope derivado del umbral, no un número mágico: con ALERT+1 filas se
  // distinguen <WARNING, [WARNING, ALERT) y >=ALERT sin error de conteo.
  const viewScanCap = SECURITY_THRESHOLDS.DATA_ROOM_DELIVERIES_ALERT + 1
  const recentViews = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessLogs')
      .withIndex('by_accessedById_action_accessedAt', (q) =>
        q.eq('accessedById', profile._id).eq('action', 'VIEW').gte('accessedAt', windowStart)
      )
      .take(viewScanCap)
  )

  // El escaneo de DESCARGAS queda igual —mismo índice, mismo tope ALERT+1, y
  // ÚLTIMO de los dos— porque su contrato está bloqueado en
  // src/__tests__/convex/downloadGrantScanBound.test.ts. Antes esto hacía
  // `.collect()` del historial completo del perfil, y cuando cruzaba el techo
  // por transacción de Convex la mutation lanzaba: el usuario perdía el acceso
  // a TODO documento con un 403 genérico, y el rollback se llevaba también su
  // fila de auditoría.
  const downloadScanCap = SECURITY_THRESHOLDS.DATA_ROOM_DOWNLOADS_ALERT + 1
  const recentDownloads = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessLogs')
      .withIndex('by_accessedById_action_accessedAt', (q) =>
        q.eq('accessedById', profile._id).eq('action', 'DOWNLOAD').gte('accessedAt', windowStart)
      )
      .take(downloadScanCap)
  )

  const viewCount = recentViews.length
  const downloadCount = recentDownloads.length
  const deliveryCount = viewCount + downloadCount
  // Distinguir "releyó tres documentos treinta veces" de "barrió la sala
  // entera" es la diferencia entre descartar y escalar. Se calcula sobre las
  // filas ya leídas: cero lecturas extra, y por eso es un PISO, no un total.
  const distinctDocuments = new Set([...recentViews, ...recentDownloads].map((l) => l.documentId))
    .size

  // ES: La alarma de DESCARGA sigue estricta y solo la alimenta una entrega
  // con intención DOWNLOAD: hojear la sala no la enciende, que es justo lo que
  // el emisor pidió al separar vista de descarga.
  // EN: the strict download alarm still fires only on DOWNLOAD deliveries.
  if (intent === 'DOWNLOAD') {
    const downloadSeverity =
      downloadCount >= SECURITY_THRESHOLDS.DATA_ROOM_DOWNLOADS_ALERT
        ? 'ALERT'
        : downloadCount >= SECURITY_THRESHOLDS.DATA_ROOM_DOWNLOADS_WARNING
          ? 'WARNING'
          : null

    if (downloadSeverity) {
      yield* convexPromise(() =>
        ctx.scheduler.runAfter(0, internal.documents._logBulkDownloadEvent, {
          userId: user._id,
          userEmail: user.email,
          profileId: profile._id,
          ipAddress: args.ipAddress,
          downloadCount,
          severity: downloadSeverity,
          companyId: document.companyId,
        })
      )
    }
  }

  // ES: La alarma de EXTRACCIÓN total corre en las DOS ramas. Si solo corriera
  // en la rama VIEW, bastaría con hojear primero y descargar después para
  // quedarse debajo de las dos líneas. El navegador decide el header; no
  // decide cuánto material salió de la sala.
  // EN: runs on both intents — ordering must not buy a silent budget.
  const deliverySeverity =
    deliveryCount >= SECURITY_THRESHOLDS.DATA_ROOM_DELIVERIES_ALERT
      ? 'ALERT'
      : deliveryCount >= SECURITY_THRESHOLDS.DATA_ROOM_DELIVERIES_WARNING
        ? 'WARNING'
        : null

  if (deliverySeverity) {
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.documents._logBulkAccessEvent, {
        userId: user._id,
        userEmail: user.email,
        profileId: profile._id,
        ipAddress: args.ipAddress,
        deliveryCount,
        viewCount,
        downloadCount,
        distinctDocuments,
        severity: deliverySeverity,
        companyId: document.companyId,
      })
    )
  }

  const downloadUrl = yield* convexPromise(() =>
    ctx.storage.getUrl(deliverableVersion.storageId)
  )
  if (!downloadUrl) {
    return null
  }

  return {
    downloadUrl,
    fileName: deliverableVersion.displayName,
    fileType: deliverableVersion.detectedMimeType,
    documentId: document._id,
    // La capa HTTP fija Content-Disposition con ESTA decisión del servidor,
    // no con el query param del navegador.
    action: intent,
  }
})

export const consumeDownloadGrant = mutation({
  args: {
    grantId: v.id('documentAccessGrants'),
    token: v.string(),
    deliveryIssuedAt: v.number(),
    deliveryProof: v.string(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(consumeDownloadGrantProgram(ctx, args)),
})

// ES: `consumeDownloadGrant` quema el grant ANTES de que la capa HTTP haga
// fetch + watermark/proxy. Si esa entrega falla, el usuario queda con un 500,
// el grant single-use ya revocado y una fila VIEW/DOWNLOAD contada que nunca
// entregó bytes — y cada reintento emite grant + log nuevos, empujándolo hacia
// los umbrales DATA_ROOM. Esta mutation revierte ese consumo, UNA sola vez por
// grant, para que el reintento inmediato de la misma ruta funcione.
//
// Solo la puede invocar la ruta Next: exige el mismo HMAC servidor-a-servidor
// que `consumeDownloadGrant` (STORAGE_SECRET, que el navegador nunca ve). Sin
// esa compuerta, cualquier usuario podría "liberar" entregas EXITOSAS desde
// devtools y borrar sus filas del contador de extracción masiva.
type ReleaseFailedDeliveryArgs = {
  grantId: Id<'documentAccessGrants'>
  token: string
  releaseIssuedAt: number
  releaseProof: string
}

const releaseFailedDeliveryProgram = Effect.fn('DocumentStorage.releaseFailedDelivery')(function* (
  ctx: MutationCtx,
  args: ReleaseFailedDeliveryArgs
): Effect.fn.Return<{ released: boolean }, AppError> {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  const now = Date.now()

  const releaseSecret = process.env.STORAGE_SECRET
  const proofAccepted = releaseSecret
    ? yield* convexPromise(() =>
        verifyDocumentDeliveryProof(releaseSecret, {
          grantId: args.grantId,
          token: args.token,
          profileId: profile._id,
          issuedAt: args.releaseIssuedAt,
          proof: args.releaseProof,
        })
      )
    : false
  if (!proofAccepted) {
    return yield* Effect.fail(unauthorized('Liberación de entrega no autorizada.'))
  }

  const grant = yield* convexPromise(() => ctx.db.get(args.grantId))
  if (!grant || grant.profileId !== profile._id) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  const tokenHash = yield* convexPromise(() => hashDocumentAccessGrantToken(args.token))
  if (tokenHash !== grant.tokenHash) {
    return yield* Effect.fail(unauthorized('Grant de acceso inválido.'))
  }

  // Una sola liberación por grant: sin esto, la ventana de replay del
  // single-use quedaría abierta de par en par.
  if (grant.releasedAt) {
    return yield* Effect.fail(invalidState('El grant ya fue liberado una vez.', 'ALREADY_RELEASED'))
  }

  if (grant.outcome !== 'CONSUMED' || !grant.revokedAt) {
    return yield* Effect.fail(invalidState('El grant no está en estado consumido.', 'NOT_CONSUMED'))
  }

  // Liberar solo revocaciones recientes: pasada la ventana del grant, el
  // camino correcto es emitir un grant nuevo, no resucitar uno viejo.
  if (now - grant.revokedAt > DOCUMENT_ACCESS_GRANT_TTL_MS) {
    return yield* Effect.fail(invalidState('La ventana de liberación expiró.', 'EXPIRED'))
  }

  yield* convexPromise(() =>
    ctx.db.patch(grant._id, {
      revokedAt: undefined,
      outcome: 'DELIVERY_FAILED_RELEASED',
      releasedAt: now,
    })
  )

  // La fila de bitácora del consumo fallido deja de contar como material
  // entregado: el usuario nunca recibió bytes. Se reetiqueta (no se borra):
  // la evidencia del intento y su decisión quedan intactas.
  const intent = grant.action === 'VIEW' ? 'VIEW' : 'DOWNLOAD'
  const recentLogs = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessLogs')
      .withIndex('by_documentId_accessedAt', (q) => q.eq('documentId', grant.documentId))
      .order('desc')
      .take(50)
  )
  const deliveryLog = recentLogs.find((log) => log.grantId === grant._id && log.action === intent)
  if (deliveryLog) {
    yield* convexPromise(() =>
      ctx.db.patch(deliveryLog._id, {
        action: `${intent}_DELIVERY_FAILED`,
        outcome: 'DELIVERY_FAILED',
      })
    )
  }

  return { released: true }
})

export const releaseFailedDelivery = mutation({
  args: {
    grantId: v.id('documentAccessGrants'),
    token: v.string(),
    releaseIssuedAt: v.number(),
    releaseProof: v.string(),
  },
  handler: (ctx, args) => runConvex(releaseFailedDeliveryProgram(ctx, args)),
})
