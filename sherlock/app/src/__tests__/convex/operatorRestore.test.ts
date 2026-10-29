import { describe, expect, it } from 'vitest'

import { restoreArchivedDocuments, setCompanyName } from '../../../convex/operatorRestore'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const COMPANY = 'company_sampleenergy'
const COMPANY_NAME = 'Sample Hydro, S.A.'
const OTHER_COMPANY = 'company_samplelogistics'
const ADMIN_PROFILE = 'profile_admin'

const operatorConfirmation = {
  operatorProfileId: ADMIN_PROFILE,
  reason: 'Los siete documentos se archivaron a mano por error el 2026-09-07.',
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [
      { _id: COMPANY, name: COMPANY_NAME, ownerId: 'profile_owner' },
      { _id: OTHER_COMPANY, name: 'Sample Logistics, S.A.', ownerId: 'profile_owner' },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' },
      { _id: ADMIN_PROFILE, userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    users: [
      { _id: 'user_owner', email: 'fixture-befbb74d@example.com' },
      { _id: 'user_admin', email: 'fixture-dbeda5ff@example.com' },
    ],
    documents: [
      {
        _id: 'doc_archivado',
        companyId: COMPANY,
        name: 'INA_SAMPLE_ENERGY_2022_FY_v01',
        lifecycleStatus: 'ARCHIVED',
        archivedAt: 1_757_000_000_000,
        archivedByProfileId: ADMIN_PROFILE,
        currentVersionId: 'ver_archivado',
        protectionPolicyVersion: 'trust-os-v2',
      },
      {
        _id: 'doc_vivo',
        companyId: COMPANY,
        name: 'Estados financieros 2025',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'doc_ajeno',
        companyId: OTHER_COMPANY,
        name: 'Contrato SAMPLE_LOGISTICS',
        lifecycleStatus: 'ARCHIVED',
      },
    ],
    documentVersions: [
      {
        _id: 'ver_archivado',
        documentId: 'doc_archivado',
        companyId: COMPANY,
        versionNumber: 1,
        publicationStatus: 'ARCHIVED',
      },
    ],
    // El archivado los revocó; la restauración NO los resucita.
    documentAccessGrants: [
      {
        _id: 'grant_revocado',
        documentId: 'doc_archivado',
        companyId: COMPANY,
        status: 'REVOKED',
        revokedReason: 'DOCUMENT_ARCHIVED',
      },
    ],
    activityLogs: [],
    adminAuditLogs: [],
    ...overrides,
  }
}

describe('operatorRestore.restoreArchivedDocuments', () => {
  it('devuelve el documento a ACTIVE, republica su versión y deja los dos recibos', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(restoreArchivedDocuments, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_archivado'],
      confirmCompanyName: COMPANY_NAME,
    })

    expect(result).toEqual({ restored: 1, skipped: [] })

    const document = tables.documents.find((row) => row._id === 'doc_archivado')
    expect(document).toMatchObject({
      lifecycleStatus: 'ACTIVE',
      protectionPolicyVersion: 'trust-os-v2',
    })
    // `undefined` en el patch BORRA la clave: el sello del archivado se va.
    expect(document).not.toHaveProperty('archivedAt')
    expect(document).not.toHaveProperty('archivedByProfileId')
    expect(typeof document?.updatedAt).toBe('number')

    expect(tables.documentVersions[0]).toMatchObject({ publicationStatus: 'PUBLISHED' })

    expect(tables.activityLogs).toHaveLength(1)
    expect(tables.activityLogs[0]).toMatchObject({
      userId: ADMIN_PROFILE,
      action: 'VDR_DOCUMENT_RESTORED',
      entityType: 'DOCUMENT',
      entityId: 'doc_archivado',
      metadata: { resourceType: 'COMPANY', resourceId: COMPANY },
    })

    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: ADMIN_PROFILE,
      adminEmail: 'fixture-dbeda5ff@example.com',
      action: 'DOCUMENT_RESTORE',
      targetType: 'DOCUMENT',
      targetId: 'doc_archivado',
      previousValue: {
        documents: [
          {
            id: 'doc_archivado',
            name: 'INA_SAMPLE_ENERGY_2022_FY_v01',
            lifecycleStatus: 'ARCHIVED',
            archivedAt: 1_757_000_000_000,
          },
        ],
      },
      newValue: {
        reason: operatorConfirmation.reason,
        totals: { documents: 1, versionsPublished: 1 },
      },
      notes: operatorConfirmation.reason,
    })
  })

  it('no resucita los grants que el archivado revocó', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await runHandler(restoreArchivedDocuments, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_archivado'],
      confirmCompanyName: COMPANY_NAME,
    })

    expect(tables.documentAccessGrants).toHaveLength(1)
    expect(tables.documentAccessGrants[0]).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'DOCUMENT_ARCHIVED',
    })
  })

  it('rechaza un confirmCompanyName que no es el nombre exacto', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(restoreArchivedDocuments, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_archivado'],
        confirmCompanyName: 'Sample Hydro',
      })
    ).rejects.toThrow(/no coincide/)

    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(tables.activityLogs).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rechaza el lote entero si un documento no está archivado', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(restoreArchivedDocuments, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_archivado', 'doc_vivo'],
        confirmCompanyName: COMPANY_NAME,
      })
    ).rejects.toThrow(/no archivados: doc_vivo \(ACTIVE\)/)

    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(tables.documentVersions[0]).toMatchObject({ publicationStatus: 'ARCHIVED' })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rechaza el lote entero si un documento es de otra empresa', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(restoreArchivedDocuments, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_archivado', 'doc_ajeno'],
        confirmCompanyName: COMPANY_NAME,
      })
    ).rejects.toThrow(/de otra empresa: doc_ajeno/)

    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(tables.documents[2]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(tables.activityLogs).toHaveLength(0)
  })

  it('exige un perfil ADMIN real como operador', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(restoreArchivedDocuments, ctx, {
        ...operatorConfirmation,
        operatorProfileId: 'profile_owner',
        companyId: COMPANY,
        documentIds: ['doc_archivado'],
        confirmCompanyName: COMPANY_NAME,
      })
    ).rejects.toThrow(/ADMIN/)

    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
  })
})

