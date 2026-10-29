// ============================================================================
// CLASIFICACIÓN Y NIVEL DE ACCESO DE UN DOCUMENTO
// ============================================================================
// Las dos uniones que comparten el documento, el intent, el log y el grant
// (`DocumentAccessLevel` y `DocumentClassification` en `convex/schema.ts`).
// `DocumentAccessLevel` sale de un `Schema.Literals`: el tipo se deriva del
// catálogo y el guardia de frontera (`isDocumentAccessLevel`) sale del mismo
// catálogo, así que ya no hay una lista para TypeScript y otra escrita a mano
// en un `if`. `DocumentClassification` no tiene ese guardia — nadie decodifica
// un valor ajeno contra ella acá — así que queda como unión pelada.
// ============================================================================

import { Schema } from 'effect'

const DocumentAccessLevelSchema = Schema.Literals(['PUBLIC', 'NDA_REQUIRED', 'PRIVATE'])
export type DocumentAccessLevel = typeof DocumentAccessLevelSchema.Type

export type DocumentClassification =
  'PUBLIC_TEASER' | 'CONFIDENTIAL' | 'RESTRICTED' | 'LEGAL' | 'KYC_SENSITIVE'

/** Entrada ajena (una fila vieja, un query param) estrechada contra el catálogo. */
export const isDocumentAccessLevel = Schema.is(DocumentAccessLevelSchema)

const DEFAULT_CLASSIFICATION_BY_ACCESS_LEVEL: Record<DocumentAccessLevel, DocumentClassification> =
  {
    PUBLIC: 'PUBLIC_TEASER',
    NDA_REQUIRED: 'CONFIDENTIAL',
    PRIVATE: 'RESTRICTED',
  }

export function inferClassificationFromAccessLevel(
  accessLevel: DocumentAccessLevel
): DocumentClassification {
  return DEFAULT_CLASSIFICATION_BY_ACCESS_LEVEL[accessLevel]
}

export function getClassificationBadgeClassName(classification?: DocumentClassification): string {
  switch (classification) {
    case 'PUBLIC_TEASER':
      return 'border-success/30 text-success'
    case 'CONFIDENTIAL':
      return 'border-muted/30 text-muted-foreground'
    case 'RESTRICTED':
      return 'border-warning/30 text-warning'
    case 'LEGAL':
      return 'border-info/30 text-info'
    case 'KYC_SENSITIVE':
      return 'border-destructive/30 text-destructive'
    default:
      return 'border-muted/30 text-muted-foreground'
  }
}
