// ============================================================================
// VDR READ MCP — the readonly tool facade
// ============================================================================
// `runTool(ctx, name, args)` is the ONE place the read policy lives. The MCP
// route wraps it; the in-app room assistant is expected to call the very same
// function with the very same context, so the two surfaces can never drift
// into two different authorizations of the same question.
//
// Contract:
//   - success -> { ok: true, data, citations }
//   - failure -> throws `VdrToolError` (code + suggestion, agent-correctable)
//   - authorization failure -> always the uniform NOT_FOUND
//   - write tools (`documento_subir`, `documento_confirmar`) go through the
//     same store and the same room binding; they never skip ownership.
// ============================================================================

import { Context, Effect, Schema } from 'effect'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  computeRoomProgress,
  isChecklistStageKey,
  roomProgressInputFromSala,
  type RoomProgress,
} from '@/lib/vdr/room-progress'
import {
  cellCitation,
  decodeCitations,
  documentCitation,
  excerptCitation,
  type VdrCitation,
} from '@/lib/vdr-mcp/citations'
import { VdrToolError, notFound, unsupportedDocumentError } from '@/lib/vdr-mcp/errors'
import {
  extractDocumentTextEffect,
  extractorForMimeType,
  type ExtractionError,
} from '@/lib/vdr-mcp/extract'
import {
  MODEL_MAX_CELLS_PER_CALL,
  loadWorkbookScoped,
  readRangeCellsEffect,
  requireRangeEffect,
  requireSheetEffect,
  requireWorkbookDocumentEffect,
  splitReferenceEffect,
  type WorkbookError,
  type WorkbookLoader,
  type WorkbookPort,
} from '@/lib/vdr-mcp/workbook'
import type { Room, RoomDocument, VdrReadStore } from '@/lib/vdr-mcp/store'
import { VDR_MCP_TOOL_NAMES, isVdrMcpToolName, type VdrMcpToolName } from '@/lib/vdr-mcp/oauth'
import {
  isDirectUploadMimeType,
  mcpReadableUploadLimitBytes,
  VDR_MCP_READ_MAX_BYTES,
} from '../../../convex/_documents/uploadLimits'
import esMessages from '@/messages/es.json'

const FRAGMENT_MAX_CHARS = 2_000
const SEARCH_SNIPPET_CHARS = 320
const SEARCH_MAX_DOCUMENTS = 8
const SEARCH_MAX_HITS = 25
const DOCUMENTS_PAGE_DEFAULT = 50
const DOCUMENTS_PAGE_MAX = 200

const XLSX_MIME = /spreadsheetml\.sheet|ms-excel/i

export type VdrPrincipal = Readonly<{ principalId: string; clientId: string }>

export type VdrToolContext = Readonly<{
  principal: VdrPrincipal
  /** Requested room — a `companies` id. Optional for COMPANY callers. */
  salaId?: string
  store: VdrReadStore
  /** Injectable for tests; defaults to the Mog engine in the Node runtime. */
  loadWorkbook?: WorkbookLoader
}>

class VdrToolContextService extends Context.Service<VdrToolContextService, VdrToolContext>()(
  'Sherlock/VdrToolContext'
) {}

export type VdrToolResult = Readonly<{
  ok: true
  data: Record<string, unknown>
  citations: VdrCitation[]
}>

// ===== input schemas (also published as the MCP inputSchema) =====

const boundedString = (minimum: number, maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum)))

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
  )

const strictToolSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema, { parseOptions: { onExcessProperty: 'error' } })
  )

// Cada parámetro lleva `description`: es lo único que el modelo del cliente lee sobre él en
// tools/list. `annotate` la publica junto al tipo; `annotateKey` la envuelve en un `allOf`.
const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description })

const roomScope = {
  sala_id: Schema.optionalKey(
    described(
      boundedString(1, 128),
      'Identificador de la sala, que es el de la empresa. Un cliente lo omite y se usa su propia sala. Solo el equipo lo pasa, para elegir la sala.'
    )
  ),
}

const modelDocumentId = Schema.optionalKey(
  described(
    boundedString(1, 128),
    'Identificador del XLSX, tomado de sala_documentos. Omítelo si la sala tiene un solo XLSX. Si tiene varios es obligatorio: sin él la llamada falla con ARGUMENTO_INVALIDO.'
  )
)

const sheetName = described(
  boundedString(1, 255),
  'Nombre de la hoja tal como lo devuelve modelo_hojas. No distingue mayúsculas de minúsculas.'
)

