// ============================================================================
// VDR READ MCP — Convex access layer
// ============================================================================
// The only bridge between the MCP surface and durable state. Every call is
// signed with the VDR read server proof and every response is parsed before
// it reaches a tool, so a shape change in Convex can never leak untyped data
// into a tool result.
//
// Convex owns the data lifecycle and keeps owning it: Effect wraps the client
// here, it does not replace it, and nothing in `convex/` changes. What Effect
// adds is the part that was missing — a per-attempt timeout, a retry that only
// fires on transport failures, and a log that says which of the five calls
// broke and why. See `runtime.ts`.
// ============================================================================

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { Effect, Schema } from 'effect'

import { convexCall, parseResponse, runStore } from '@/lib/vdr-mcp/runtime'
import { createVdrReadServerProof } from '@/lib/vdr-mcp/server-proof'
import { VDR_MCP_READ_MAX_BYTES } from '../../../convex/_documents/uploadLimits'

const VDR_MCP_MAX_DOCUMENT_BYTES = VDR_MCP_READ_MAX_BYTES

const roomDocumentSchema = Schema.Struct({
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

const roomSchema = Schema.Struct({
  sala: Schema.Struct({
    salaId: Schema.String,
    empresa: Schema.String,
    pais: Schema.String,
    rol: Schema.String,
  }),
  documentos: Schema.Array(roomDocumentSchema),
  truncado: Schema.Boolean,
  telefonoPresente: Schema.Boolean,
  nombreConfirmado: Schema.Boolean,
  entregables: Schema.Array(
    Schema.Struct({
      etapa: Schema.String,
      estado: Schema.String,
      publicadoEn: Schema.optionalKey(Schema.Number),
    })
  ),
  conteosPorCarpeta: Schema.Record(Schema.String, Schema.Number),
  ultimoMovimiento: Schema.NullOr(
    Schema.Struct({
      nombre: Schema.String,
      actualizadoEn: Schema.Number,
    })
  ),
})

const failureSchema = Schema.Struct({ code: Schema.Literals(['DENIED', 'NOT_FOUND']) })
const roomResultSchema = Schema.Union([failureSchema, roomSchema])

const bytesSchema = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(false), code: Schema.Literals(['DENIED', 'NOT_FOUND']) }),
  Schema.Struct({
    allowed: Schema.Literal(true),
    bytes: Schema.Union([Schema.instanceOf(ArrayBuffer), Schema.Uint8Array]),
    mimeType: Schema.String,
    sha256: Schema.String,
    documentId: Schema.String,
  }),
])

const textIndexSchema = Schema.Union([
  Schema.Struct({ found: Schema.Literal(false) }),
  Schema.Struct({
    found: Schema.Literal(true),
    pages: Schema.Array(Schema.Struct({ n: Schema.Number, text: Schema.String })),
    truncated: Schema.Boolean,
  }),
])

const issuedUploadSchema = Schema.Union([
  failureSchema,
  Schema.Struct({
    registered: Schema.Literal(false),
    code: Schema.String,
  }),
  Schema.Struct({
    intentId: Schema.String,
    uploadUrl: Schema.String,
    expiresAt: Schema.Number,
  }),
])

const registeredUploadSchema = Schema.Union([
  failureSchema,
  Schema.Struct({
    registered: Schema.Literal(false),
    code: Schema.String,
  }),
  Schema.Struct({
    documentId: Schema.String,
    versionId: Schema.String,
    versionNumero: Schema.Number,
    nombre: Schema.String,
    carpeta: Schema.String,
  }),
])

export type RoomDocument = typeof roomDocumentSchema.Type
export type Room = typeof roomSchema.Type
type VdrReadFailure = typeof failureSchema.Type

type IssuedUpload = Exclude<typeof issuedUploadSchema.Type, VdrReadFailure>
type RegisteredUpload = Exclude<typeof registeredUploadSchema.Type, VdrReadFailure>

type VersionBytes = Readonly<{
  bytes: Uint8Array
  mimeType: string
  sha256: string
  documentId: string
}>

