// ============================================================================
// VALIDATION LIBRARY - Sherlock UNIFIED
// ============================================================================

import { Schema } from 'effect'

import type { Id, TableNames } from '@/../convex/_generated/dataModel'

// ===== CONVEX ID =====
// Valida que un string tenga el formato de un ID de Convex: alfanumérico en
// minúscula, sin separadores. Aceptar "cualquier string no vacío" dejaba muerta
// la rama del 400 en las rutas de la sala y sus documentos: un id malformado
// pasaba la
// validación, Convex lo rechazaba en `v.id()` y el usuario recibía un 500.
// El rango de longitud deja holgura sobre los 32 caracteres que Convex emite hoy.
export const ConvexIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9]{16,64}$/)),
  Schema.brand('ConvexId')
)

export type ConvexId = typeof ConvexIdSchema.Type

const isConvexId = Schema.is(ConvexIdSchema)

export function isValidConvexId(id: unknown): id is ConvexId {
  return isConvexId(id)
}

export function toConvexId<TableName extends TableNames>(id: unknown): Id<TableName> {
  const validated = Schema.decodeUnknownSync(ConvexIdSchema)(id)
  return validated as unknown as Id<TableName>
}