export const toolInputSchemas = {
  sala_resumen: strictToolSchema(Schema.Struct({ ...roomScope })),
  sala_documentos: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      carpeta: Schema.optionalKey(
        described(
          boundedString(1, 120),
          'Filtra por carpeta. Coincidencia exacta, sin distinguir mayúsculas, con el campo carpeta que devuelve esta misma tool. Llámala primero sin filtro para ver los valores.'
        )
      ),
      tipo: Schema.optionalKey(
        described(
          boundedString(1, 120),
          'Filtra por tipo de documento. Basta una parte del campo tipo que devuelve esta tool, por ejemplo «pdf».'
        )
      ),
      limite: Schema.optionalKey(
        described(
          boundedInt(1, DOCUMENTS_PAGE_MAX),
          `Documentos por página. Por defecto ${DOCUMENTS_PAGE_DEFAULT}.`
        )
      ),
      desde: Schema.optionalKey(
        described(
          boundedInt(0, 10_000),
          'Posición del primer documento de la página, contando desde 0. Si la respuesta trae hayMas, repite la llamada con desde más limite.'
        )
      ),
    })
  ),
  documento_buscar: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      consulta: described(
        boundedString(2, 200),
        'Términos a buscar en el texto de los documentos, por ejemplo «EBITDA 2025». Son palabras clave, no una pregunta completa.'
      ),
      documento_id: Schema.optionalKey(
        described(
          boundedString(1, 128),
          'Limita la búsqueda a un documento. Usa un documentId o versionId de sala_documentos. Sin él se busca en toda la sala.'
        )
      ),
      limite: Schema.optionalKey(
        described(boundedInt(1, SEARCH_MAX_HITS), 'Máximo de pasajes a devolver. Por defecto 10.')
      ),
    })
  ),
  documento_fragmento: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      documento_id: described(
        boundedString(1, 128),
        'Documento a leer. Usa un documentId o versionId de sala_documentos o de un resultado de documento_buscar.'
      ),
      pagina: Schema.optionalKey(
        described(
          boundedInt(1, 100_000),
          'Página a leer, contando desde 1. Por defecto la primera página con texto.'
        )
      ),
      inicio: Schema.optionalKey(
        described(
          boundedInt(0, 1_000_000),
          'Carácter de la página donde empieza el fragmento, contando desde 0. Para seguir leyendo la misma página, suma la longitud del fragmento anterior.'
        )
      ),
      longitud: Schema.optionalKey(
        described(
          boundedInt(1, FRAGMENT_MAX_CHARS),
          `Caracteres a devolver. Por defecto y como máximo ${FRAGMENT_MAX_CHARS}.`
        )
      ),
    })
  ),
  modelo_hojas: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      documento_id: modelDocumentId,
    })
  ),
  modelo_resumen: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      hoja: sheetName,
      documento_id: modelDocumentId,
    })
  ),
  modelo_rango: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      hoja: sheetName,
      rango: described(
        boundedString(2, 64),
        'Rango en notación A1 sin el nombre de la hoja, por ejemplo A4:F15. Máximo 200 celdas. El rango usado de la hoja lo da modelo_resumen.'
      ),
      documento_id: modelDocumentId,
    })
  ),
  modelo_formula: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      hoja: sheetName,
      celda: described(
        boundedString(2, 32),
        'Una sola celda en notación A1, por ejemplo C6. Un rango se rechaza: para varios valores usa modelo_rango.'
      ),
      documento_id: modelDocumentId,
    })
  ),
  modelo_metrica_canonica: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      metrica: Schema.optionalKey(
        described(
          boundedString(1, 120),
          'Nombre de la métrica, por ejemplo «EBITDA». No distingue mayúsculas ni tildes. Sin él la tool devuelve la lista de métricas que define el modelo.'
        )
      ),
      documento_id: modelDocumentId,
    })
  ),
  documento_subir: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      carpeta: described(
        Schema.Literals([
          'room_legal',
          'room_corporate',
          'room_financial',
          'room_operations',
          'room_marketing',
        ]),
        'Carpeta de destino, con el nombre que ve el cliente. room_legal es «1. Legales». room_corporate es la de corporativos: cap table e índice de la sala, y es la carpeta por defecto si ninguna otra encaja. room_financial es «3. Financieros»: estados financieros, modelo, QoE y calendario de deuda. room_operations es «4. Operaciones»: operación y documentos técnicos o de producto. room_marketing es «5. Materiales de mercadeo»: teaser y management presentation.'
      ),
      nombre: described(
        boundedString(1, 180),
        'Nombre del archivo con su extensión, como lo verá el equipo en la sala.'
      ),
      mime: described(
        boundedString(1, 120),
        'Tipo MIME del archivo, por ejemplo application/pdf. Se aceptan PDF, CSV y archivos de Office. El POST a upload_url debe llevar este mismo valor en Content-Type.'
      ),
      tamano_bytes: described(
        boundedInt(1, VDR_MCP_READ_MAX_BYTES),
        `Tamaño exacto del archivo en bytes. Un archivo subido por aquí puede pesar hasta ${VDR_MCP_READ_MAX_BYTES / (1024 * 1024)} MB.`
      ),
      nota: Schema.optionalKey(
        described(
          boundedString(1, 2_000),
          'Nota de versión que acompaña al documento en la sala: qué es y qué cambió.'
        )
      ),
    })
  ),
  documento_confirmar: strictToolSchema(
    Schema.Struct({
      ...roomScope,
      intent_id: described(boundedString(1, 128), 'El intent_id que devolvió documento_subir.'),
      storage_id: described(
        boundedString(1, 128),
        'El storageId que devolvió el POST del archivo a upload_url.'
      ),
    })
  ),
} as const