export type VdrReadStore = Readonly<{
  resolveRoom: (args: {
    principalId: string
    salaId?: string
  }) => Promise<Room | VdrReadFailure>
  readVersionBytes: (args: {
    principalId: string
    salaId?: string
    documentVersionId: string
  }) => Promise<VersionBytes | VdrReadFailure>
  readTextIndex: (args: {
    documentVersionId: string
    sha256: string
  }) => Promise<{ pages: Array<{ n: number; text: string }>; truncated: boolean } | null>
  writeTextIndex: (args: {
    documentVersionId: string
    sha256: string
    extractor: 'PDF' | 'DOCX' | 'PPTX' | 'TXT'
    pages: Array<{ n: number; text: string }>
    truncated: boolean
  }) => Promise<void>
  recordAudit: (args: {
    principalId: string
    clientId: string
    salaId?: string
    tool: string
    argsSha256: string
    outcome: 'OK' | 'DENIED' | 'NOT_FOUND' | 'ERROR'
    errorCode?: string
    resultSummary?: string
  }) => Promise<void>
  issueUploadIntent: (args: {
    principalId: string
    salaId?: string
    carpeta: string
    nombre: string
    mime: string
    tamanoBytes: number
    nota?: string
  }) => Promise<IssuedUpload | VdrReadFailure>
  registerUpload: (args: {
    principalId: string
    salaId?: string
    intentId: string
    storageId: string
  }) => Promise<RegisteredUpload | VdrReadFailure>
}>

type ProofArgs = { serverIssuedAt: number; serverProof: string }

const resolveRoomRef = makeFunctionReference<
  'query',
  { principalId: string; salaId?: string } & ProofArgs,
  unknown
>('vdrRead:resolveRoomFromServer')

const readBytesRef = makeFunctionReference<
  'action',
  {
    principalId: string
    salaId?: string
    documentVersionId: string
  } & ProofArgs,
  unknown
>('vdrRead:readVersionBytesFromServer')

const readIndexRef = makeFunctionReference<
  'query',
  { documentVersionId: string; sha256: string } & ProofArgs,
  unknown
>('vdrRead:readTextIndexFromServer')

const writeIndexRef = makeFunctionReference<
  'mutation',
  {
    documentVersionId: string
    sha256: string
    extractor: 'PDF' | 'DOCX' | 'PPTX' | 'TXT'
    pages: Array<{ n: number; text: string }>
    truncated: boolean
  } & ProofArgs,
  unknown
>('vdrRead:writeTextIndexFromServer')

const auditRef = makeFunctionReference<
  'mutation',
  {
    principalId: string
    clientId: string
    salaId?: string
    tool: string
    argsSha256: string
    outcome: 'OK' | 'DENIED' | 'NOT_FOUND' | 'ERROR'
    errorCode?: string
    resultSummary?: string
  } & ProofArgs,
  unknown
>('vdrRead:recordReadAuditFromServer')

const issueUploadRef = makeFunctionReference<
  'mutation',
  {
    principalId: string
    salaId?: string
    carpeta: string
    nombre: string
    mime: string
    tamanoBytes: number
    nota?: string
  } & ProofArgs,
  unknown
>('vdrRead:issueUploadIntentFromServer')

const registerUploadRef = makeFunctionReference<
  'action',
  {
    principalId: string
    salaId?: string
    intentId: string
    storageId: string
  } & ProofArgs,
  unknown
