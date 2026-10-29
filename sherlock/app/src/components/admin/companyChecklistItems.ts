// ============================================================================
// LAS SIETE CASILLAS DE LA SALA, UNA SOLA VEZ
// ============================================================================
// El catálogo vive en `src/lib/vdr/room-progress.ts`. Este módulo solo añade
// lo que el admin necesita (casillas manuales) y reexporta las claves para que
// las suites que montan un doble del panel no se lleven la lista con él.

import { Schema } from 'effect'

import { CHECKLIST_ITEM_KEYS, type ChecklistItemKey } from '@/lib/vdr/room-progress'

export { CHECKLIST_ITEM_KEYS, type ChecklistItemKey }

/** El total ES el largo de la lista: no hay dónde divergir. */
export const CHECKLIST_TOTAL = CHECKLIST_ITEM_KEYS.length

const ManualChecklistItemKeySchema = Schema.Literals(['financialsDepth', 'kickoffCall'])
export type ManualChecklistItemKey = typeof ManualChecklistItemKeySchema.Type

const decodeManualKey = Schema.decodeUnknownOption(ManualChecklistItemKeySchema)

export function isManualChecklistItem(key: ChecklistItemKey): key is ManualChecklistItemKey {
  return decodeManualKey(key)._tag === 'Some'
}
