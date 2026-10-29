// ============================================================================
// VDR READ — server-proof entry points for the client-facing read-only MCP
// ============================================================================
// These are the ONLY Convex functions the `/api/vdr-mcp` surface may call.
// Each one re-derives the caller's room from durable state (never from the
// arguments) and re-runs the real document policy engine
// (`buildDocumentAccessBaseline` / `evaluateDocumentAccessWithBaseline`).
//
// The HMAC server proof authenticates the app tier, not the caller: it proves
// "this request came from the Sherlock route with these exact arguments".
// Authorization is always recomputed on top of it.
//
// LA FORMA DE SALIDA ES CONTRATO CON UN AGENTE EXTERNO. Del otro lado de estas
// funciones no hay una pantalla nuestra: hay el agente del cliente hablando MCP.
// `RoomDocumentSchema` es esa forma escrita una sola vez y verificada en el
// borde con `make`, así que un campo que se caiga o cambie de tipo revienta acá
// —del lado servidor, en la corrida— y no al otro lado del protocolo. La forma
// no cambia: es exactamente la que ya se servía.
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc } from './_generated/dataModel'
import {
  action,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { api } from './_generated/api'
import {
  buildDocumentAccessBaseline,
  evaluateDocumentAccessWithBaseline,
} from './_documents/shared'
import { VDR_MCP_READ_MAX_BYTES } from './_documents/uploadLimits'
import { convexPromise, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { isVdrReadFailure, resolveVdrReadBinding } from './_vdrRead/binding'
import { loadRoomProgressProjection } from './_vdrRead/progress'
import { requireVdrReadServerProof } from './_vdrRead/serverProof'
import {
  issueUploadArgs,
  issueUploadIntentProgram,
  registerUploadArgs,
  registerUploadProgram,
  type IssuedMcpUpload,
  type RegisteredMcpUpload,
} from './_vdrWrite/upload'

export const VDR_READ_CANDIDATE_CAP = 500
export const VDR_READ_RESULT_CAP = 200
export const VDR_READ_MAX_BYTES = VDR_MCP_READ_MAX_BYTES
export const VDR_READ_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const VDR_READ_INDEX_MAX_CHARS = 400_000

const proofArgs = {
  serverIssuedAt: v.number(),
  serverProof: v.string(),
} as const

type VersionBytesResult =
  | Readonly<{ allowed: false; code: 'DENIED' | 'NOT_FOUND' }>
  | Readonly<{
      allowed: true
      bytes: ArrayBuffer
      mimeType: string
      sha256: string
      documentId: string
    }>

/** La ficha de documento que ve el agente del cliente. Un campo, un tipo. */
const RoomDocumentSchema = Schema.Struct({
  documentId: Schema.String,
  versionId: Schema.String,
  nombre: Schema.String,
  carpeta: Schema.String,
  tipo: Schema.String,
  versionNumero: Schema.Number,
  estadoPublicacion: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  mimeType: Schema.String,
  actualizadoEn: Schema.Number,
  descripcion: Schema.optionalKey(Schema.String),
})

type RoomDocument = typeof RoomDocumentSchema.Type

type VdrReadCtx = Parameters<typeof buildDocumentAccessBaseline>[0]
type AccessBaseline = Awaited<ReturnType<typeof buildDocumentAccessBaseline>>
type ResolvedBinding = Exclude<Awaited<ReturnType<typeof resolveVdrReadBinding>>, { code: string }>
type RoomEntry = { document: Doc<'documents'>; version: Doc<'documentVersions'> }

function versionMimeType(version: Doc<'documentVersions'>): string {
  const detected = version.detectedMimeType?.trim()
  if (detected && detected !== 'application/octet-stream') return detected
  return version.declaredMimeType?.trim() || 'application/octet-stream'
}

function isDeliverableBlob(version: Doc<'documentVersions'>): boolean {
  return (
    version.verificationStatus === 'SIGNATURE_VERIFIED' &&
    (version.malwareScanStatus === 'CLEAN' || version.malwareScanStatus === 'NOT_CONFIGURED')
  )
}

/**
 * Un candidato entra al inventario sólo si sobrevive las cinco condiciones: es
 * de esta sala, es de esta transacción cuando la hay, la política lo permite, su
 * versión vigente le pertenece y ese blob es entregable. Cualquiera que falle lo
 * saca sin distinguirse de «no existe».
 */
const resolveRoomEntry = Effect.fn('VdrRead.resolveRoomEntry')(function* (
  ctx: VdrReadCtx,
  binding: ResolvedBinding,
  baseline: AccessBaseline,
  document: Doc<'documents'>
): Effect.fn.Return<RoomEntry | null, AppError> {
  if (document.companyId !== binding.company._id) return null
  if (evaluateDocumentAccessWithBaseline(baseline, document).decision !== 'ALLOW') return null
  const currentVersionId = document.currentVersionId
  const version = currentVersionId ? yield* convexPromise(() => ctx.db.get(currentVersionId)) : null
  if (!version || version.documentId !== document._id) return null
  if (version.companyId !== binding.company._id) return null
  if (!isDeliverableBlob(version)) return null
  return { document, version }
})

const loadAuthorizedRoomDocuments = Effect.fn('VdrRead.loadAuthorizedRoomDocuments')(function* (
  ctx: VdrReadCtx,
  binding: ResolvedBinding
) {
  const baseline = yield* convexPromise(() =>
    buildDocumentAccessBaseline(ctx, binding.auth.profile, binding.company._id, binding.auth)
  )

  const candidates = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', binding.company._id))
      .take(VDR_READ_CANDIDATE_CAP)
  )

  const resolved = yield* Effect.forEach(
    candidates,
    (document) => resolveRoomEntry(ctx, binding, baseline, document),
    { concurrency: 'unbounded' }
  )

  return resolved
    .filter((entry): entry is RoomEntry => entry !== null)
    .slice(0, VDR_READ_RESULT_CAP)
})

function toRoomDocument(
  document: Doc<'documents'>,
  version: Doc<'documentVersions'>
): RoomDocument {
  return RoomDocumentSchema.make({
    documentId: document._id,
    versionId: version._id,
    nombre: document.name,
    carpeta: document.folder?.trim() || 'General',
    tipo: document.fileType?.trim() || versionMimeType(version),
    versionNumero: version.versionNumber,
    estadoPublicacion: version.publicationStatus,
    bytes: version.byteSize,
    sha256: version.sha256,
    mimeType: versionMimeType(version),
    actualizadoEn: document.updatedAt ?? version.createdAt,
    ...(document.description ? { descripcion: document.description } : {}),
  })
}

const resolveRoom = Effect.fn('VdrRead.resolveRoom')(function* (
  ctx: QueryCtx,
  args: {
    principalId: string
    salaId?: string
    serverIssuedAt: number
    serverProof: string
  }
) {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'RESOLVE_BINDING',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.principalId, args.salaId ?? ''],
    })
  )

  const binding = yield* convexPromise(() =>
    resolveVdrReadBinding(ctx, {
      principalId: args.principalId,
      salaId: args.salaId,
    })
  )
  if (isVdrReadFailure(binding)) return binding

  const documents = yield* loadAuthorizedRoomDocuments(ctx, binding)
  const progress = yield* loadRoomProgressProjection(ctx, binding.company)

  return {
    sala: {
      salaId: binding.company._id,
      empresa: binding.company.name,
      pais: binding.company.country,
      rol: binding.role,
    },
    documentos: documents.map(({ document, version }) => toRoomDocument(document, version)),
    truncado: documents.length >= VDR_READ_RESULT_CAP,
    telefonoPresente: progress.telefonoPresente,
    nombreConfirmado: progress.nombreConfirmado,
    entregables: progress.entregables,
    conteosPorCarpeta: progress.conteosPorCarpeta,
    ultimoMovimiento: progress.ultimoMovimiento,
  }
})

