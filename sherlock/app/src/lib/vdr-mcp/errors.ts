// ============================================================================
// VDR READ MCP — correctable tool errors
// ============================================================================
// Tool failures are returned as tool results (`isError: true`), never as
// JSON-RPC errors: the agent on the other side must be able to read the code,
// the suggestion and the available options and retry by itself.
//
// Authorization failures always collapse into NOT_FOUND with the same wording,
// so "exists but not yours" is never distinguishable from "does not exist".
//
// `VdrToolError` is an Effect tagged error ([F] 2026-09-08,
// `docs/plans/2026-09-08-effect-adopcion-plan.md`). The tag is what lets the
// rest of this module put the failure in the type signature instead of in an
// `unknown` catch: an expected failure is `Effect<A, VdrToolError>` and can be
// recovered with `Effect.catchTag`, while anything else stays a defect.
// The positional constructor is kept on purpose so the eighteen call sites in
// `tools.ts`, `extract.ts` and `workbook.ts` do not move in this step.
// ============================================================================

import { Schema } from 'effect'

import type { UnexpectedAppError } from '@/lib/effect/errors'
import type { ExtractionError } from '@/lib/vdr-mcp/extract'
import type { WorkbookError } from '@/lib/vdr-mcp/workbook'

const VdrToolErrorCodeSchema = Schema.Literals([
  'NOT_FOUND',
  'ARGUMENTO_INVALIDO',
  'HOJA_DESCONOCIDA',
  'RANGO_INVALIDO',
  'RANGO_DEMASIADO_GRANDE',
  'METRICA_DESCONOCIDA',
  'FORMATO_NO_SOPORTADO',
  'ARCHIVO_DEMASIADO_GRANDE',
  'NO_DISPONIBLE',
])

export type VdrToolErrorCode = typeof VdrToolErrorCodeSchema.Type

export const VdrToolErrorPayloadSchema = Schema.Struct({
  code: VdrToolErrorCodeSchema,
  mensaje: Schema.String,
  sugerencia: Schema.String,
  opciones: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type VdrToolErrorPayload = typeof VdrToolErrorPayloadSchema.Type

// The fields live in the schema, never as redeclared class properties: the
// base assigns them in its own constructor and a redeclaration without an
// initializer would blank them out.
export class VdrToolError extends Schema.TaggedError<VdrToolError>()('VdrToolError', {
  code: VdrToolErrorCodeSchema,
  message: Schema.String,
  sugerencia: Schema.String,
  opciones: Schema.optionalKey(Schema.Array(Schema.String)),
}) {
  constructor(
    code: VdrToolErrorCode,
    mensaje: string,
    sugerencia: string,
    opciones?: readonly string[]
  ) {
    super({
      code,
      message: mensaje,
      sugerencia,
      ...(opciones ? { opciones: opciones.slice(0, 50) } : {}),
    })
  }

  toPayload(): VdrToolErrorPayload {
    return {
      code: this.code,
      mensaje: this.message,
      sugerencia: this.sugerencia,
      ...(this.opciones ? { opciones: [...this.opciones] } : {}),
    }
  }
}

/** The one uniform denial. Never say whether the id exists elsewhere. */
export function notFound(que = 'El recurso solicitado'): VdrToolError {
  return new VdrToolError(
    'NOT_FOUND',
    `${que} no existe en esta sala.`,
    'Usa sala_documentos para obtener los identificadores válidos de esta sala.'
  )
}

/** Same payload `toToolErrorPayload` ships for an unreadable blob. */
export function unsupportedDocumentError(): VdrToolError {
  return new VdrToolError(
    'FORMATO_NO_SOPORTADO',
    'No puedo leer el contenido de este documento: el archivo está dañado o su formato interno no es legible.',
    'Usa sala_documentos para elegir otro documento de la sala, o documento_buscar si el dato que necesitas también está en otro archivo.'
  )
}

/**
 * Every way a read tool can fail, as the compiler sees it. Four members, all
 * tagged: `VdrToolError` is an answer the agent acts on, the other three are
 * ours to fix. The union is the point — while the parameter was `unknown` this
 * function had a blind `else`, and that `else` is why `documento_buscar` and
 * `modelo_hojas` failed in the lambda for an hour saying only NO_DISPONIBLE.
 */
export type VdrToolFailure = VdrToolError | UnexpectedAppError | ExtractionError | WorkbookError

/** The one payload for a failure the agent cannot act on. */
const noDisponible: VdrToolErrorPayload = {
  code: 'NO_DISPONIBLE',
  mensaje: 'La operación no está disponible.',
  sugerencia: 'Reintenta más tarde o usa sala_resumen para verificar el estado de la sala.',
}

/**
 * The defect boundary, and where each failure earns a code the agent can use
 * ([F] 2026-09-08). The split is by what the agent can do next, not by which
 * module threw:
 *
 * - `ExtractionError` — every one of its eleven sites means the same thing:
 *   the bytes of this document could not be read. That is actionable, so it
 *   ships as `FORMATO_NO_SOPORTADO`, the same code the mime-type gate uses.
 * - `WorkbookError` with `reason: 'open'` — the engine could not open the
 *   book. Same actionable shape, same code.
 * - `WorkbookError` with `reason: 'internal'` and `UnexpectedAppError` — ours,
 *   transient, and nothing the agent can act on. They stay `NO_DISPONIBLE`,
 *   and internals never reach the client: `mcp.ts` logs the real tagged cause
 *   server-side before this payload goes out.
 *
 * The `never` in the default is the whole guarantee. A fifth failure type
 * reaching a tool stops compiling here instead of silently becoming
 * NO_DISPONIBLE in production.
 */
export function toToolErrorPayload(cause: VdrToolFailure): VdrToolErrorPayload {
  switch (cause._tag) {
    case 'VdrToolError':
      return cause.toPayload()
    case 'ExtractionError':
      return unsupportedDocumentError().toPayload()
    case 'WorkbookError':
      return cause.reason === 'open'
        ? {
            code: 'FORMATO_NO_SOPORTADO',
            mensaje:
              'No puedo abrir este modelo: el archivo está dañado o no es un XLSX que el motor pueda leer.',
            sugerencia:
              'Confirma con sala_documentos que el documento es una hoja de cálculo, y prueba con otra versión del modelo si la sala tiene más de una.',
          }
        : noDisponible
    case 'UnexpectedAppError':
      return noDisponible
    default: {
      const unreachable: never = cause
      return unreachable
    }
  }
}
