import { describe, expect, it } from 'vitest'

import { filterExistingDocs, mapExistingDocs } from '../../../convex/_helpers/batch'

describe('convex/_helpers/batch.ts', () => {
  it('filters nullish documents while preserving order', () => {
    const first = { _id: 'doc_1', name: 'First' }
    const second = { _id: 'doc_2', name: 'Second' }

    expect(filterExistingDocs([first, null, undefined, second])).toEqual([first, second])
  })

  it('builds a lookup map from existing documents', () => {
    const first = { _id: 'doc_1', name: 'First' }
    const second = { _id: 'doc_2', name: 'Second' }

    const result = mapExistingDocs([first, null, second])

    expect(result.size).toBe(2)
    expect(result.get('doc_1')).toBe(first)
    expect(result.get('doc_2')).toBe(second)
  })
})