const authorizeVersion = Effect.fn('VdrRead.authorizeVersion')(function* (
  ctx: QueryCtx,
  args: {
    principalId: string
    salaId?: string
    documentVersionId: string
    serverIssuedAt: number
    serverProof: string
  }
) {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'READ_VERSION_BYTES',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.principalId, args.salaId ?? '', args.documentVersionId],
    })
  )

  const binding = yield* convexPromise(() =>
    resolveVdrReadBinding(ctx, {
      principalId: args.principalId,
      salaId: args.salaId,
    })
  )
  if (isVdrReadFailure(binding)) return binding

  const authorized = yield* loadAuthorizedRoomDocuments(ctx, binding)
  const match = authorized.find(({ version }) => version._id === args.documentVersionId)
  // Uniform NOT_FOUND: a version of another room is indistinguishable from a
  // version that does not exist.
  if (!match) return { code: 'NOT_FOUND' as const }

  return {
    documento: toRoomDocument(match.document, match.version),
    storageId: match.version.storageId,
    storageBytes: match.version.byteSize,
  }
})

const readVersionBytes = Effect.fn('VdrRead.readVersionBytes')(function* (
  ctx: ActionCtx,
  args: {
    principalId: string
    salaId?: string
    documentVersionId: string
    serverIssuedAt: number
    serverProof: string
  }
): Effect.fn.Return<VersionBytesResult, AppError> {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'READ_VERSION_BYTES',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.principalId, args.salaId ?? '', args.documentVersionId],
    })
  )

  const resolved = yield* convexPromise(() =>
    ctx.runQuery(api.vdrRead.authorizeVersionFromServer, args)
  )
  if ('code' in resolved) return { allowed: false as const, code: resolved.code }

  const blob = yield* convexPromise(() => ctx.storage.get(resolved.storageId))
  if (!blob || blob.size !== resolved.storageBytes || blob.size > VDR_READ_MAX_BYTES) {
    return { allowed: false as const, code: 'NOT_FOUND' as const }
  }
  return {
    allowed: true as const,
    bytes: yield* convexPromise(() => blob.arrayBuffer()),
    mimeType: resolved.documento.mimeType,
    sha256: resolved.documento.sha256,
    documentId: resolved.documento.documentId,
  }
})

