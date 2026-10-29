import { describe, expect, it } from 'vitest'

import {
  createDocumentDeliveryProof,
  DOCUMENT_DELIVERY_PROOF_TTL_MS,
  verifyDocumentDeliveryProof,
} from '../../../convex/_documents/deliveryProof'

const secret = 'storage-secret-for-proof-tests'
const base = {
  grantId: 'grant_1',
  token: 'token_1',
  profileId: 'profile_1',
  issuedAt: 1_000_000,
}

describe('document delivery proof', () => {
  it('accepts the exact short-lived server assertion', async () => {
    const proof = await createDocumentDeliveryProof(secret, base)

    await expect(
      verifyDocumentDeliveryProof(secret, { ...base, proof }, base.issuedAt + 1_000)
    ).resolves.toBe(true)
  })

  it.each([
    ['grantId', { grantId: 'grant_other' }],
    ['token', { token: 'token_other' }],
    ['profileId', { profileId: 'profile_other' }],
  ] as const)('rejects a proof replayed with a different %s', async (_field, override) => {
    const proof = await createDocumentDeliveryProof(secret, base)

    await expect(
      verifyDocumentDeliveryProof(secret, { ...base, ...override, proof }, base.issuedAt + 1_000)
    ).resolves.toBe(false)
  })

  it('rejects expired and future-dated assertions', async () => {
    const proof = await createDocumentDeliveryProof(secret, base)

    await expect(
      verifyDocumentDeliveryProof(
        secret,
        { ...base, proof },
        base.issuedAt + DOCUMENT_DELIVERY_PROOF_TTL_MS + 1
      )
    ).resolves.toBe(false)

    await expect(
      verifyDocumentDeliveryProof(secret, { ...base, proof }, base.issuedAt - 10_001)
    ).resolves.toBe(false)
  })
})
