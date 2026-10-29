'use client'

// ============================================================================
// ROOM NAVIGATION
// ============================================================================
// Contrato de navegación del shell del data room. Existe para que una cita del
// asistente ("ver Estados financieros, hoja Resumen") revele el documento en
// el árbol sin consumir el grant VIEW de un solo uso.
// ============================================================================

import { Option, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import type { DocumentViewerNavigate } from '@/components/documents/viewers/DocumentViewer'

/**
 * La forma de un destino de cita, en la puerta por la que entra.
 *
 * La cita no la escribe la sala: la trae el asistente (hoy, la ficha financiera
 * con sus `locator`), y de aquí sale a un `postMessage` hacia el sidecar del
 * libro y a la paginación del PDF. Se decodifica ANTES de guardarla, no en cada
 * pintada, y una cita con la forma cambiada se descarta: el documento se abre
 * en su primera página en vez de mandar cualquier cosa al visor.
 */
const CitedNavigateSchema = Schema.Struct({
  sheet: Schema.optionalKey(Schema.String),
  range: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(Schema.Number),
})

const decodeCitedNavigate = Schema.decodeUnknownOption(CitedNavigateSchema)

/**
 * El destino decodificado, o `undefined` si no lo era. El tipo de retorno ata
 * el schema al del visor: si uno de los dos cambia, esto deja de compilar.
 */
export function citedNavigate(navigate: unknown): DocumentViewerNavigate | undefined {
  if (navigate === undefined || navigate === null) return undefined
  return Option.getOrUndefined(decodeCitedNavigate(navigate))
}

export type RoomRevealDocumentTarget = {
  documentId: Id<'documents'>
  versionId?: Id<'documentVersions'>
  navigate?: DocumentViewerNavigate
}

export type RoomNavigation = {
  /** Expande, selecciona y enfoca el documento; abrir el visor es otra acción. */
  revealDocument: (target: RoomRevealDocumentTarget) => void
}
