import { describe, expect, it } from 'vitest'

import { bulkUpdate } from '../../../convex/_documents/bulk'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}

const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function bulkTables(): Tables {
  return {
    users: [
      {
        _id: 'user_issuer',
        authProvider: 'workos',
        providerUserId: 'workos_issuer',
        workosUserId: 'workos_issuer',
        email: 'issuer@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [
      { _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
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
        name: 'Model',
        lifecycleStatus: 'ACTIVE',
        folder: 'model',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        currentVersionId: 'version_1',
      },
      {
        _id: 'document_2',
        companyId: 'company_1',
        name: 'Financials',
        lifecycleStatus: 'ACTIVE',
        folder: 'financials',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
      },
      {
        _id: 'document_company',
        companyId: 'company_1',
        name: 'Corporate library',
        lifecycleStatus: 'ACTIVE',
        folder: 'legal',
        accessLevel: 'PRIVATE',
        classification: 'LEGAL',
      },
    ],
    documentVersions: [
      {
        _id: 'version_1',
        documentId: 'document_1',
        publicationStatus: 'PUBLISHED',
      },
    ],
    documentAccessGrants: [
      {
        _id: 'grant_1',
        documentId: 'document_1',
        profileId: 'profile_investor',
        tokenHash: 'hash',
        expiresAt: Date.now() + 60_000,
      },
    ],
    documentLegalHolds: [],
    activityLogs: [],
    adminAuditLogs: [],
    rateLimits: [],
  }
}

describe('documents.bulkUpdate', () => {
  it('moves a bounded selection and writes per-item activity and admin audit', async () => {
    const tables = bulkTables()
    const input = {
      companyId: 'company_1',
      documentIds: ['document_1', 'document_2'],
      operation: { type: 'MOVE_FOLDER' as const, folder: ' room_legal ' },
    }
    const result = await runHandler(
      bulkUpdate,
      createConvexCtx(tables, { identity: ADMIN_IDENTITY }),
      await mintAdminVdrCapability({
        tables,
        input,
        companyId: 'company_1',
        action: 'DOCUMENT_BULK_UPDATE',
        target: 'COMPANY:company_1',
      })
    )

    expect(result).toMatchObject({ updated: 2, revokedGrants: 0 })
    expect(tables.documents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: 'document_1', folder: 'room_legal' }),
        expect.objectContaining({ _id: 'document_2', folder: 'room_legal' }),
      ])
    )
    expect(tables.activityLogs).toHaveLength(2)
    expect(tables.adminAuditLogs).toHaveLength(3)
    expect(tables.adminAuditLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'VDR_ADMIN_CAPABILITY_CONSUME' }),
        expect.objectContaining({ action: 'DOCUMENT_METADATA_UPDATE' }),
        expect.objectContaining({ action: 'DOCUMENT_METADATA_UPDATE' }),
      ])
    )
    expect(tables.rateLimits).toEqual([
      expect.objectContaining({ key: 'documentBulkUpdate:profile_admin', count: 1 }),
    ])
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-capability'],
  ])(
    'denies a %s admin capability before exposing or changing rate-limit state',
    async (_label, adminCapability) => {
      const tables = bulkTables()
      const windowStart = Date.now()
      tables.rateLimits.push({
        _id: 'rate_limit_admin_bulk',
        key: 'documentBulkUpdate:profile_admin',
        count: 30,
        windowStart,
        windowMs: 60 * 60 * 1000,
        lastHitAt: windowStart,
      })
      const beforeRateLimits = tables.rateLimits.map((row) => ({ ...row }))

      await expect(
        runHandler(bulkUpdate, createConvexCtx(tables, { identity: ADMIN_IDENTITY }), {
          companyId: 'company_1',
          documentIds: ['document_1'],
          operation: { type: 'MOVE_FOLDER', folder: 'legal' },
          ...(adminCapability === undefined ? {} : { adminCapability }),
        })
      ).rejects.toThrow(/autorización administrativa VDR válida/i)

      expect(tables.rateLimits).toEqual(beforeRateLimits)
      expect(tables.documents[0]).toMatchObject({ folder: 'model' })
      expect(tables.activityLogs).toHaveLength(0)
      expect(tables.adminAuditLogs).toHaveLength(0)
    }
  )

  // El lote es de UNA empresa: el preflight corre entero antes de la primera
  // escritura, así que un documento ajeno mata la tanda sin tocar nada.
  it('preflights the exact company before changing any selected document', async () => {
    const tables = bulkTables()
    tables.documents.push({
      _id: 'document_foreign',
      companyId: 'company_other',
      name: 'Foreign',
      lifecycleStatus: 'ACTIVE',
      folder: 'model',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
    })
    const before = tables.documents.map((document) => ({ ...document }))

    await expect(
      runHandler(bulkUpdate, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        companyId: 'company_1',
        documentIds: ['document_1', 'document_foreign'],
        operation: { type: 'MOVE_FOLDER', folder: 'room_legal' },
      })
    ).rejects.toThrow(/misma empresa/i)

    expect(tables.documents).toEqual(before)
    expect(tables.activityLogs).toHaveLength(0)
  })

  it('changes only compatible disclosure and revokes every open grant', async () => {
    const tables = bulkTables()
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })

    await expect(
      runHandler(bulkUpdate, ctx, {
        companyId: 'company_1',
        documentIds: ['document_1'],
        operation: {
          type: 'CHANGE_DISCLOSURE',
          accessLevel: 'PUBLIC',
          classification: 'LEGAL',
        },
      })
    ).rejects.toThrow(/compatible/i)

    const result = await runHandler(bulkUpdate, ctx, {
      companyId: 'company_1',
      documentIds: ['document_1'],
      operation: {
        type: 'CHANGE_DISCLOSURE',
        accessLevel: 'PRIVATE',
        classification: 'RESTRICTED',
      },
    })

    expect(result).toMatchObject({ updated: 1, revokedGrants: 1 })
    expect(tables.documents[0]).toMatchObject({
      accessLevel: 'PRIVATE',
      classification: 'RESTRICTED',
    })
    expect(tables.documentAccessGrants[0]).toMatchObject({
      revokedAt: expect.any(Number),
      outcome: 'DOCUMENT_DISCLOSURE_CHANGED',
    })
  })

  it('rejects a quarantined disclosure change before touching active documents', async () => {
    const tables = bulkTables()
    tables.documents[1].lifecycleStatus = 'QUARANTINED'
    const before = tables.documents.map((document) => ({ ...document }))

    await expect(
      runHandler(bulkUpdate, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        companyId: 'company_1',
        documentIds: ['document_1', 'document_2'],
        operation: {
          type: 'CHANGE_DISCLOSURE',
          accessLevel: 'PRIVATE',
          classification: 'RESTRICTED',
        },
      })
    ).rejects.toThrow(/cuarentena/i)

    expect(tables.documents).toEqual(before)
    expect(tables.documentAccessGrants[0]).not.toHaveProperty('revokedAt')
    expect(tables.activityLogs).toHaveLength(0)
  })

  it('archives without deleting held evidence and records every admin action', async () => {
    const tables = bulkTables()
    tables.documentLegalHolds.push({
      _id: 'hold_1',
      documentId: 'document_1',
      companyId: 'company_1',
      status: 'ACTIVE',
      reason: 'Preserve for legal review',
      placedAt: Date.now(),
      placedByProfileId: 'profile_admin',
    })

    const input = {
      companyId: 'company_1',
      documentIds: ['document_1', 'document_2'],
      operation: { type: 'ARCHIVE' as const },
    }
    const result = await runHandler(
      bulkUpdate,
      createConvexCtx(tables, { identity: ADMIN_IDENTITY }),
      await mintAdminVdrCapability({
        tables,
        input,
        companyId: 'company_1',
        action: 'DOCUMENT_BULK_UPDATE',
        target: 'COMPANY:company_1',
      })
    )

    expect(result).toMatchObject({ updated: 2, revokedGrants: 1, legalHoldsPreserved: 1 })
    expect(tables.documents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: 'document_1', lifecycleStatus: 'ARCHIVED' }),
        expect.objectContaining({ _id: 'document_2', lifecycleStatus: 'ARCHIVED' }),
      ])
    )
    expect(tables.documentVersions).toEqual([
      expect.objectContaining({ _id: 'version_1', publicationStatus: 'ARCHIVED' }),
    ])
    expect(tables.documentLegalHolds).toEqual([
      expect.objectContaining({ _id: 'hold_1', status: 'ACTIVE' }),
    ])
    expect(tables.adminAuditLogs).toHaveLength(3)
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({ action: 'VDR_ADMIN_CAPABILITY_CONSUME' })
    )
    expect(tables.activityLogs).toHaveLength(2)
  })

  // Este test PINEABA la negativa en lote. La decisión de Maintainer del
  // 2026-09-17 —el cliente es dueño de su VDR y puede quitar de él lo que
  // quiera— la saca del camino de archivar, y la selección múltiple es la MISMA
  // puerta desde la misma barra de la sala (`bulkArchiveDocuments`): responde
  // igual que archivar de a uno, registrando el retiro y avisando al equipo.
  it('lets the owner bulk archive a selection that contains a delivered rendition', async () => {
    const tables = bulkTables()
    tables.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [
          { format: 'PDF', documentId: 'document_1' },
          { format: 'PPTX', documentId: 'document_2' },
        ],
      },
    ]

    const result = await runHandler(
      bulkUpdate,
      createConvexCtx(tables, { identity: ISSUER_IDENTITY }),
      {
        companyId: 'company_1',
        scope: 'DEAL',
        dealId: 'deal_1',
        documentIds: ['document_1', 'document_2'],
        operation: { type: 'ARCHIVE' },
      }
    )

    expect(result).toMatchObject({ updated: 2 })
    expect(tables.documents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: 'document_1', lifecycleStatus: 'ARCHIVED' }),
        expect.objectContaining({ _id: 'document_2', lifecycleStatus: 'ARCHIVED' }),
      ])
    )
    // Un solo patch y un solo aviso aunque el lote traiga dos renditions del
    // mismo slot.
    expect(tables.deliverables[0]?.renditions).toEqual([
      expect.objectContaining({ format: 'PDF', withdrawnByProfileId: 'profile_issuer' }),
      expect.objectContaining({ format: 'PPTX', withdrawnByProfileId: 'profile_issuer' }),
    ])
    const withdrawalLogs = tables.activityLogs.filter(
      (row) => row.action === 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'
    )
    expect(withdrawalLogs).toHaveLength(1)
    expect(withdrawalLogs[0]?.metadata).toMatchObject({
      kind: 'MGMT_PRESENTATION',
      fullyWithdrawn: true,
    })
    expect(tables.notifications ?? []).toEqual([
      expect.objectContaining({ userId: 'profile_admin', entityType: 'deliverable' }),
    ])
  })

  // Lo que NO cambia: el equipo no saca su propia entrega archivando el
  // documento por debajo del slot ([F] 2026-09-17, punto 4 del brief). El lote
  // entero muere antes de la primera escritura.
  it('still refuses when an ADMIN bulk archives a selection with a delivered rendition', async () => {
    const tables = bulkTables()
    tables.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId: 'document_1' }],
      },
    ]
    const before = tables.documents.map((document) => ({ ...document }))
    const input = {
      companyId: 'company_1',
      documentIds: ['document_1', 'document_2'],
      operation: { type: 'ARCHIVE' as const },
    }

    await expect(
      runHandler(
        bulkUpdate,
        createConvexCtx(tables, { identity: ADMIN_IDENTITY }),
        await mintAdminVdrCapability({
          tables,
          input,
          companyId: 'company_1',
          action: 'DOCUMENT_BULK_UPDATE',
          target: 'COMPANY:company_1',
        })
      )
    ).rejects.toThrow(/entrega del equipo/i)

    expect(tables.documents).toEqual(before)
    expect(tables.deliverables[0]?.renditions).toEqual([
      { format: 'PDF', documentId: 'document_1' },
    ])
    expect(tables.activityLogs).toHaveLength(0)
  })

  // El contrapeso: un slot en preparación no es trabajo publicado, así que el
  // lote sigue archivando.
  it('still bulk archives when the deliverable that lists the document is a draft', async () => {
    const tables = bulkTables()
    tables.deliverables = [
      {
        _id: 'deliverable_draft',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DRAFT',
        renditions: [{ format: 'PDF', documentId: 'document_1' }],
      },
    ]

    const result = await runHandler(
      bulkUpdate,
      createConvexCtx(tables, { identity: ISSUER_IDENTITY }),
      {
        companyId: 'company_1',
        scope: 'DEAL',
        dealId: 'deal_1',
        documentIds: ['document_1'],
        operation: { type: 'ARCHIVE' },
      }
    )

    expect(result).toMatchObject({ updated: 1 })
    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
  })

  it('rejects empty, duplicate, or over-limit selections', async () => {
    const tables = bulkTables()
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    const base = {
      companyId: 'company_1',
      operation: { type: 'ARCHIVE' as const },
    }

    await expect(runHandler(bulkUpdate, ctx, { ...base, documentIds: [] })).rejects.toThrow(
      /entre 1 y 50/i
    )
    await expect(
      runHandler(bulkUpdate, ctx, {
        ...base,
        documentIds: ['document_1', 'document_1'],
      })
    ).rejects.toThrow(/duplicados/i)
    await expect(
      runHandler(bulkUpdate, ctx, {
        ...base,
        documentIds: Array.from({ length: 51 }, (_, index) => `document_${index}`),
      })
    ).rejects.toThrow(/entre 1 y 50/i)
  })
})
