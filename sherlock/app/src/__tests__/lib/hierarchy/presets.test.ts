import { describe, expect, it } from 'vitest'

import { resolveHierarchyPreset } from '@/lib/hierarchy/presets'
import type { HierarchyPreset } from '@/lib/hierarchy/types'

describe('hierarchy presets', () => {
  it('implements browse and pick-many while leaving future presets declared only', () => {
    expect(resolveHierarchyPreset('browse')).toMatchObject({
      selection: 'single',
      activation: 'explicit',
      checkboxes: false,
    })
    expect(resolveHierarchyPreset('pick-many')).toMatchObject({
      // La fila activa sigue siendo única; el conjunto múltiple vive en
      // `checkedIds` y nunca se deriva del click de navegación.
      selection: 'single',
      activation: 'none',
      checkboxes: true,
    })

    for (const preset of ['pick-one', 'review'] satisfies HierarchyPreset[]) {
      expect(() => resolveHierarchyPreset(preset)).toThrow(
        `HIERARCHY_PRESET_NOT_IMPLEMENTED:${preset}`
      )
    }
  })
})
