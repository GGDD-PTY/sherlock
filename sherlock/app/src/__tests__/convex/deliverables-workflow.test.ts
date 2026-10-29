import { describe, expect, it } from 'vitest'

import { listForCompany, request, transition } from '../../../convex/deliverables'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-dbeda5ff@example.com',
}

const COMPANY_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_company',
  email: 'fixture-32f93129@example.com',
}

function baseTables(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-dbeda5ff@example.com',
      },
      {
        _id: 'user_company',
        authProvider: 'workos',
        providerUserId: 'workos_company',
        workosUserId: 'workos_company',
        email: 'fixture-32f93129@example.com',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
      {
        _id: 'profile_company',
        userId: 'user_company',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    companies: [
      {
        _id: 'company_1',
        ownerId: 'profile_company',
        name: 'Company One',
      },
      {
        _id: 'company_2',
        ownerId: 'profile_other',
        name: 'Company Two',
      },
    ],
    rateLimits: [],
  }
}

function usableDocument(id: string, companyId = 'company_1') {
  return {
    _id: id,
    companyId,
    name: `${id}.html`,
    lifecycleStatus: 'ACTIVE',
    storageId: `storage_${id}`,
    currentVersionId: `version_${id}`,
    publishedVersionId: `version_${id}`,
  }
}

function usableVersion(documentId: string, companyId = 'company_1') {
  return {
    _id: `version_${documentId}`,
    documentId,
    companyId,
    versionNumber: 1,
    storageId: `storage_${documentId}`,
    publicationStatus: 'PUBLISHED',
    verificationStatus: 'SIGNATURE_VERIFIED',
    malwareScanStatus: 'CLEAN',
  }
}

describe('deliverable workflow custody guards', () => {
  it('lists only renditions whose documents still exist in the company and are not quarantined or archived', async () => {
    const tables = baseTables()
    tables.deliverables = [
      {
        _id: 'deliverable_1',
        companyId: 'company_1',
        kind: 'TEASER',
        status: 'DRAFT_READY',
        renditions: [
          { format: 'HTML', documentId: 'document_good' },
          { format: 'PPTX', documentId: 'document_missing' },
          { format: 'PDF', documentId: 'document_foreign' },
          { format: 'XLSX', documentId: 'document_quarantined' },
          { format: 'HTML', documentId: 'document_archived' },
          { format: 'PDF', documentId: 'document_expired' },
        ],
        updatedAt: 1_900_000_000_000,
      },
    ]
    tables.documents = [
      usableDocument('document_good'),
      {
        _id: 'document_foreign',
        companyId: 'company_2',
        name: 'other-company.pdf',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'document_quarantined',
        companyId: 'company_1',
        name: 'quarantined.xlsx',
        lifecycleStatus: 'QUARANTINED',
      },
      {
        _id: 'document_archived',
        companyId: 'company_1',
        name: 'archived.html',
        lifecycleStatus: 'ARCHIVED',
      },
      { ...usableDocument('document_expired'), expiresAt: 1 },
    ]
    tables.documentVersions = [usableVersion('document_good'), usableVersion('document_expired')]

    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const result = await runHandler(listForCompany, ctx, { companyId: 'company_1' })

    expect(result).toMatchObject([
      {
        deliverableId: 'deliverable_1',
        renditions: [
          { format: 'HTML', documentId: 'document_good', versionId: 'version_document_good' },
        ],
      },
    ])
  })

  it('rejects approval when every rendition document is missing or no longer usable', async () => {
    const tables = baseTables()
    tables.deliverables = [
      {
        _id: 'deliverable_approval',
        companyId: 'company_1',
        kind: 'TEASER',
        status: 'IN_REVIEW',
        renditions: [
          { format: 'HTML', documentId: 'document_missing' },
          { format: 'PDF', documentId: 'document_archived' },
        ],
        updatedAt: 1_900_000_000_000,
      },
    ]
    tables.documents = [
      {
        _id: 'document_archived',
        companyId: 'company_1',
        name: 'archived.pdf',
        lifecycleStatus: 'ARCHIVED',
      },
    ]

    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(transition, ctx, { deliverableId: 'deliverable_approval', to: 'APPROVED' })
    ).rejects.toThrow(/rendition|vigente|utilizable/i)

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.tables.adminAuditLogs ?? []).toHaveLength(0)
  })

  it('rejects delivery when every rendition document is cross-company or quarantined', async () => {
    const tables = baseTables()
    tables.deliverables = [
      {
        _id: 'deliverable_delivery',
        companyId: 'company_1',
        kind: 'TEASER',
        status: 'APPROVED',
        renditions: [
          { format: 'HTML', documentId: 'document_foreign' },
          { format: 'PDF', documentId: 'document_quarantined' },
        ],
        updatedAt: 1_900_000_000_000,
      },
    ]
    tables.documents = [
      {
        _id: 'document_foreign',
        companyId: 'company_2',
        name: 'other-company.html',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'document_quarantined',
        companyId: 'company_1',
        name: 'quarantined.pdf',
        lifecycleStatus: 'QUARANTINED',
      },
    ]

    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(transition, ctx, { deliverableId: 'deliverable_delivery', to: 'DELIVERED' })
    ).rejects.toThrow(/rendition|vigente|utilizable/i)

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.tables.adminAuditLogs ?? []).toHaveLength(0)
  })

  it('allows approval when at least one rendition document remains usable', async () => {
    const tables = baseTables()
    tables.deliverables = [
      {
        _id: 'deliverable_approval',
        companyId: 'company_1',
        kind: 'TEASER',
        status: 'IN_REVIEW',
        renditions: [
          { format: 'HTML', documentId: 'document_good' },
          { format: 'PDF', documentId: 'document_archived' },
        ],
        updatedAt: 1_900_000_000_000,
      },
    ]
    tables.documents = [
      usableDocument('document_good'),
      {
        _id: 'document_archived',
        companyId: 'company_1',
        name: 'archived.pdf',
        lifecycleStatus: 'ARCHIVED',
      },
    ]
    tables.documentVersions = [usableVersion('document_good')]

    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(transition, ctx, { deliverableId: 'deliverable_approval', to: 'APPROVED' })
    ).resolves.toMatchObject({ status: 'APPROVED' })

    expect(tables.deliverables[0]).toMatchObject({ status: 'APPROVED' })
    expect(ctx.tables.adminAuditLogs).toEqual([
      expect.objectContaining({ action: 'DELIVERABLE_TRANSITION' }),
    ])
  })
})

describe('deliverable request audit evidence', () => {
  it('audits a newly created admin request slot with its company and kind', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: ADMIN_IDENTITY })

    const result = await runHandler<
      { companyId: string; kind: string },
      { deliverableId: string; status: string; created: boolean }
    >(request, ctx, { companyId: 'company_1', kind: 'CIM' })

    expect(result).toMatchObject({ status: 'REQUESTED', created: true })
    expect(ctx.tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'DELIVERABLE_REQUEST',
        targetType: 'DELIVERABLE',
        targetId: result.deliverableId,
        newValue: { companyId: 'company_1', kind: 'CIM', status: 'REQUESTED' },
      }),
    ])
  })

  it('does not create an admin audit record for a company self-request', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: COMPANY_IDENTITY })

    const result = await runHandler(request, ctx, { kind: 'CIM' })

    expect(result).toMatchObject({ status: 'REQUESTED', created: true })
    expect(ctx.tables.adminAuditLogs ?? []).toHaveLength(0)
  })
})