const readTextIndex = Effect.fn('VdrRead.readTextIndex')(function* (
  ctx: QueryCtx,
  args: { documentVersionId: string; sha256: string; serverIssuedAt: number; serverProof: string }
) {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'READ_TEXT_INDEX',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.documentVersionId, args.sha256],
    })
  )

  const versionId = ctx.db.normalizeId('documentVersions', args.documentVersionId)
  if (!versionId) return { found: false as const }
  const row = yield* convexPromise(() =>
    ctx.db
      .query('documentTextIndex')
      .withIndex('by_documentVersionId', (q) => q.eq('documentVersionId', versionId))
      .unique()
  )
  if (!row || row.sha256 !== args.sha256 || row.expiresAt <= Date.now()) {
    return { found: false as const }
  }
  return { found: true as const, pages: row.pages, truncated: row.truncated }
})

const writeTextIndex = Effect.fn('VdrRead.writeTextIndex')(function* (
  ctx: MutationCtx,
  args: {
    documentVersionId: string
    sha256: string
    extractor: 'PDF' | 'DOCX' | 'PPTX' | 'TXT'
    pages: Array<{ n: number; text: string }>
    truncated: boolean
    serverIssuedAt: number
    serverProof: string
  }
) {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'WRITE_TEXT_INDEX',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.documentVersionId, args.sha256, args.extractor],
    })
  )

  const versionId = ctx.db.normalizeId('documentVersions', args.documentVersionId)
  if (!versionId) return { stored: false as const }
  const version = yield* convexPromise(() => ctx.db.get(versionId))
  if (!version || version.sha256 !== args.sha256) return { stored: false as const }

  const totalChars = args.pages.reduce((sum, page) => sum + page.text.length, 0)
  if (totalChars > VDR_READ_INDEX_MAX_CHARS) return { stored: false as const }

  const now = Date.now()
  const row = {
    documentVersionId: versionId,
    documentId: version.documentId,
    companyId: version.companyId,
    sha256: args.sha256,
    extractor: args.extractor,
    pages: args.pages,
    totalChars,
    truncated: args.truncated,
    createdAt: now,
    expiresAt: now + VDR_READ_INDEX_TTL_MS,
  }
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('documentTextIndex')
      .withIndex('by_documentVersionId', (q) => q.eq('documentVersionId', versionId))
      .unique()
  )
  if (existing) {
    yield* convexPromise(() => ctx.db.patch(existing._id, row))
  } else {
    yield* convexPromise(() => ctx.db.insert('documentTextIndex', row))
  }
  return { stored: true as const }
})

const recordReadAudit = Effect.fn('VdrRead.recordReadAudit')(function* (
  ctx: MutationCtx,
  args: {
    principalId: string
    clientId: string
    salaId?: string
    tool: string
    argsSha256: string
    outcome: 'OK' | 'DENIED' | 'NOT_FOUND' | 'ERROR'
    errorCode?: string
    resultSummary?: string
    serverIssuedAt: number
    serverProof: string
  }
) {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'AUDIT_TOOL',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.principalId, args.clientId, args.tool, args.argsSha256, args.outcome],
    })
  )

  const companyId = args.salaId ? ctx.db.normalizeId('companies', args.salaId) : null

  yield* convexPromise(() =>
    ctx.db.insert('vdrReadAudits', {
      principalId: args.principalId.slice(0, 128),
      clientId: args.clientId.slice(0, 128),
      ...(companyId ? { companyId } : {}),
      tool: args.tool.slice(0, 64),
      argsSha256: args.argsSha256.slice(0, 64),
      outcome: args.outcome,
      ...(args.errorCode ? { errorCode: args.errorCode.slice(0, 64) } : {}),
      ...(args.resultSummary ? { resultSummary: args.resultSummary.slice(0, 256) } : {}),
      occurredAt: Date.now(),
    })
  )
  return { audited: true as const }
})

