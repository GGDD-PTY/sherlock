import { Schema } from 'effect'

import { HierarchyPresetSchema } from '@/lib/hierarchy/types'
import type { HierarchyPreset } from '@/lib/hierarchy/types'

/**
 * Un preset declarado pero sin comportamiento implementado. Error tipado en vez
 * de `Error` pelado: quien lo atrapa lee `preset` sin parsear el mensaje, y el
 * `_tag` lo hace discriminable desde un `catchTag`.
 */
class HierarchyPresetNotImplementedError extends Schema.TaggedError<HierarchyPresetNotImplementedError>()(
  'HierarchyPresetNotImplementedError',
  {
    preset: Schema.String,
    message: Schema.String,
  }
) {}

// Los dos presets con comportamiento salen del vocabulario, no de una segunda
// lista: la tabla de abajo y el guard de `resolveHierarchyPreset` leían
// `'browse'` y `'pick-many'` escritos a mano en tres lugares distintos.
const ImplementedHierarchyPresetSchema = HierarchyPresetSchema.pick(['browse', 'pick-many'])
type ImplementedHierarchyPreset = typeof ImplementedHierarchyPresetSchema.Type

const isImplementedHierarchyPreset = Schema.is(ImplementedHierarchyPresetSchema)

export type HierarchyPresetBehavior = {
  selection: 'single' | 'multiple'
  activation: 'explicit' | 'none'
  checkboxes: boolean
  maxSelected?: number
}

const IMPLEMENTED_PRESETS: Record<ImplementedHierarchyPreset, HierarchyPresetBehavior> = {
  browse: {
    selection: 'single',
    activation: 'explicit',
    checkboxes: false,
    maxSelected: 1,
  },
  'pick-many': {
    // La fila activa alimenta el panel de detalle; el conjunto bulk vive en
    // `checkedIds`. Mezclarlos haría que un click de navegación marcara bulk.
    selection: 'single',
    activation: 'none',
    checkboxes: true,
  },
}

export function resolveHierarchyPreset(preset: HierarchyPreset): HierarchyPresetBehavior {
  if (isImplementedHierarchyPreset(preset)) return IMPLEMENTED_PRESETS[preset]
  throw new HierarchyPresetNotImplementedError({
    preset,
    message: `HIERARCHY_PRESET_NOT_IMPLEMENTED:${preset}`,
  })
}