describe('operatorRestore.setCompanyName', () => {
  const renameConfirmation = {
    operatorProfileId: ADMIN_PROFILE,
    reason: 'El claim de la landing la renombró a "Sample Foods, S.A.".',
  }

  it('renombra, normaliza y registra el nombre anterior en la bitácora', async () => {
    const tables = baseTables({
      companies: [
        {
          _id: COMPANY,
          name: 'Sample Foods, S.A.',
          legalName: 'Sample Foods',
          ownerId: 'profile_owner',
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runHandler(setCompanyName, ctx, {
      ...renameConfirmation,
      companyId: COMPANY,
      name: '  Sample   Hydro, S.A. ',
      legalName: 'Sample Hydro, S.A.',
      confirmCurrentName: 'Sample Foods, S.A.',
    })

    expect(result).toMatchObject({
      previousName: 'Sample Foods, S.A.',
      name: COMPANY_NAME,
      legalName: COMPANY_NAME,
    })
    expect(tables.companies[0]).toMatchObject({ name: COMPANY_NAME, legalName: COMPANY_NAME })

    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: ADMIN_PROFILE,
      adminEmail: 'fixture-dbeda5ff@example.com',
      action: 'COMPANY_RENAME',
      targetType: 'COMPANY',
      targetId: COMPANY,
      previousValue: { name: 'Sample Foods, S.A.', legalName: 'Sample Foods' },
      newValue: { name: COMPANY_NAME, legalName: COMPANY_NAME, reason: renameConfirmation.reason },
    })
  })

  it('deja la razón social intacta cuando no viene en los argumentos', async () => {
    const tables = baseTables({
      companies: [
        {
          _id: COMPANY,
          name: 'Sample Foods, S.A.',
          legalName: 'Sample Foods',
          ownerId: 'profile_owner',
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    await runHandler(setCompanyName, ctx, {
      ...renameConfirmation,
      companyId: COMPANY,
      name: COMPANY_NAME,
      confirmCurrentName: 'Sample Foods, S.A.',
    })

    expect(tables.companies[0]).toMatchObject({ name: COMPANY_NAME, legalName: 'Sample Foods' })
  })

  it('rechaza un confirmCurrentName que no es el nombre actual', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(setCompanyName, ctx, {
        ...renameConfirmation,
        companyId: COMPANY,
        name: 'Sample Foods, S.A.',
        confirmCurrentName: 'Sample Hydro',
      })
    ).rejects.toThrow(/no coincide/)

    expect(tables.companies[0]).toMatchObject({ name: COMPANY_NAME })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rechaza un nombre que el normalizador no acepta', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(setCompanyName, ctx, {
        ...renameConfirmation,
        companyId: COMPANY,
        name: '   ',
        confirmCurrentName: COMPANY_NAME,
      })
    ).rejects.toThrow(/no es válido/)

    expect(tables.companies[0]).toMatchObject({ name: COMPANY_NAME })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })
})
