// ============================================================================
// RESULTADO ESTRUCTURADO DE DENEGACIÓN DE ACCESO DOCUMENTAL
// ============================================================================
// En Convex un `throw` revierte TODOS los writes de la mutation — incluida la
// fila de auditoría que `recordDocumentAccessLog` acababa de insertar. El
// patrón log-then-throw hacía que los DENY nunca persistieran: la bitácora
// solo contaba accesos permitidos, y el emisor no veía los intentos negados.
// `ctx.scheduler.runAfter` tampoco sirve de escape: el scheduling es parte de
// la misma transacción y se descarta con el throw (verificado 2026-07-28).
//
// La única salida segura es NO lanzar: la rama de denegación devuelve este
// resultado discriminado, la transacción commitea con la fila DENIED, y el
// caller decide cómo presentar el rechazo. El union discriminado obliga a
// TypeScript a que cada caller maneje la variante — un deny jamás puede
// interpretarse como éxito por accidente.
//
// Los throws PRE-log (grant inválido, token errado, rate limit) se mantienen:
// no tienen evaluación que auditar y no pierden ninguna fila.
//
// La forma de las dos variantes se declara UNA vez, como schema, y de ahí
// salen el tipo y el guard. Antes eran dos declaraciones paralelas —una
// `interface` y una escalera de `Reflect.get` con `typeof`— que coincidían
// por disciplina: agregar un campo a la interface no rompía nada y el guard
// seguía aceptando el objeto viejo.
// ============================================================================

import { Schema } from 'effect'

import type { DocumentAccessEvaluation } from './policy'
import { getDocumentAccessErrorMessage } from './policy'

const DeniedDocumentAccessSchema = Schema.Struct({
  allowed: Schema.Literal(false),
  /** Código estable de la evaluación (p.ej. DENIED_NDA_REQUIRED). */
  code: Schema.String,
  /** Mensaje listo para UI, ya localizado por la policy. */
  message: Schema.String,
})

export type DeniedDocumentAccess = typeof DeniedDocumentAccessSchema.Type

const IssuedDocumentAccessGrantSchema = Schema.Struct({
  allowed: Schema.Literal(true),
  url: Schema.String,
  action: Schema.Literals(['VIEW', 'DOWNLOAD']),
  versionId: Schema.String,
  displayName: Schema.String,
  detectedMimeType: Schema.String,
})

export type IssuedDocumentAccessGrant = typeof IssuedDocumentAccessGrantSchema.Type

export function deniedDocumentAccess(evaluation: DocumentAccessEvaluation): DeniedDocumentAccess {
  return {
    allowed: false,
    code: evaluation.outcome,
    message: getDocumentAccessErrorMessage(evaluation),
  }
}

export const isDeniedDocumentAccess = Schema.is(DeniedDocumentAccessSchema)

export const isIssuedDocumentAccessGrant = Schema.is(IssuedDocumentAccessGrantSchema)
