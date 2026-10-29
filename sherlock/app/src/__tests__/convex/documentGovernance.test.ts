import { describe, expect, it } from 'vitest'

import {
  getGovernanceStatus,
  placeLegalHold,
  releaseLegalHold,
} from '../../../convex/_documents/governance'
import { processAccountDeletion } from '../../../convex/gdpr'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function authorizePlace(tables: Tables, input: Record<string, unknown>) {
  return mintAdminVdrCapability({
    tables,
    input,
    companyId: 'company_1',
    action: 'DOCUMENT_LEGAL_HOLD_PLACE',
    target: 'DOCUMENT:document_1',
  })
}
const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}

function governanceTables(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
      {
        _id: 'user_issuer',
        authProvider: 'workos',
        providerUserId: 'workos_issuer',
        workosUserId: 'workos_issuer',
        email: 'issuer@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      { _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true },
    ],
    organizationMemberships: [
      {
        _id: 'membership_issuer',
        userId: 'user_issuer',
        profileId: 'profile_issuer',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        workosOrgId: 'org_issuer',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: 1,
      },
    ],
    companies: [{ _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer' }],
    companyOrganizationBindings: [
      {
        _id: 'binding_company_1',
        companyId: 'company_1',
        ownerProfileId: 'profile_issuer',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        createdAt: 1,
        createdByProfileId: 'profile_issuer',
      },
    ],
    documents: [
      {
        _id: 'document_1',
        companyId: 'company_1',
        dealId: 'deal_1',
        name: 'Board minutes',
        lifecycleStatus: 'ARCHIVED',
      },
    ],
    documentLegalHolds: [],
    deletionRequests: [
      {
        _id: 'deletion_request_1',
        profileId: 'profile_issuer',
        status: 'PENDING',
        email: 'issuer@example.com',
      },
    ],
    activityLogs: [],
    adminAuditLogs: [],
    rateLimits: [],
  }
}

describe('document legal hold governance', () => {
  it('requires an administrator, preserves an auditable active hold, and prevents duplicates', async () => {
    const tables = governanceTables()
    const ownerCtx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    await expect(
      runHandler(placeLegalHold, ownerCtx, {
        documentId: 'document_1',
        reason: 'Pending litigation preservation request',
      })
    ).rejects.toThrow(/administrador/i)

    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const placeInput = {
      documentId: 'document_1',
      reason: 'Pending litigation preservation request',
      externalReference: 'MATTER-2026-014',
    }
    const result = (await runHandler(
      placeLegalHold,
      adminCtx,
      await authorizePlace(tables, placeInput)
    )) as { holdId: string }

    expect(tables.documentLegalHolds[0]).toMatchObject({
      _id: result.holdId,
      documentId: 'document_1',
      status: 'ACTIVE',
      placedByProfileId: 'profile_admin',
    })
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({ action: 'DOCUMENT_LEGAL_HOLD_PLACE' })
    )
    const duplicateInput = {
      documentId: 'document_1',
      reason: 'A second hold must not race the first one',
    }
    await expect(
      runHandler(placeLegalHold, adminCtx, await authorizePlace(tables, duplicateInput))
    ).rejects.toThrow(/activo/i)
  })

  it('shows owners only hold status while administrators receive the legal reason', async () => {
    const tables = governanceTables()
    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const placeInput = {
      documentId: 'document_1',
      reason: 'Regulatory preservation notice received',
      externalReference: 'REG-88',
    }
    await runHandler(placeLegalHold, adminCtx, await authorizePlace(tables, placeInput))

    const ownerStatus = (await runHandler(
      getGovernanceStatus,
      createConvexCtx(tables, { identity: ISSUER_IDENTITY }),
      { documentId: 'document_1' }
    )) as { legalHold: Record<string, unknown> | null }
    expect(ownerStatus.legalHold).toMatchObject({ status: 'ACTIVE' })
    expect(ownerStatus.legalHold).not.toHaveProperty('reason')
    expect(ownerStatus.legalHold).not.toHaveProperty('externalReference')

    const adminStatus = (await runHandler(getGovernanceStatus, adminCtx, {
      documentId: 'document_1',
    })) as { legalHold: Record<string, unknown> | null }
    expect(adminStatus.legalHold).toMatchObject({
      reason: 'Regulatory preservation notice received',
      externalReference: 'REG-88',
    })
  })

  it('releases a hold append-only and records the administrative decision', async () => {
    const tables = governanceTables()
    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const placeInput = {
      documentId: 'document_1',
      reason: 'Preserve for a controlled legal review',
    }
    const { holdId } = (await runHandler(
      placeLegalHold,
      adminCtx,
      await authorizePlace(tables, placeInput)
    )) as { holdId: string }

    const releaseInput = {
      holdId,
      reason: 'Counsel confirmed the preservation duty has ended',
    }
    await expect(
      runHandler(
        releaseLegalHold,
        adminCtx,
        await mintAdminVdrCapability({
          tables,
          input: releaseInput,
          companyId: 'company_1',
          action: 'DOCUMENT_LEGAL_HOLD_RELEASE',
          target: `LEGAL_HOLD:${holdId}`,
        })
      )
    ).resolves.toEqual({ released: true })
    expect(tables.documentLegalHolds[0]).toMatchObject({
      status: 'RELEASED',
      releasedByProfileId: 'profile_admin',
      releasedAt: expect.any(Number),
    })
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({ action: 'DOCUMENT_LEGAL_HOLD_RELEASE' })
    )
  })

  it('blocks account erasure before any cascade when company evidence is under hold', async () => {
    const tables = governanceTables()
    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const placeInput = {
      documentId: 'document_1',
      reason: 'Preserve evidence while the legal duty remains active',
    }
    await runHandler(placeLegalHold, adminCtx, await authorizePlace(tables, placeInput))

    await expect(
      runHandler(processAccountDeletion, adminCtx, { requestId: 'deletion_request_1' })
    ).rejects.toThrow(/legal hold/i)
    expect(tables.deletionRequests[0]).toMatchObject({ status: 'PENDING' })
    expect(tables.documents).toHaveLength(1)
    expect(tables.companies).toHaveLength(1)
  })
})