export const TOOL_DESCRIPTIONS: Record<VdrMcpToolName, string> = {
  sala_resumen:
    'Resumen de la sala de datos: empresa, carpetas con su número de documentos, avance, entregables del equipo, qué falta y el siguiente paso. Empieza siempre por aquí.',
  sala_documentos:
    'Inventario paginado de los documentos de la sala: carpeta, nombre, tipo, versión, tamaño e identificadores. Los identificadores que devuelve son los únicos válidos para las demás tools.',
  documento_buscar:
    'Busca términos en el texto de los documentos de la sala (PDF, DOCX, PPTX, texto) y devuelve pasajes con su página. Para cifras del modelo financiero usa las tools modelo_*.',
  documento_fragmento:
    'Devuelve un fragmento de hasta 2000 caracteres de un documento, por página y desplazamiento. Úsala después de documento_buscar para leer el contexto completo.',
  modelo_hojas:
    'Lista las hojas del modelo financiero de la sala, con el nombre exacto que piden las demás tools modelo_*. Si la sala tiene más de un XLSX, pasa documento_id: sin él la llamada falla.',
  modelo_resumen:
    'Resumen estructural de una hoja del modelo: dimensiones, tipos de contenido y muestra de filas. Llámala antes de pedir rangos.',
  modelo_rango:
    'Valores y fórmulas de un rango A1 acotado (máximo 200 celdas por llamada), por ejemplo hoja=Supuestos rango=A4:F15.',
  modelo_formula: 'Valor y fórmula de una celda concreta, por ejemplo hoja=Supuestos celda=C6.',
  modelo_metrica_canonica:
    'Devuelve la celda canónica de una métrica del modelo (definida como nombre en el libro o en la hoja Resumen). Úsala en lugar de adivinar entre celdas parecidas. Sin argumento devuelve la lista de métricas disponibles.',
  documento_subir:
    'Emite una URL de subida directa a una carpeta de la sala. Después de POST del archivo a upload_url, llama documento_confirmar con el intent_id y el storage_id. Requiere el alcance vdr:write.',
  documento_confirmar:
    'Registra el archivo ya subido a Convex Storage. Pasa el intent_id de documento_subir y el storage_id que devolvió el POST a upload_url. Queda como versión publicada con nota. Requiere el alcance vdr:write.',
}

// ===== helpers =====

function sanitizeText(value: string, max: number): string {
  const clean = value.replace(/\u0000/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

type VdrToolExecutionError = VdrToolError | UnexpectedAppError | ExtractionError | WorkbookError

function toolPromise<A>(
  operation: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, VdrToolError | UnexpectedAppError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof VdrToolError
        ? cause
        : new UnexpectedAppError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  }).pipe(Effect.withSpan(operation))
}

const requireRoomEffect = Effect.fn('VdrTool.requireRoom')(function* (ctx: VdrToolContext) {
  const resolved = yield* toolPromise('VdrTool.resolveRoom', () =>
    ctx.store.resolveRoom({
      principalId: ctx.principal.principalId,
      ...(ctx.salaId ? { salaId: ctx.salaId } : {}),
    })
  )
  // Uniform for every reason: no room, another company's room, a revoked
  // authorization or an unauthorized principal all read the same from outside.
  if ('code' in resolved) {
    return yield* new VdrToolError(
      'NOT_FOUND',
      'No hay una sala de datos disponible para esta sesión.',
      'Verifica que el token pertenece a la empresa correcta; si eres del equipo, pasa sala_id.'
    )
  }
  return resolved
})

const findDocumentEffect = Effect.fn('VdrTool.findDocument')(function* (
  room: Room,
  documentoId: string
) {
  const match = room.documentos.find(
    (document) => document.documentId === documentoId || document.versionId === documentoId
  )
  if (!match) return yield* notFound('El documento solicitado')
  return match
})

const resolveModelDocumentEffect = Effect.fn('VdrTool.resolveModelDocument')(function* (
  room: Room,
  documentoId?: string
) {
  if (documentoId) {
    const document = yield* findDocumentEffect(room, documentoId)
    yield* requireWorkbookDocumentEffect(document.mimeType)
    return document
  }
  const workbooks = room.documentos.filter((document) => XLSX_MIME.test(document.mimeType))
  if (workbooks.length === 1) return workbooks[0]
  if (workbooks.length === 0) {
    return yield* new VdrToolError(
      'NOT_FOUND',
      'Esta sala no tiene un modelo financiero en formato XLSX.',
      'Usa sala_documentos para ver qué documentos hay y documento_buscar para su contenido.'
    )
  }
  return yield* new VdrToolError(
    'ARGUMENTO_INVALIDO',
    'Esta sala tiene más de un modelo financiero; indica cuál con documento_id.',
    'Llama sala_documentos y pasa el documento_id del modelo que quieres leer.',
    workbooks.map((document) => `${document.nombre} (${document.documentId})`)
  )
})

// Bytes ya bajados en ESTA petición, por contexto. Un cliente MCP reusa un
// contexto por pregunta y despacha varias herramientas seguidas: sin el memo,
// las cinco herramientas de modelo bajaban el mismo libro cinco veces y Convex
// cobraba las cinco como egress de archivos. La llave es el `versionId`, que pinnea bytes inmutables —
// una versión nueva es otro id. El memo NO cruza peticiones (el WeakMap muere
// con el contexto), así que una versión publicada entre dos preguntas se ve en
// la siguiente.
const bytesByContext = new WeakMap<
  VdrToolContext,
  Map<string, { bytes: Uint8Array; mimeType: string }>
>()

function bytesMemoFor(ctx: VdrToolContext) {
  let memo = bytesByContext.get(ctx)
  if (!memo) {
    memo = new Map()
    bytesByContext.set(ctx, memo)
  }
  return memo
}

const requireBytesEffect = Effect.fn('VdrTool.requireBytes')(function* (
  ctx: VdrToolContext,
  document: RoomDocument
) {
  const memo = bytesMemoFor(ctx)
  const cached = memo.get(document.versionId)
  if (cached) return cached

  const result = yield* toolPromise('VdrTool.readVersionBytes', () =>
    ctx.store.readVersionBytes({
      principalId: ctx.principal.principalId,
      ...(ctx.salaId ? { salaId: ctx.salaId } : {}),
      documentVersionId: document.versionId,
    })
  )
  if ('code' in result) return yield* notFound('El documento solicitado')
  const bytes = { bytes: result.bytes, mimeType: result.mimeType }
  memo.set(document.versionId, bytes)
  return bytes
})

