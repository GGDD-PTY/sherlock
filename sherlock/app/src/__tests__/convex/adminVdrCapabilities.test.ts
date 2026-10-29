import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _purgeExpired, issue } from '../../../convex/adminVdrCapabilities'
import { adminVdrIdentityBindingDigest } from '../../../convex/_adminVdr/capability'
import { createAdminVdrCapabilityProof } from '../../lib/auth/admin-vdr-capability-proof'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const NOW = new Date('2026-08-03T16:00:00.000-05:00').getTime()
const ORIGINAL_ENV = process.env
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function issuanceTables(role: 'ADMIN' | 'COMPANY' = 'ADMIN'): Tables {
  return {
    users: [
      {
        _id: 'user_actor',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role,
      },
    ],
    profiles: [{ _id: 'profile_admin', userId: 'user_actor', role, isActive: true }],
    companies: [{ _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer' }],
    adminVdrCapabilities: [],
    rateLimits: [],
    adminAuditLogs: [],
  }
}

function prepareIssuance() {
  return createAdminVdrCapabilityProof({
    subject: 'workos_admin',
    sessionId: TEST_ADMIN_SESSION_ID,
    companyId: 'company_1',
    action: 'DOCUMENT_ARCHIVE',
    target: 'DOCUMENT:document_1',
    input: { documentId: 'document_1' },
    issuedAt: NOW,
  })
}

describe('adminVdrCapabilities.issue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    process.env = {
      ...ORIGINAL_ENV,
      ADMIN_VDR_CAPABILITY_SECRET: 'test-admin-vdr-boundary-secret-with-strong-entropy',
      WORKOS_CLIENT_ID: 'client_test_admin_vdr',
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = ORIGINAL_ENV
  })

  it('accepts one HMAC-authenticated server issuance and persists only the bearer hash', async () => {
    const tables = issuanceTables()
    const prepared = prepareIssuance()

    await expect(
      runHandler(issue, createConvexCtx(tables, { identity: ADMIN_IDENTITY }), prepared.issuance)
    ).resolves.toEqual({ expiresAt: NOW + 60_000 })

    const identityBindingDigest = await adminVdrIdentityBindingDigest(
      'workos_admin',
      TEST_ADMIN_SESSION_ID
    )

    expect(tables.adminVdrCapabilities).toEqual([
      expect.objectContaining({
        tokenHash: prepared.issuance.tokenHash,
        profileId: 'profile_admin',
        identityBindingDigest,
        companyId: 'company_1',
        action: 'DOCUMENT_ARCHIVE',
        target: 'DOCUMENT:document_1',
        inputDigest: prepared.issuance.inputDigest,
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    ])
    expect(JSON.stringify(tables)).not.toContain(prepared.capability)
    const persistedCapability = JSON.stringify(tables.adminVdrCapabilities[0])
    expect(persistedCapability).not.toContain('proof')
    expect(persistedCapability).not.toContain('workos_admin')
    expect(persistedCapability).not.toContain(TEST_ADMIN_SESSION_ID)
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        action: 'VDR_ADMIN_CAPABILITY_ISSUE',
        targetType: 'COMPANY',
        targetId: 'company_1',
        newValue: expect.objectContaining({
          action: 'DOCUMENT_ARCHIVE',
          target: 'DOCUMENT:document_1',
          inputDigest: prepared.issuance.inputDigest,
          expiresAt: NOW + 60_000,
        }),
      })
    )
    const issuanceAudit = JSON.stringify(tables.adminAuditLogs)
    expect(issuanceAudit).not.toContain(prepared.capability)
    expect(issuanceAudit).not.toContain(prepared.issuance.tokenHash)
    expect(issuanceAudit).not.toContain(identityBindingDigest)
    expect(issuanceAudit).not.toContain('workos_admin')
    expect(issuanceAudit).not.toContain(TEST_ADMIN_SESSION_ID)
  })

  it('denies duplicate token hashes, tampered proofs, session drift, and non-admin actors', async () => {
    const prepared = prepareIssuance()
    const tables = issuanceTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(issue, ctx, prepared.issuance)
    await expect(runHandler(issue, ctx, prepared.issuance)).rejects.toMatchObject({
      data: { code: 'AUTHZ_UNAUTHORIZED' },
    })

    const tamperedTables = issuanceTables()
    const firstProofCharacter = prepared.issuance.proof.at(0)
    const tamperedProof = `${firstProofCharacter === 'A' ? 'B' : 'A'}${prepared.issuance.proof.slice(1)}`
    await expect(
      runHandler(issue, createConvexCtx(tamperedTables, { identity: ADMIN_IDENTITY }), {
        ...prepared.issuance,
        proof: tamperedProof,
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(tamperedTables.adminVdrCapabilities).toHaveLength(0)

    const driftTables = issuanceTables()
    await expect(
      runHandler(
        issue,
        createConvexCtx(driftTables, {
          identity: { ...ADMIN_IDENTITY, sid: 'session_admin_other' },
        }),
        prepared.issuance
      )
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })

    const issuerTables = issuanceTables('COMPANY')
    await expect(
      runHandler(
        issue,
        createConvexCtx(issuerTables, { identity: ADMIN_IDENTITY }),
        prepared.issuance
      )
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
  })

  it.each([
    [0, 0, false, 0],
    [199, 199, false, 0],
    [200, 200, true, 1],
    [201, 200, true, 1],
  ])(
    'purges %i expired rows with a bounded batch: deleted=%i hasMore=%s schedules=%i',
    async (rowCount, deleted, hasMore, scheduled) => {
      const tables = issuanceTables()
      tables.adminVdrCapabilities = Array.from({ length: rowCount }, (_, index) => ({
        _id: `admin_vdr_capability_expired_${index}`,
        tokenHash: index.toString(16).padStart(64, '0'),
        profileId: 'profile_admin',
        identityBindingDigest: 'd'.repeat(64),
        companyId: 'company_1',
        action: 'DOCUMENT_ARCHIVE',
        target: `DOCUMENT:document_${index}`,
        inputDigest: 'e'.repeat(64),
        issuedAt: NOW - 120_000,
        expiresAt: NOW - 60_000,
      }))
      const ctx = createConvexCtx(tables)

      await expect(runHandler(_purgeExpired, ctx, {})).resolves.toEqual({ deleted, hasMore })
      expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(scheduled)
      expect(tables.adminVdrCapabilities).toHaveLength(rowCount - deleted)

      if (rowCount === 201) {
        await expect(runHandler(_purgeExpired, ctx, {})).resolves.toEqual({
          deleted: 1,
          hasMore: false,
        })
        expect(tables.adminVdrCapabilities).toHaveLength(0)
      }

      // A second/overlapping worker observes the shared post-delete state and
      // remains idempotent instead of deleting or scheduling twice.
      if (rowCount <= 200) {
        const overlappingCtx = createConvexCtx(tables)
        await expect(runHandler(_purgeExpired, overlappingCtx, {})).resolves.toEqual({
          deleted: 0,
          hasMore: false,
        })
        expect(overlappingCtx.scheduler.runAfter).not.toHaveBeenCalled()
      }
    }
  )
})
