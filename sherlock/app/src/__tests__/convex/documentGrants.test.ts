import { beforeEach, describe, expect, it, vi } from 'vitest'
import { revokeGrantsForDocument } from '../../../convex/_documents/shared'
import { createMockConvexCtx, createMockQueryBuilder } from '../utils/convex-test-utils'
import { mockId, resetIdCounter } from '../utils/test-factories'

describe('document grant revocation', () => {
  const now = 1_800_000_000_000

  beforeEach(() => {
    resetIdCounter()
    vi.clearAllMocks()
  })

  it('revoca solo grants vivos del documento', async () => {
    const ctx = createMockConvexCtx()
    const documentId = mockId('documents')
    const live = {
      _id: mockId('documentAccessGrants'),
      documentId,
      expiresAt: now + 60_000,
    }
    const expired = {
      _id: mockId('documentAccessGrants'),
      documentId,
      expiresAt: now - 1,
    }
    const revoked = {
      _id: mockId('documentAccessGrants'),
      documentId,
      expiresAt: now + 60_000,
      revokedAt: now - 5,
    }
    ctx.db.query.mockReturnValue(createMockQueryBuilder([live, expired, revoked]))

    const count = await revokeGrantsForDocument(ctx, documentId, 'DOCUMENT_REMOVED', now)

    expect(count).toBe(1)
    expect(ctx.db.patch).toHaveBeenCalledTimes(1)
    expect(ctx.db.patch).toHaveBeenCalledWith(live._id, {
      revokedAt: now,
      outcome: 'DOCUMENT_REMOVED',
    })
  })
})