const pagesForEffect = Effect.fn('VdrTool.pagesFor')(function* (
  ctx: VdrToolContext,
  document: RoomDocument
) {
  const cached = yield* toolPromise('VdrTool.readTextIndex', () =>
    ctx.store.readTextIndex({
      documentVersionId: document.versionId,
      sha256: document.sha256,
    })
  )
  if (cached) return cached.pages

  const { bytes, mimeType } = yield* requireBytesEffect(ctx, document)
  const extraction = yield* extractDocumentTextEffect(bytes, mimeType)
  yield* toolPromise('VdrTool.writeTextIndex', () =>
    ctx.store.writeTextIndex({
      documentVersionId: document.versionId,
      sha256: document.sha256,
      extractor: extraction.extractor,
      pages: extraction.pages,
      truncated: extraction.truncated,
    })
  )
  return extraction.pages
})

type SearchOmitMotivo = 'sin texto' | 'protegido' | 'formato no soportado' | 'demasiado grande'

type SearchOmission = Readonly<{
  documentId: string
  nombre: string
  motivo: SearchOmitMotivo
}>

type SearchPages = ReadonlyArray<Readonly<{ n: number; text: string }>>

type SearchExtract =
  | { readonly _tag: 'pages'; readonly pages: SearchPages }
  | { readonly _tag: 'omit'; readonly omission: SearchOmission }

function searchOmissionFromExtraction(
  document: RoomDocument,
  error: ExtractionError
): SearchOmission {
  return {
    documentId: document.documentId,
    nombre: document.nombre,
    motivo: error.reason === 'password' ? 'protegido' : 'formato no soportado',
  }
}

function isRecoverableSearchToolError(error: VdrToolError): boolean {
  return error.code === 'FORMATO_NO_SOPORTADO' || error.code === 'ARCHIVO_DEMASIADO_GRANDE'
}

function searchOmissionFromToolError(document: RoomDocument, error: VdrToolError): SearchOmission {
  return {
    documentId: document.documentId,
    nombre: document.nombre,
    motivo: error.code === 'ARCHIVO_DEMASIADO_GRANDE' ? 'demasiado grande' : 'formato no soportado',
  }
}

// Un PDF protegido, un escaneo sin texto o un mime que no extrae no pueden
// tumbar la búsqueda de la sala: se omiten con motivo y se sigue con el resto.
const pagesForSearchEffect = Effect.fn('VdrTool.pagesForSearch')(function* (
  ctx: VdrToolContext,
  document: RoomDocument
) {
  return yield* pagesForEffect(ctx, document).pipe(
    Effect.map((pages): SearchExtract =>
      pages.length === 0
        ? {
            _tag: 'omit',
            omission: {
              documentId: document.documentId,
              nombre: document.nombre,
              motivo: 'sin texto',
            },
          }
        : { _tag: 'pages', pages }
    ),
    Effect.catchTag('ExtractionError', (error) =>
      Effect.succeed({
        _tag: 'omit' as const,
        omission: searchOmissionFromExtraction(document, error),
      })
    ),
    Effect.catchIf(
      (error): error is VdrToolError =>
        error._tag === 'VdrToolError' && isRecoverableSearchToolError(error),
      (error) =>
        Effect.succeed({
          _tag: 'omit' as const,
          omission: searchOmissionFromToolError(document, error),
        })
    )
  )
})

function normalizeTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9ñ]+/i)
        .filter((term) => term.length >= 2)
    ),
  ].slice(0, 12)
}

function foldForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

const loadWorkbookForEffect = Effect.fn('VdrTool.loadWorkbook')(function* (
  ctx: VdrToolContext,
  document: RoomDocument
) {
  yield* requireWorkbookDocumentEffect(document.mimeType)
  const { bytes } = yield* requireBytesEffect(ctx, document)
  return yield* loadWorkbookScoped(bytes, ctx.loadWorkbook)
})

// ===== tools =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function resolveRoomProgressCopy(key: string): string {
  const parts = key.split('.')
  let node: unknown = esMessages.roomProgress
  for (const part of parts) {
    if (!isRecord(node) || !(part in node)) return key
    node = node[part]
  }
  return typeof node === 'string' ? node : key
}

function salaResumenProgressFields(progress: RoomProgress) {
  return {
    avance_pct: progress.percent,
    carpetas_con_documentos: [...progress.foldersWithDocuments],
    carpetas_obligatorias_vacias: [...progress.emptyRequiredFolders],
    carpetas_opcionales_vacias: [...progress.emptyOptionalFolders],
    entregables: progress.deliverables.map((row) => ({
      nombre: esMessages.roomProgress.stages[row.key],
      estado: row.status,
    })),
    ultimo_movimiento: progress.lastMovement
      ? {
          nombre: progress.lastMovement.nombre,
          fecha: new Date(progress.lastMovement.at).toISOString(),
        }
      : null,
    siguiente_paso: resolveRoomProgressCopy(progress.siguientePaso),
  }
}

