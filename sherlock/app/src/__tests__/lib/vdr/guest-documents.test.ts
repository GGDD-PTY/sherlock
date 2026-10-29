import { describe, expect, it } from 'vitest'

import { selectGuestShareableDocuments } from '@/lib/vdr/guest-documents'

const base = {
  accessLevel: 'NDA_REQUIRED',
  lifecycleStatus: 'ACTIVE',
  currentVersionId: 'v1',
  publishedVersionId: 'v1',
}

describe('selectGuestShareableDocuments', () => {
  it('keeps only current published NDA documents of the company room', () => {
    const shareable = selectGuestShareableDocuments(
      [
        { _id: 'shared', name: 'Shared.pdf', ...base },
        { _id: 'private', name: 'Private.pdf', ...base, accessLevel: 'PRIVATE' },
        { _id: 'sensitive', name: 'Sensitive.pdf', ...base, classification: 'KYC_SENSITIVE' },
        { _id: 'expired', name: 'Expired.pdf', ...base, isExpired: true },
        { _id: 'past', name: 'Past.pdf', ...base, expiresAt: 1 },
        { _id: 'draft', name: 'Draft.pdf', ...base, publishedVersionId: 'v0' },
      ],
      1_000
    )

    expect(shareable).toEqual([{ _id: 'shared', name: 'Shared.pdf' }])
  })
})
