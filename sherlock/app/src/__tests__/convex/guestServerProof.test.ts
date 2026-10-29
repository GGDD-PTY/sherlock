import { describe, expect, it } from 'vitest'

import { requireVdrGuestServerProof } from '../../../convex/_guests/serverProof'
import {
  VDR_GUEST_SERVER_AUDIENCE_MAX_LENGTH,
  VDR_GUEST_SERVER_OPERATION_REPLAY_POLICY,
  VDR_GUEST_SERVER_SECRET_MAX_LENGTH,
  resolveVdrGuestServerBoundaryConfig,
} from '../../../convex/_guests/serverProofFormat'
import { createVdrGuestServerProof } from '../../lib/auth/vdr-guest-server-proof'

const NOW = 1_800_000_000_000
const SECRET = 'server-boundary-secret-for-tests-123456789'
const AUDIENCE = 'sherlock-test:guest-boundary'
const TOKEN = 's'.repeat(64)

function signedProof(
  operation: 'RESOLVE_SESSION' | 'ROTATE_SESSION' = 'RESOLVE_SESSION',
  bindingParts: readonly string[] = [TOKEN],
  issuedAt = NOW
) {
  return createVdrGuestServerProof({
    operation,
    bindingParts,
    issuedAt,
    secret: SECRET,
    audience: AUDIENCE,
  })
}

describe('VDR guest server proof', () => {
  it('accepts only a fresh HMAC bound to the exact operation, arguments, audience, and timestamp', async () => {
    const proof = signedProof()

    await expect(
      requireVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [TOKEN],
        issuedAt: proof.serverIssuedAt,
        proof: proof.serverProof,
        now: NOW,
        secret: SECRET,
        audience: AUDIENCE,
      })
    ).resolves.toBeUndefined()

    await expect(
      requireVdrGuestServerProof({
        operation: 'ROTATE_SESSION',
        bindingParts: [TOKEN],
        issuedAt: proof.serverIssuedAt,
        proof: proof.serverProof,
        now: NOW,
        secret: SECRET,
        audience: AUDIENCE,
      })
    ).rejects.toThrow(/servidor/i)

    await expect(
      requireVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [`${TOKEN}x`],
        issuedAt: proof.serverIssuedAt,
        proof: proof.serverProof,
        now: NOW,
        secret: SECRET,
        audience: AUDIENCE,
      })
    ).rejects.toThrow(/servidor/i)

    await expect(
      requireVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [TOKEN],
        issuedAt: proof.serverIssuedAt,
        proof: proof.serverProof,
        now: NOW,
        secret: SECRET,
        audience: 'different-deployment:guest-boundary',
      })
    ).rejects.toThrow(/servidor/i)

    await expect(
      requireVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [TOKEN],
        issuedAt: proof.serverIssuedAt + 1,
        proof: proof.serverProof,
        now: NOW,
        secret: SECRET,
        audience: AUDIENCE,
      })
    ).rejects.toThrow(/servidor/i)
  })

  it('rejects stale and future-dated proofs outside the 30-second window', async () => {
    for (const issuedAt of [NOW - 30_001, NOW + 30_001]) {
      const proof = signedProof('RESOLVE_SESSION', [TOKEN], issuedAt)
      await expect(
        requireVdrGuestServerProof({
          operation: 'RESOLVE_SESSION',
          bindingParts: [TOKEN],
          issuedAt: proof.serverIssuedAt,
          proof: proof.serverProof,
          now: NOW,
          secret: SECRET,
          audience: AUDIENCE,
        })
      ).rejects.toThrow(/servidor/i)
    }
  })

  it('fails closed without the dedicated secret and never falls back to WEBHOOK_SECRET', async () => {
    const proof = signedProof()

    expect(
      resolveVdrGuestServerBoundaryConfig({
        secret: undefined,
        audience: AUDIENCE,
      })
    ).toBeNull()

    expect(() =>
      createVdrGuestServerProof({
        operation: 'RESOLVE_SESSION',
        bindingParts: [TOKEN],
        issuedAt: NOW,
        secret: '',
        audience: AUDIENCE,
      })
    ).toThrow('VDR_GUEST_SERVER_BOUNDARY_UNAVAILABLE')

    for (const secret of ['', 'too-short', 's'.repeat(VDR_GUEST_SERVER_SECRET_MAX_LENGTH + 1)]) {
      await expect(
        requireVdrGuestServerProof({
          operation: 'RESOLVE_SESSION',
          bindingParts: [TOKEN],
          issuedAt: proof.serverIssuedAt,
          proof: proof.serverProof,
          now: NOW,
          secret,
          audience: AUDIENCE,
        })
      ).rejects.toThrow(/servidor/i)
    }
  })

  it('fails closed when the deployment audience is missing, malformed, or unbounded', async () => {
    const invalidAudiences = [
      '',
      ' leading-space',
      'browser exposed',
      'a'.repeat(VDR_GUEST_SERVER_AUDIENCE_MAX_LENGTH + 1),
    ]

    for (const audience of invalidAudiences) {
      expect(() =>
        createVdrGuestServerProof({
          operation: 'RESOLVE_SESSION',
          bindingParts: [TOKEN],
          issuedAt: NOW,
          secret: SECRET,
          audience,
        })
      ).toThrow('VDR_GUEST_SERVER_BOUNDARY_UNAVAILABLE')
    }
  })

  it('classifies replay semantics and confines a replayed proof to the identical authority', async () => {
    expect(VDR_GUEST_SERVER_OPERATION_REPLAY_POLICY).toEqual({
      REQUEST_OTP: 'RATE_LIMITED',
      VERIFY_OTP: 'ONE_TIME',
      RESOLVE_SESSION: 'IDEMPOTENT',
      PROJECT_ROOM: 'IDEMPOTENT',
      READ_NDA: 'IDEMPOTENT',
      ACCEPT_NDA: 'IDEMPOTENT',
      VIEW_DOCUMENT: 'RATE_LIMITED',
      ROTATE_SESSION: 'ONE_TIME',
      REVOKE_SESSION: 'IDEMPOTENT',
    })

    const proof = signedProof()
    const exactAuthority = {
      operation: 'RESOLVE_SESSION' as const,
      bindingParts: [TOKEN],
      issuedAt: proof.serverIssuedAt,
      proof: proof.serverProof,
      now: NOW,
      secret: SECRET,
      audience: AUDIENCE,
    }

    // Without a nonce ledger, the cryptographic proof is replayable for 30 seconds.
    // The proof does not widen authority: operation, arguments, audience, and time stay fixed.
    await expect(requireVdrGuestServerProof(exactAuthority)).resolves.toBeUndefined()
    await expect(requireVdrGuestServerProof(exactAuthority)).resolves.toBeUndefined()
    await expect(
      requireVdrGuestServerProof({
        ...exactAuthority,
        operation: 'ROTATE_SESSION',
      })
    ).rejects.toThrow(/servidor/i)
  })
})