const salaResumen = Effect.fn('VdrTool.salaResumen')(function* (ctx: VdrToolContext) {
  const room = yield* requireRoomEffect(ctx)
  const progress = computeRoomProgress(
    roomProgressInputFromSala({
      phonePresent: room.telefonoPresente,
      nameConfirmed: room.nombreConfirmado,
      deliverables: room.entregables.flatMap((row) =>
        isChecklistStageKey(row.etapa) ? [{ key: row.etapa, status: row.estado }] : []
      ),
      conteosPorCarpeta: room.conteosPorCarpeta,
      ultimoMovimiento: room.ultimoMovimiento
        ? { nombre: room.ultimoMovimiento.nombre, at: room.ultimoMovimiento.actualizadoEn }
        : null,
    })
  )
  return {
    ok: true as const,
    data: {
      sala: room.sala,
      documentos: room.documentos.length,
      carpetas: Object.entries(room.conteosPorCarpeta)
        .filter(([, total]) => total > 0)
        .sort(([left], [right]) => left.localeCompare(right, 'es'))
        .map(([carpeta, total]) => ({ carpeta, documentos: total })),
      modelosFinancieros: room.documentos.filter((document) => XLSX_MIME.test(document.mimeType))
        .length,
      inventarioTruncado: room.truncado,
      ...salaResumenProgressFields(progress),
    },
    citations: [],
  }
})

const salaDocumentos = Effect.fn('VdrTool.salaDocumentos')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.sala_documentos.Type
) {
  const room = yield* requireRoomEffect(ctx)
  const limite = input.limite ?? DOCUMENTS_PAGE_DEFAULT
  const desde = input.desde ?? 0
  const filtered = room.documentos.filter(
    (document) =>
      (!input.carpeta || document.carpeta.toLowerCase() === input.carpeta.toLowerCase()) &&
      (!input.tipo || document.tipo.toLowerCase().includes(input.tipo.toLowerCase()))
  )
  const page = filtered.slice(desde, desde + limite)

  return {
    ok: true as const,
    data: {
      total: filtered.length,
      desde,
      limite,
      hayMas: desde + page.length < filtered.length,
      documentos: page,
    },
    citations: page.map((document) => documentCitation(document.documentId, document.versionId)),
  }
})

const documentoBuscar = Effect.fn('VdrTool.documentoBuscar')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.documento_buscar.Type
) {
  const room = yield* requireRoomEffect(ctx)
  const terms = normalizeTerms(input.consulta)
  if (terms.length === 0) {
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      'La consulta no contiene términos buscables.',
      'Escribe al menos una palabra de dos o más caracteres.'
    )
  }

  const selectedDocument = input.documento_id
    ? yield* findDocumentEffect(room, input.documento_id)
    : undefined
  const scope = selectedDocument
    ? [selectedDocument]
    : room.documentos.filter((document) => extractorForMimeType(document.mimeType) !== null)
  const candidates = scope
    .filter((document) => extractorForMimeType(document.mimeType) !== null)
    .slice(0, SEARCH_MAX_DOCUMENTS)

  const limite = input.limite ?? 10
  // Cada acierto viaja con SU cita: ordenar dos listas por separado dejaba la
  // cita número uno apuntando a un documento distinto del resultado número uno,
  // y el modelo citaba el archivo equivocado con una cita perfectamente válida.
  const found: Array<{
    hit: Record<string, unknown>
    citation: VdrCitation
    documentId: string
    page: number
    matches: number
  }> = []
  const perDocument = new Map<string, { matches: number; pages: number; order: number }>()
  const omitidos: SearchOmission[] = []

  for (const [order, document] of candidates.entries()) {
    const extracted = yield* pagesForSearchEffect(ctx, document)
    if (extracted._tag === 'omit') {
      omitidos.push(extracted.omission)
      continue
    }
    const pages = extracted.pages
    for (const page of pages) {
      const folded = foldForSearch(page.text)
      const matched = terms.filter((term) => folded.includes(term))
      if (matched.length === 0) continue
      const first = folded.indexOf(matched[0])
      const start = Math.max(0, first - 80)
      const end = Math.min(page.text.length, start + SEARCH_SNIPPET_CHARS)
      const totals = perDocument.get(document.documentId) ?? { matches: 0, pages: 0, order }
      totals.matches += matched.length
      totals.pages += 1
      perDocument.set(document.documentId, totals)
      found.push({
        documentId: document.documentId,
        page: page.n,
        matches: matched.length,
        hit: {
          documentId: document.documentId,
          versionId: document.versionId,
          nombre: document.nombre,
          carpeta: document.carpeta,
          pagina: page.n,
          coincidencias: matched.length,
          pasaje: sanitizeText(page.text.slice(start, end), SEARCH_SNIPPET_CHARS),
          inicio: start,
          fin: end,
        },
        citation: excerptCitation({
          documentId: document.documentId,
          versionId: document.versionId,
          page: page.n,
          start,
          end,
        }),
      })
    }
  }

  // El documento manda sobre la página: primero el archivo que más veces
  // coincide, y dentro de él sus páginas en orden. Así el modelo no tiene que
  // adivinar cuál de dos documentos parecidos es el que responde la pregunta.
  const documentScore = (documentId: string) => perDocument.get(documentId)?.matches ?? 0
  const documentOrder = (documentId: string) => perDocument.get(documentId)?.order ?? 0
  found.sort(
    (left, right) =>
      documentScore(right.documentId) - documentScore(left.documentId) ||
      documentOrder(left.documentId) - documentOrder(right.documentId) ||
      right.matches - left.matches ||
      left.page - right.page
  )

  if (candidates.length > 0 && omitidos.length === candidates.length) {
    return yield* unsupportedDocumentError()
  }

  const page = found.slice(0, limite)
  const documentos = [...perDocument.entries()]
    .map(([documentId, totals]) => ({
      documentId,
      nombre: candidates.find((candidate) => candidate.documentId === documentId)?.nombre ?? '',
      coincidencias: totals.matches,
      paginas: totals.pages,
    }))
    .sort((left, right) => right.coincidencias - left.coincidencias)

  return {
    ok: true as const,
    data: {
      consulta: input.consulta,
      terminos: terms,
      documentosRevisados: candidates.length - omitidos.length,
      documentosOmitidos: Math.max(0, scope.length - candidates.length),
      omitidos,
      total: found.length,
      documentos,
      resultados: page.map((entry) => entry.hit),
    },
    citations: [...decodeCitations(page.map((entry) => entry.citation))],
  }
})

