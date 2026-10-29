import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'

import { citationsSchema } from '@/lib/vdr-mcp/citations'
import { VdrToolErrorPayloadSchema } from '@/lib/vdr-mcp/errors'
import { TOOL_DESCRIPTIONS, toolInputSchemas } from '@/lib/vdr-mcp/tools'

const vdrToolResultSchema = Schema.Struct({
  ok: Schema.Literal(true),
  data: Schema.Record(Schema.String, Schema.Unknown),
  citations: citationsSchema,
})

const makeVdrTool = <const Name extends keyof typeof toolInputSchemas>(name: Name) =>
  Tool.make(name, {
    description: TOOL_DESCRIPTIONS[name],
    parameters: toolInputSchemas[name],
    success: vdrToolResultSchema,
    failure: VdrToolErrorPayloadSchema,
  })

export const vdrToolkit = Toolkit.make(
  makeVdrTool('sala_resumen'),
  makeVdrTool('sala_documentos'),
  makeVdrTool('documento_buscar'),
  makeVdrTool('documento_fragmento'),
  makeVdrTool('modelo_hojas'),
  makeVdrTool('modelo_resumen'),
  makeVdrTool('modelo_rango'),
  makeVdrTool('modelo_formula'),
  makeVdrTool('modelo_metrica_canonica'),
  makeVdrTool('documento_subir'),
  makeVdrTool('documento_confirmar')
)
