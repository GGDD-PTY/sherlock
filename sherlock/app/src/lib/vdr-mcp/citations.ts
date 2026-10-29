// ============================================================================
// VDR READ MCP — typed citations
// ============================================================================
// Every factual claim this surface returns carries a citation the client can
// navigate. Ids are always real ids the caller already received from
// `sala_documentos`; ranges are always validated against the real workbook.
// Nothing here is ever synthesized from a model's guess.
// ============================================================================

import { Schema } from 'effect'

const boundedString = (minimum: number, maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum)))

const idSchema = boundedString(1, 128)

const cellCitationSchema = Schema.Struct({
  type: Schema.Literal('cell'),
  documentId: idSchema,
  versionId: idSchema,
  sheet: boundedString(1, 255),
  range: boundedString(2, 64),
})

const documentCitationSchema = Schema.Struct({
  type: Schema.Literal('document'),
  documentId: idSchema,
  versionId: idSchema,
})

const pageCitationSchema = Schema.Struct({
  type: Schema.Literal('page'),
  documentId: idSchema,
  versionId: idSchema,
  page: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))
  ),
})

const excerptCitationSchema = Schema.Struct({
  type: Schema.Literal('excerpt'),
  documentId: idSchema,
  versionId: idSchema,
  page: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))
    )
  ),
  start: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  end: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})

const citationSchema = Schema.Union([
  cellCitationSchema,
  documentCitationSchema,
  pageCitationSchema,
  excerptCitationSchema,
])

export type CellCitation = typeof cellCitationSchema.Type
export type DocumentCitation = typeof documentCitationSchema.Type
export type ExcerptCitation = typeof excerptCitationSchema.Type
export type VdrCitation = typeof citationSchema.Type

export const citationsSchema = Schema.Array(citationSchema).pipe(
  Schema.check(Schema.isMaxLength(200))
)

export const decodeCitation = Schema.decodeUnknownSync(citationSchema, {
  onExcessProperty: 'error',
})
export const decodeCitations = Schema.decodeUnknownSync(citationsSchema, {
  onExcessProperty: 'error',
})

export function cellCitation(
  documentId: string,
  versionId: string,
  sheet: string,
  range: string
): CellCitation {
  return Schema.decodeUnknownSync(cellCitationSchema, { onExcessProperty: 'error' })({
    type: 'cell',
    documentId,
    versionId,
    sheet,
    range,
  })
}

export function documentCitation(documentId: string, versionId: string): DocumentCitation {
  return Schema.decodeUnknownSync(documentCitationSchema, { onExcessProperty: 'error' })({
    type: 'document',
    documentId,
    versionId,
  })
}

export function excerptCitation(args: {
  documentId: string
  versionId: string
  page?: number
  start: number
  end: number
}): ExcerptCitation {
  return Schema.decodeUnknownSync(excerptCitationSchema, { onExcessProperty: 'error' })({
    type: 'excerpt',
    ...args,
  })
}