const documentoFragmento = Effect.fn('VdrTool.documentoFragmento')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.documento_fragmento.Type
) {
  const room = yield* requireRoomEffect(ctx)
  const document = yield* findDocumentEffect(room, input.documento_id)
  const pages = yield* pagesForEffect(ctx, document)
  if (pages.length === 0) {
    return yield* new VdrToolError(
      'FORMATO_NO_SOPORTADO',
      `«${document.nombre}» no tiene texto indexable.`,
      'Si es una hoja de cálculo usa las tools modelo_*; si es una imagen, no hay texto que leer.'
    )
  }

  const pagina = input.pagina ?? pages[0].n
  const page = pages.find((candidate) => candidate.n === pagina)
  if (!page) {
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      `La página ${pagina} no existe en «${document.nombre}» (tiene ${pages.length}).`,
      `Pide una página entre ${pages[0].n} y ${pages[pages.length - 1].n}.`
    )
  }

  const inicio = Math.min(input.inicio ?? 0, page.text.length)
  const longitud = Math.min(input.longitud ?? FRAGMENT_MAX_CHARS, FRAGMENT_MAX_CHARS)
  const fin = Math.min(page.text.length, inicio + longitud)
  const texto = page.text.slice(inicio, fin)

  return {
    ok: true as const,
    data: {
      documentId: document.documentId,
      versionId: document.versionId,
      nombre: document.nombre,
      pagina: page.n,
      paginas: pages.length,
      inicio,
      fin,
      hayMas: fin < page.text.length,
      texto,
    },
    citations: [
      excerptCitation({
        documentId: document.documentId,
        versionId: document.versionId,
        page: page.n,
        start: inicio,
        end: fin,
      }),
    ],
  }
})

const modeloHojas = Effect.fn('VdrTool.modeloHojas')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.modelo_hojas.Type
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const room = yield* requireRoomEffect(ctx)
      const document = yield* resolveModelDocumentEffect(room, input.documento_id)
      const workbook = yield* loadWorkbookForEffect(ctx, document)
      return {
        ok: true as const,
        data: {
          documentId: document.documentId,
          versionId: document.versionId,
          nombre: document.nombre,
          hojas: workbook.sheetNames,
        },
        citations: [documentCitation(document.documentId, document.versionId)],
      }
    })
  )
})

const modeloResumen = Effect.fn('VdrTool.modeloResumen')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.modelo_resumen.Type
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const room = yield* requireRoomEffect(ctx)
      const document = yield* resolveModelDocumentEffect(room, input.documento_id)
      const workbook = yield* loadWorkbookForEffect(ctx, document)
      const { sheet, name } = yield* requireSheetEffect(workbook, input.hoja)
      const summary = yield* toolPromise('VdrTool.sheetSummary', () => sheet.summarize())
      const resumen = sanitizeText(summary, 4_000)
      const usedRange = /Used Range:\s*([A-Z]+\d+(?::[A-Z]+\d+)?)/i.exec(resumen)?.[1]
      return {
        ok: true as const,
        data: {
          documentId: document.documentId,
          versionId: document.versionId,
          hoja: name,
          resumen,
        },
        citations: [
          usedRange
            ? cellCitation(document.documentId, document.versionId, name, usedRange)
            : documentCitation(document.documentId, document.versionId),
        ],
      }
    })
  )
})

const modeloRango = Effect.fn('VdrTool.modeloRango')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.modelo_rango.Type
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const room = yield* requireRoomEffect(ctx)
      const document = yield* resolveModelDocumentEffect(room, input.documento_id)
      const range = yield* requireRangeEffect(input.rango)
      const workbook = yield* loadWorkbookForEffect(ctx, document)
      const { sheet, name } = yield* requireSheetEffect(workbook, input.hoja)
      const celdas = yield* readRangeCellsEffect(sheet, range)
      return {
        ok: true as const,
        data: {
          documentId: document.documentId,
          versionId: document.versionId,
          hoja: name,
          rango: range.normalized,
          celdas,
          totalCeldas: celdas.length,
          maximoPorLlamada: MODEL_MAX_CELLS_PER_CALL,
        },
        citations: [cellCitation(document.documentId, document.versionId, name, range.normalized)],
      }
    })
  )
})

const modeloFormula = Effect.fn('VdrTool.modeloFormula')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.modelo_formula.Type
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const room = yield* requireRoomEffect(ctx)
      const document = yield* resolveModelDocumentEffect(room, input.documento_id)
      const range = yield* requireRangeEffect(input.celda)
      if (range.cells !== 1) {
        return yield* new VdrToolError(
          'RANGO_INVALIDO',
          `«${input.celda}» no es una celda individual.`,
          'Pasa una sola celda, por ejemplo C6, o usa modelo_rango para un rango.'
        )
      }
      const workbook = yield* loadWorkbookForEffect(ctx, document)
      const { sheet, name } = yield* requireSheetEffect(workbook, input.hoja)
      const [celda] = yield* readRangeCellsEffect(sheet, range)
      return {
        ok: true as const,
        data: {
          documentId: document.documentId,
          versionId: document.versionId,
          hoja: name,
          celda: celda.celda,
          valor: celda.valor,
          formula: celda.formula,
          esInput: celda.formula === null,
        },
        citations: [cellCitation(document.documentId, document.versionId, name, celda.celda)],
      }
    })
  )
})

