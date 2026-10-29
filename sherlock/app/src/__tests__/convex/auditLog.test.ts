// ============================================================================
// TESTS: convex/_helpers/auditLog
// ============================================================================
// Tests for the createSnapshot utility function from the audit log helper.
// (logAdminAction requires a real Convex MutationCtx, so we only test the
// pure utility function.)
// ============================================================================

import { describe, it, expect } from 'vitest'
import { createSnapshot } from '../../../convex/_helpers/auditLog'

describe('createSnapshot', () => {
  it('creates a snapshot with specified fields', () => {
    const entity = {
      _id: 'profile_123',
      role: 'COMPANY',
      isVerified: true,
      fullName: 'John Doe',
      email: 'john@example.com',
    }

    const snapshot = createSnapshot(entity, ['role', 'isVerified'])

    expect(snapshot).toEqual({
      role: 'COMPANY',
      isVerified: true,
    })
  })

  it('includes only requested fields', () => {
    const entity = {
      name: 'Acme Corp',
      sector: 'fintech',
      amount: 1000000,
      status: 'active',
    }

    const snapshot = createSnapshot(entity, ['name', 'status'])

    expect(snapshot).toEqual({ name: 'Acme Corp', status: 'active' })
    expect(snapshot).not.toHaveProperty('sector')
    expect(snapshot).not.toHaveProperty('amount')
  })

  it('handles empty fields array', () => {
    const entity = { name: 'Test', value: 42 }

    const snapshot = createSnapshot(entity, [])

    expect(snapshot).toEqual({})
  })

  it('handles undefined field values', () => {
    const entity: Record<string, unknown> = {
      name: 'Test',
      optional: undefined,
    }

    const snapshot = createSnapshot(entity, ['name', 'optional'])

    expect(snapshot).toEqual({ name: 'Test', optional: undefined })
  })

  it('handles null field values', () => {
    const entity: Record<string, unknown> = {
      name: 'Test',
      nullable: null,
    }

    const snapshot = createSnapshot(entity, ['name', 'nullable'])

    expect(snapshot).toEqual({ name: 'Test', nullable: null })
  })

  it('handles complex nested values', () => {
    const entity = {
      config: { theme: 'dark', lang: 'es' },
      tags: ['fintech', 'latam'],
      count: 5,
    }

    const snapshot = createSnapshot(entity, ['config', 'tags'])

    expect(snapshot).toEqual({
      config: { theme: 'dark', lang: 'es' },
      tags: ['fintech', 'latam'],
    })
  })

  it('snapshot is independent of original entity (shallow copy)', () => {
    const entity = { role: 'ADMIN', count: 10 }

    const snapshot = createSnapshot(entity, ['role', 'count'])
    entity.role = 'COMPANY'
    entity.count = 20

    // Snapshot should still have original values since strings are primitives
    expect(snapshot.role).toBe('ADMIN')
    expect(snapshot.count).toBe(10)
  })
})