>('vdrRead:registerUploadFromServer')

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) throw new Error('VDR_MCP_CONVEX_UNAVAILABLE')
  return new ConvexHttpClient(url)
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export function createConvexVdrReadStore(
  args: { client?: Pick<ConvexHttpClient, 'query' | 'mutation' | 'action'> } = {}
): VdrReadStore {
  const client = args.client ?? convexClient()

  return {
    resolveRoom: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'RESOLVE_BINDING',
        bindingParts: [input.principalId, input.salaId ?? ''],
      })
      return runStore(
        convexCall('resolveRoom', () =>
          client.query(resolveRoomRef, omitUndefined({ ...input, ...proof }))
        ).pipe(Effect.flatMap((raw) => parseResponse('resolveRoom', roomResultSchema, raw)))
      )
    },

    readVersionBytes: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'READ_VERSION_BYTES',
        bindingParts: [input.principalId, input.salaId ?? '', input.documentVersionId],
      })
      return runStore(
        convexCall('readVersionBytes', () =>
          client.action(readBytesRef, omitUndefined({ ...input, ...proof }))
        ).pipe(
          Effect.flatMap((raw) => parseResponse('readVersionBytes', bytesSchema, raw)),
          Effect.map((parsed): VersionBytes | VdrReadFailure => {
            if (!parsed.allowed) return { code: parsed.code }
            const bytes =
              parsed.bytes instanceof Uint8Array ? parsed.bytes : new Uint8Array(parsed.bytes)
            if (bytes.byteLength > VDR_MCP_MAX_DOCUMENT_BYTES) return { code: 'NOT_FOUND' }
            return {
              bytes,
              mimeType: parsed.mimeType,
              sha256: parsed.sha256,
              documentId: parsed.documentId,
            }
          })
        )
      )
    },

    readTextIndex: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'READ_TEXT_INDEX',
        bindingParts: [input.documentVersionId, input.sha256],
      })
      return runStore(
        convexCall('readTextIndex', () => client.query(readIndexRef, { ...input, ...proof })).pipe(
          Effect.flatMap((raw) => parseResponse('readTextIndex', textIndexSchema, raw)),
          Effect.map((parsed) =>
            parsed.found ? { pages: [...parsed.pages], truncated: parsed.truncated } : null
          )
        )
      )
    },

    writeTextIndex: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'WRITE_TEXT_INDEX',
        bindingParts: [input.documentVersionId, input.sha256, input.extractor],
      })
      return runStore(
        convexCall('writeTextIndex', () =>
          client.mutation(writeIndexRef, { ...input, ...proof })
        ).pipe(Effect.asVoid)
      )
    },

    recordAudit: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'AUDIT_TOOL',
        bindingParts: [
          input.principalId,
          input.clientId,
          input.tool,
          input.argsSha256,
          input.outcome,
        ],
      })
      // Sin reintento a propósito. `recordReadAuditFromServer` hace un insert
      // pelado en `vdrReadAudits`, sin llave de idempotencia, y la cota de 8 s
      // no cancela la mutación del otro lado: un reintento sobre una llamada
      // que sí commiteó deja dos filas para una sola invocación de tool. Una
      // fila de auditoría perdida por un corte de transporte es menos daño que
      // un registro que cuenta de más.
      return runStore(
        convexCall(
          'recordAudit',
          () => client.mutation(auditRef, omitUndefined({ ...input, ...proof })),
          { retries: 0 }
        ).pipe(Effect.asVoid)
      )
    },

    issueUploadIntent: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'ISSUE_UPLOAD_INTENT',
        bindingParts: [
          input.principalId,
          input.salaId ?? '',
          input.carpeta,
          input.nombre,
          input.mime,
          String(input.tamanoBytes),
          input.nota ?? '',
        ],
      })
      return runStore(
        convexCall(
          'issueUploadIntent',
          () => client.mutation(issueUploadRef, omitUndefined({ ...input, ...proof })),
          { retries: 0 }
        ).pipe(Effect.flatMap((raw) => parseResponse('issueUploadIntent', issuedUploadSchema, raw)))
      )
    },

    registerUpload: (input) => {
      const proof = createVdrReadServerProof({
        operation: 'REGISTER_UPLOAD',
        bindingParts: [input.principalId, input.intentId, input.storageId],
      })
      return runStore(
        convexCall(
          'registerUpload',
          () => client.action(registerUploadRef, omitUndefined({ ...input, ...proof })),
          { retries: 0 }
        ).pipe(
          Effect.flatMap((raw) => parseResponse('registerUpload', registeredUploadSchema, raw))
        )
      )
    },
  }
}