const SUMMARY_SHEETS = ['Resumen', 'Summary']

const canonicalMetrics = Effect.fn('VdrTool.canonicalMetrics')(function* (workbook: WorkbookPort) {
  const defined = yield* toolPromise('VdrTool.definedNames', () => workbook.definedNames())
  const fromNames: Array<{
    metrica: string
    hoja: string
    rango: string
    origen: 'NOMBRE'
  }> = []
  for (const entry of defined) {
    const reference = yield* splitReferenceEffect(entry.reference)
    if (!reference || !workbook.sheetNames.includes(reference.sheet)) continue
    fromNames.push({
      metrica: entry.name,
      hoja: reference.sheet,
      rango: reference.range,
      origen: 'NOMBRE',
    })
  }
  if (fromNames.length > 0) return fromNames

  const summarySheet = workbook.sheetNames.find((name) =>
    SUMMARY_SHEETS.some((candidate) => candidate.toLowerCase() === name.toLowerCase())
  )
  if (!summarySheet) return []

  const sheet = yield* toolPromise('VdrTool.summarySheet', () => workbook.sheet(summarySheet))
  const rows: Array<{ metrica: string; hoja: string; rango: string; origen: 'RESUMEN' }> = []
  for (let row = 1; row <= 60; row += 1) {
    const [label, value] = yield* Effect.all(
      [
        toolPromise('VdrTool.metricLabel', () => sheet.getValue(`A${row}`)),
        toolPromise('VdrTool.metricValue', () => sheet.getValue(`B${row}`)),
      ] as const,
      { concurrency: 2 }
    )
    if (typeof label !== 'string' || label.trim().length === 0) continue
    if (value === null || value === undefined || value === '') continue
    rows.push({ metrica: label.trim(), hoja: summarySheet, rango: `B${row}`, origen: 'RESUMEN' })
  }
  return rows
})

const modeloMetricaCanonica = Effect.fn('VdrTool.modeloMetricaCanonica')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.modelo_metrica_canonica.Type
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const room = yield* requireRoomEffect(ctx)
      const document = yield* resolveModelDocumentEffect(room, input.documento_id)
      const workbook = yield* loadWorkbookForEffect(ctx, document)
      const metrics = yield* canonicalMetrics(workbook)
      if (!input.metrica) {
        return {
          ok: true as const,
          data: {
            documentId: document.documentId,
            versionId: document.versionId,
            metricas: metrics,
            total: metrics.length,
          },
          citations: [documentCitation(document.documentId, document.versionId)],
        }
      }

      const wanted = foldForSearch(input.metrica)
      const match =
        metrics.find((metric) => foldForSearch(metric.metrica) === wanted) ??
        metrics.find((metric) => foldForSearch(metric.metrica).includes(wanted))
      if (!match) {
        return yield* new VdrToolError(
          'METRICA_DESCONOCIDA',
          `El modelo no define una métrica canónica llamada «${input.metrica}».`,
          'Llama modelo_metrica_canonica sin argumentos para ver las métricas disponibles, o usa modelo_rango sobre la hoja correspondiente.',
          metrics.map((metric) => metric.metrica)
        )
      }

      const { sheet, name } = yield* requireSheetEffect(workbook, match.hoja)
      const range = yield* requireRangeEffect(match.rango)
      const celdas = yield* readRangeCellsEffect(sheet, range)
      return {
        ok: true as const,
        data: {
          documentId: document.documentId,
          versionId: document.versionId,
          metrica: match.metrica,
          origen: match.origen,
          hoja: name,
          rango: range.normalized,
          celdas,
        },
        citations: [cellCitation(document.documentId, document.versionId, name, range.normalized)],
      }
    })
  )
})

const UPLOAD_INSTRUCTIONS =
  'Haz POST del archivo a upload_url con cabecera Content-Type igual al mime. La respuesta JSON trae storageId. Luego llama documento_confirmar con intent_id y ese storageId.'

const documentoSubir = Effect.fn('VdrTool.documentoSubir')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.documento_subir.Type
) {
  const mime = input.mime.trim().toLowerCase()
  if (!isDirectUploadMimeType(mime)) {
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      `El tipo «${input.mime}» no está permitido en la sala.`,
      'Usa PDF, CSV o un archivo de Office (Word, Excel, PowerPoint).'
    )
  }
  if (input.tamano_bytes > mcpReadableUploadLimitBytes(mime)) {
    return yield* new VdrToolError(
      'ARCHIVO_DEMASIADO_GRANDE',
      'El archivo supera el límite de lectura de la sala.',
      `Un archivo subido por aquí puede pesar hasta ${VDR_MCP_READ_MAX_BYTES / (1024 * 1024)} MB.`
    )
  }

  const result = yield* toolPromise('VdrTool.issueUploadIntent', () =>
    ctx.store.issueUploadIntent({
      principalId: ctx.principal.principalId,
      ...(ctx.salaId ? { salaId: ctx.salaId } : {}),
      carpeta: input.carpeta,
      nombre: input.nombre,
      mime,
      tamanoBytes: input.tamano_bytes,
      ...(input.nota ? { nota: input.nota } : {}),
    })
  )
  if ('registered' in result) {
    if (result.code === 'FILE_TOO_LARGE') {
      return yield* new VdrToolError(
        'ARCHIVO_DEMASIADO_GRANDE',
        'El archivo supera el límite de la sala.',
        'Revisa tamano_bytes y el mime.'
      )
    }
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      'No se pudo emitir la URL de subida.',
      'Revisa carpeta, mime y tamano_bytes.',
      [result.code]
    )
  }
  if (!('intentId' in result)) {
    return yield* new VdrToolError(
      'NOT_FOUND',
      'No hay una sala de datos disponible para esta sesión.',
      'Verifica que el token pertenece a la empresa correcta; si eres del equipo, pasa sala_id.'
    )
  }

  return {
    ok: true as const,
    data: {
      upload_url: result.uploadUrl,
      storage_id_placeholder: 'pendiente_del_POST',
      intent_id: result.intentId,
      expira_en: new Date(result.expiresAt).toISOString(),
      instrucciones: UPLOAD_INSTRUCTIONS,
    },
    citations: [],
  }
})

