import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claimIntakeAfterAuthentication,
  createIntakeClaimProof,
  provisionAndClaimIntake,
  readWorkosSubjectFromAccessToken,
} from '@/lib/intake/claim'
import { createIntakeClaimProof as createIntakeClaimProofFromHelper } from '../../convex/intake-claim-proof-test-helper'

const SECRET = 'intake-server-secret-for-tests-1234567890'
const AUDIENCE = 'sherlock-test:intake'
const SESSION_TOKEN = 's'.repeat(43)
const SUBJECT = 'workos_user_claimed'

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.sig`
}

function succeededClaim() {
  return {
    status: 'SUCCEEDED' as const,
    claimDigest: 'digest-1',
    companyId: 'company_1',
    documentIds: ['document_1'],
    claimedDocumentCount: 1,
    skippedDocumentCount: 0,
    completedAt: 1_900_000_000_000,
  }
}

describe('createIntakeClaimProof', () => {
  beforeEach(() => {
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('es la misma función que usa el helper de los tests de Convex', () => {
    expect(createIntakeClaimProofFromHelper).toBe(createIntakeClaimProof)
  })

  it('lanza el código de frontera cuando falta el secreto', () => {
    vi.stubEnv('INTAKE_SERVER_SECRET', '')
    expect(() =>
      createIntakeClaimProof({ sessionToken: SESSION_TOKEN, workosSubject: SUBJECT })
    ).toThrow(new Error('INTAKE_CLAIM_BOUNDARY_UNAVAILABLE'))
  })

  it('devuelve nonce y proof cuando la frontera está configurada', () => {
    const proof = createIntakeClaimProof({ sessionToken: SESSION_TOKEN, workosSubject: SUBJECT })
    expect(proof.claimNonce).toEqual(expect.any(String))
    expect(proof.claimProof).toEqual(expect.any(String))
    expect(proof.claimNonce).not.toBe(proof.claimProof)
  })
})

describe('authenticated intake claim client', () => {
  beforeEach(() => {
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives a WorkOS subject only from a well-formed access-token sub', () => {
    expect(readWorkosSubjectFromAccessToken(jwtWithClaims({ sub: SUBJECT }))).toBe(SUBJECT)
    expect(readWorkosSubjectFromAccessToken(jwtWithClaims({ sub: 'not subject' }))).toBeNull()
    expect(readWorkosSubjectFromAccessToken(jwtWithClaims({}))).toBeNull()
    expect(readWorkosSubjectFromAccessToken('not-a-jwt')).toBeNull()
    expect(readWorkosSubjectFromAccessToken('header-only')).toBeNull()
  })

  it('refuses a callback whose access-token sub does not match the WorkOS user', async () => {
    await expect(
      claimIntakeAfterAuthentication({
        accessToken: jwtWithClaims({ sub: 'workos_other' }),
        sessionToken: SESSION_TOKEN,
        workosSubject: SUBJECT,
      })
    ).rejects.toThrow('INTAKE_CLAIM_SUBJECT_MISMATCH')
  })

  it('stops as soon as a claim attempt records SUCCEEDED and reuses one proof', async () => {
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({
        created: false,
        role: 'COMPANY',
        company: { _id: 'company_1' },
      })
      .mockResolvedValueOnce({
        status: 'PROCESSING',
        claimDigest: 'digest-1',
        companyId: 'company_1',
      })
      .mockResolvedValueOnce(succeededClaim())

    const result = await provisionAndClaimIntake({
      client: { mutation },
      sessionToken: SESSION_TOKEN,
      workosSubject: SUBJECT,
    })

    expect(result).toMatchObject({ status: 'SUCCEEDED', claimedDocumentCount: 1 })
    expect(mutation).toHaveBeenCalledTimes(3)
    expect(mutation.mock.calls[0]?.[1]).toEqual({})
    expect(mutation.mock.calls[1]?.[1]).toMatchObject({
      sessionToken: SESSION_TOKEN,
      workosSubject: SUBJECT,
      claimNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      claimProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(mutation.mock.calls[2]?.[1]).toEqual(mutation.mock.calls[1]?.[1])
  })

  it('throws INTAKE_CLAIM_INCOMPLETE after four non-terminal attempts', async () => {
    const mutation = vi.fn().mockResolvedValueOnce({
      created: false,
      role: 'COMPANY',
      company: { _id: 'company_1' },
    })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      mutation.mockResolvedValueOnce({
        status: 'PROCESSING',
        claimDigest: 'digest-1',
        companyId: 'company_1',
      })
    }

    await expect(
      provisionAndClaimIntake({
        client: { mutation },
        sessionToken: SESSION_TOKEN,
        workosSubject: SUBJECT,
      })
    ).rejects.toThrow('INTAKE_CLAIM_INCOMPLETE')
    expect(mutation).toHaveBeenCalledTimes(5)
  })

  it('surfaces a recorded FAILED claim as reconciliation-required, not incomplete', async () => {
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({
        created: false,
        role: 'COMPANY',
        company: { _id: 'company_1' },
      })
      .mockResolvedValue({
        status: 'FAILED',
        claimDigest: 'digest-1',
        companyId: 'company_1',
        code: 'CLAIM_RECONCILIATION_REQUIRED',
        completedAt: 1_900_000_000_000,
      })

    await expect(
      provisionAndClaimIntake({
        client: { mutation },
        sessionToken: SESSION_TOKEN,
        workosSubject: SUBJECT,
      })
    ).rejects.toThrow('INTAKE_CLAIM_RECONCILIATION_REQUIRED')
  })

  // El reintento del claim es dueño de UNA condición: un claim que llegó a
  // Convex y todavía no quedó SUCCEEDED. Un fallo de transporte no es eso, y
  // repetirlo gastaría los cuatro intentos del mismo proof contra la red.
  it('reporta un fallo de transporte del claim una sola vez, sin gastar los cuatro intentos', async () => {
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({
        created: false,
        role: 'COMPANY',
        company: { _id: 'company_1' },
      })
      .mockRejectedValue(new Error('convex unreachable'))

    await expect(
      provisionAndClaimIntake({
        client: { mutation },
        sessionToken: SESSION_TOKEN,
        workosSubject: SUBJECT,
      })
    ).rejects.toThrow('convex unreachable')
    // Una provisión y un solo intento de claim.
    expect(mutation).toHaveBeenCalledTimes(2)
  })

  it('does not call the claim mutation when the workspace is not a company owner', async () => {
    const mutation = vi.fn().mockResolvedValue({
      created: false,
      role: 'ADMIN',
      company: { _id: 'company_1' },
    })

    await expect(
      provisionAndClaimIntake({
        client: { mutation },
        sessionToken: SESSION_TOKEN,
        workosSubject: SUBJECT,
      })
    ).rejects.toThrow('INTAKE_CLAIM_COMPANY_UNAVAILABLE')
    expect(mutation).toHaveBeenCalledTimes(1)
  })
})
