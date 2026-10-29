// ============================================================================
// VALIDATION LIBRARY UNIT TESTS
// ============================================================================
// Tests para la librería de validación centralizada
// Importa funciones desde @/lib/validations
// ============================================================================

import { Schema } from 'effect'
import { describe, it, expect, expectTypeOf } from 'vitest'
import { isValidConvexId, ConvexIdSchema, type ConvexId } from '@/lib/validations'

// ===== CONVEX ID VALIDATION =====
describe('isValidConvexId', () => {
  // ===== VALID CASES =====
  it('accepts and brands an id with the shape Convex emits', () => {
    const id = 'kcd612ce2bf0e49b2ed6d95c9499a9bf'

    expect(isValidConvexId(id)).toBe(true)
    expect(Schema.is(ConvexIdSchema)(id)).toBe(true)
    expectTypeOf(isValidConvexId).guards.toEqualTypeOf<ConvexId>()
  })

  it('accepts long ID string', () => {
    expect(isValidConvexId('abc123xyz789def456ghi')).toBe(true)
  })

  // ===== INVALID CASES =====
  // A malformed id must die on the route's 400, not on a generic Convex 500.
  it('rejects a single character ID', () => {
    expect(isValidConvexId('a')).toBe(false)
  })

  it('rejects ids with separators', () => {
    expect(isValidConvexId('invalid-id')).toBe(false)
    expect(isValidConvexId('deal_123456789012345678')).toBe(false)
  })

  it('rejects uppercase and non-alphanumeric characters', () => {
    expect(isValidConvexId('K57EX8QFGJ9P3M2NFBXH7CDS1H6K4WCR')).toBe(false)
    expect(isValidConvexId('k8bcb9d61a5b5556d9e47f3f6f5055e!')).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidConvexId(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidConvexId(undefined)).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidConvexId('')).toBe(false)
  })

  it('rejects non-string types', () => {
    expect(isValidConvexId(123)).toBe(false)
  })

  it('rejects object as ID', () => {
    expect(isValidConvexId({})).toBe(false)
  })
})