const documentoConfirmar = Effect.fn('VdrTool.documentoConfirmar')(function* (
  ctx: VdrToolContext,
  input: typeof toolInputSchemas.documento_confirmar.Type
) {
  const result = yield* toolPromise('VdrTool.registerUpload', () =>
    ctx.store.registerUpload({
      principalId: ctx.principal.principalId,
      ...(ctx.salaId ? { salaId: ctx.salaId } : {}),
      intentId: input.intent_id,
      storageId: input.storage_id,
    })
  )
  if ('registered' in result) {
    if (result.code === 'FILE_TOO_LARGE') {
      return yield* new VdrToolError(
        'ARCHIVO_DEMASIADO_GRANDE',
        'El archivo subido supera el límite de la sala.',
        'Sube un archivo más pequeño y vuelve a emitir un intent.'
      )
    }
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      'No se pudo registrar el archivo subido.',
      'Confirma que el POST a upload_url devolvió este storage_id y que el mime coincide.',
      [result.code]
    )
  }
  if (!('documentId' in result)) {
    return yield* new VdrToolError(
      'NOT_FOUND',
      'No hay una sala de datos disponible para esta sesión.',
      'Verifica que el token pertenece a la empresa correcta y que el intent_id es el que te devolvió documento_subir.'
    )
  }

  return {
    ok: true as const,
    data: {
      document_id: result.documentId,
      version_id: result.versionId,
      version_numero: result.versionNumero,
      nombre: result.nombre,
      carpeta: result.carpeta,
    },
    citations: [],
  }
})

// ===== dispatch =====

const HANDLERS: Record<
  VdrMcpToolName,
  (ctx: VdrToolContext, input: never) => Effect.Effect<VdrToolResult, VdrToolExecutionError>
> = {
  sala_resumen: (ctx) => salaResumen(ctx),
  sala_documentos: salaDocumentos as never,
  documento_buscar: documentoBuscar as never,
  documento_fragmento: documentoFragmento as never,
  modelo_hojas: modeloHojas as never,
  modelo_resumen: modeloResumen as never,
  modelo_rango: modeloRango as never,
  modelo_formula: modeloFormula as never,
  modelo_metrica_canonica: modeloMetricaCanonica as never,
  documento_subir: (ctx, input) => documentoSubir(ctx, input),
  documento_confirmar: (ctx, input) => documentoConfirmar(ctx, input),
}

/**
 * Run one read tool. The single policy seam shared by the MCP route and the
 * in-app room assistant.
 *
 * `args.sala_id` narrows the room only within what the
 * caller is already authorized for — the server re-derives the room on every
 * Convex call and answers NOT_FOUND for anything outside it.
 */
const runToolProgram = Effect.fn('VdrTool.run')(function* (name: string, args: unknown) {
  const ctx = yield* VdrToolContextService
  if (!isVdrMcpToolName(name)) {
    return yield* new VdrToolError(
      'ARGUMENTO_INVALIDO',
      `«${name}» no es una tool de esta sala.`,
      'Las tools disponibles son: ' + VDR_MCP_TOOL_NAMES.join(', ') + '.',
      [...VDR_MCP_TOOL_NAMES]
    )
  }

  const decoded = yield* Schema.decodeUnknownEffect(toolInputSchemas[name], {
    errors: 'all',
    onExcessProperty: 'error',
  })(args ?? {}).pipe(
    Effect.mapError(
      (cause) =>
        new VdrToolError(
          'ARGUMENTO_INVALIDO',
          `Los argumentos de ${name} no son válidos.`,
          cause.message
        )
    )
  )

  const input = decoded as { sala_id?: string }
  const scopedContext: VdrToolContext = {
    ...ctx,
    ...(input.sala_id ? { salaId: input.sala_id } : {}),
  }
  // El contexto con alcance es OTRO objeto: cada tool de la misma petición
  // llegaba con memo vacío y se volvía a bajar el mismo libro.
  bytesByContext.set(scopedContext, bytesMemoFor(ctx))

  return yield* HANDLERS[name](scopedContext, decoded as never)
})

export function runToolEffect(ctx: VdrToolContext, name: string, args: unknown) {
  return runToolProgram(name, args).pipe(Effect.provideService(VdrToolContextService, ctx))
}

export async function runTool(
  ctx: VdrToolContext,
  name: string,
  args: unknown
): Promise<VdrToolResult> {
  const outcome = await runServerEffect(
    runToolEffect(ctx, name, args).pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (outcome.ok) return outcome.value
  throw outcome.error
}

export type { VdrMcpToolName }