/**
 * Resolve the room the caller actually holds, plus a bounded inventory and the
 * progress projection (`sala_resumen` does not recompute it from the page of 200).
 */
export const resolveRoomFromServer = query({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    ...proofArgs,
  },
  handler: (ctx, args) => runConvex(resolveRoom(ctx, args)),
})

/**
 * Authorize one version and return its metadata plus the storage pointer.
 * Only `readVersionBytesFromServer` consumes the pointer; the proof binds the
 * caller, the room and the exact version, so knowing an id is never enough.
 */
export const authorizeVersionFromServer = query({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    documentVersionId: v.string(),
    ...proofArgs,
  },
  handler: (ctx, args) => runConvex(authorizeVersion(ctx, args)),
})

/**
 * Deliver the bytes of one authorized version. Authorization is recomputed
 * inside the inner query, so a caller cannot reach bytes by knowing an id.
 */
export const readVersionBytesFromServer = action({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    documentVersionId: v.string(),
    ...proofArgs,
  },
  // Explicit annotation: the handler calls a query declared in this same
  // module, so inference would be circular.
  handler: (ctx, args): Promise<VersionBytesResult> => runConvex(readVersionBytes(ctx, args)),
})

/** Read a cached text extraction. Pinned to the exact blob digest. */
export const readTextIndexFromServer = query({
  args: {
    documentVersionId: v.string(),
    sha256: v.string(),
    ...proofArgs,
  },
  handler: (ctx, args) => runConvex(readTextIndex(ctx, args)),
})

/** Persist a text extraction. Idempotent per version; bounded in size. */
export const writeTextIndexFromServer = mutation({
  args: {
    documentVersionId: v.string(),
    sha256: v.string(),
    extractor: v.union(v.literal('PDF'), v.literal('DOCX'), v.literal('PPTX'), v.literal('TXT')),
    pages: v.array(v.object({ n: v.number(), text: v.string() })),
    truncated: v.boolean(),
    ...proofArgs,
  },
  handler: (ctx, args) => runConvex(writeTextIndex(ctx, args)),
})

/** Issue a direct-upload intent for the COMPANY owner bound to this principal. */
export const issueUploadIntentFromServer = mutation({
  args: issueUploadArgs,
  handler: (ctx, args): Promise<IssuedMcpUpload> =>
    runConvex(
      Effect.gen(function* () {
        yield* convexPromise(() =>
          requireVdrReadServerProof({
            operation: 'ISSUE_UPLOAD_INTENT',
            issuedAt: args.serverIssuedAt,
            proof: args.serverProof,
            bindingParts: [
              args.principalId,
              args.salaId ?? '',
              args.carpeta,
              args.nombre,
              args.mime,
              String(args.tamanoBytes),
              args.nota ?? '',
            ],
          })
        )
        return yield* issueUploadIntentProgram(ctx, args)
      })
    ),
})

/**
 * Inspect the uploaded blob and publish it as a USER_UPLOAD version.
 * Authorization is recomputed from the principal; HMAC binds intent and storage.
 */
export const registerUploadFromServer = action({
  args: registerUploadArgs,
  handler: (ctx, args): Promise<RegisteredMcpUpload> =>
    runConvex(
      Effect.gen(function* () {
        yield* convexPromise(() =>
          requireVdrReadServerProof({
            operation: 'REGISTER_UPLOAD',
            issuedAt: args.serverIssuedAt,
            proof: args.serverProof,
            bindingParts: [args.principalId, args.intentId, args.storageId],
          })
        )
        return yield* registerUploadProgram(ctx, args)
      })
    ),
})

/** One audit row per tool invocation on the read MCP. */
export const recordReadAuditFromServer = mutation({
  args: {
    principalId: v.string(),
    clientId: v.string(),
    salaId: v.optional(v.string()),
    tool: v.string(),
    argsSha256: v.string(),
    outcome: v.union(
      v.literal('OK'),
      v.literal('DENIED'),
      v.literal('NOT_FOUND'),
      v.literal('ERROR')
    ),
    errorCode: v.optional(v.string()),
    resultSummary: v.optional(v.string()),
    ...proofArgs,
  },
  handler: (ctx, args) => runConvex(recordReadAudit(ctx, args)),
})
