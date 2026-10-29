import { describe, expect, it, vi } from 'vitest'

import { deleteDocumentsHard } from '../../../convex/operatorPurge'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const COMPANY = 'company_sampleenergy'
const COMPANY_NAME = 'Sample Hydro, S.A.'
const ADMIN_PROFILE = 'profile_admin'

const operatorConfirmation = {
  operatorProfileId: ADMIN_PROFILE,
  reason: 'Retención cumplida y borrado físico aprobado por el equipo.',
}

// El harness no simula `ctx.storage`; los blobs viven en la tabla `_storage` y
// este envoltorio borra de ahí, que es lo que el test necesita observar.
function ctxWithStorage(tables: Tables) {
  const base = createConvexCtx(tables)
  const deleted: string[] = []
  return {
    ctx: {
      ...base,
      storage: {
        delete: vi.fn(async (id: string) => {
          deleted.push(id)
          tables._storage = (tables._storage ?? []).filter((row) => row._id !== id)
        }),
      },
    },
    deletedBlobs: deleted,
  }
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [{ _id: COMPANY, name: COMPANY_NAME, ownerId: 'profile_owner' }],
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
        _id: 'doc_dup',
        companyId: COMPANY,
        name: 'INA_SAMPLE_ENERGY_2022_FY_v01',
        storageId: 'blob_dup',
        lifecycleStatus: 'ARCHIVED',
      },
    ],
    documentVersions: [
      {
        _id: 'ver_dup',
        documentId: 'doc_dup',
        companyId: COMPANY,
        versionNumber: 1,
        storageId: 'blob_dup',
      },
    ],
    documentAccessGrants: [{ _id: 'grant_dup', documentId: 'doc_dup', companyId: COMPANY }],
    documentRedactions: [],
    documentTextIndex: [{ _id: 'text_dup', documentId: 'doc_dup', companyId: COMPANY }],
    documentLegalHolds: [],
    documentAccessLogs: [],
    vdrReadAudits: [],
    deliverables: [],
    intakeDocuments: [],
    intakeUploadIntents: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    adminAuditLogs: [],
    _storage: [{ _id: 'blob_dup' }],
    ...overrides,
  }
}

describe('operatorPurge.deleteDocumentsHard', () => {
  it('sin execute planifica y no borra nada', async () => {
    const tables = baseTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    const result = await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
    })

    expect(result).toMatchObject({
      execute: false,
      totals: { documents: 1, versions: 1, grants: 1, textRows: 1, blobs: 1 },
    })
    expect(tables.documents).toHaveLength(1)
    expect(deletedBlobs).toEqual([])
  })

  it('borra el lote y registra una sola auditoría honesta al ADMIN explícito', async () => {
    const tables = baseTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(tables.documents).toHaveLength(0)
    expect(tables.documentVersions).toHaveLength(0)
    expect(tables.documentAccessGrants).toHaveLength(0)
    expect(tables.documentTextIndex).toHaveLength(0)
    expect(deletedBlobs).toEqual(['blob_dup'])
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: ADMIN_PROFILE,
      adminEmail: 'fixture-dbeda5ff@example.com',
      action: 'DOCUMENT_PURGE',
      targetType: 'DOCUMENT',
      previousValue: {
        documents: [
          {
            id: 'doc_dup',
            name: 'INA_SAMPLE_ENERGY_2022_FY_v01',
            lifecycleStatus: 'ARCHIVED',
          },
        ],
      },
      newValue: {
        reason: operatorConfirmation.reason,
        totals: { documents: 1, versions: 1, grants: 1, textRows: 1, blobs: 1 },
      },
    })
    expect(JSON.stringify(tables.adminAuditLogs[0]?.previousValue)).not.toContain('ACTIVE')
  })

  it('conserva un blob que otro documento vivo todavia referencia', async () => {
    const tables = baseTables()
    tables.documents.push({
      _id: 'doc_vivo',
      companyId: COMPANY,
      name: 'INA_SAMPLE_ENERGY_2022_FY_v01.pdf',
      storageId: 'blob_dup',
    })
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(deletedBlobs).toEqual([])
    expect(tables.documents.map((row) => row._id)).toEqual(['doc_vivo'])
  })

  it('rechaza un nombre de empresa que no coincide, sin borrar', async () => {
    const tables = baseTables()
    const { ctx } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_dup'],
        confirmCompanyName: 'Sample Hydro',
        execute: true,
      })
    ).rejects.toThrow(/no coincide/)
    expect(tables.documents).toHaveLength(1)
  })

  it('rechaza un documento de otra empresa, sin borrar ninguno del lote', async () => {
    const tables = baseTables()
    tables.companies.push({ _id: 'company_otra', name: 'Otra', ownerId: 'profile_owner' })
    tables.documents.push({
      _id: 'doc_ajeno',
      companyId: 'company_otra',
      name: 'x',
      storageId: 'blob_x',
    })
    const { ctx } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_dup', 'doc_ajeno'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/no pertenece/)
    expect(tables.documents).toHaveLength(2)
  })

  it('rechaza un documento con legal hold', async () => {
    const tables = baseTables({
      documentLegalHolds: [
        { _id: 'hold_1', documentId: 'doc_dup', companyId: COMPANY, status: 'ACTIVE' },
      ],
    })
    const { ctx } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_dup'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/legal hold/)
    expect(tables.documents).toHaveLength(1)
  })

  it('permite purgar cuando todos los legal holds están RELEASED', async () => {
    const tables = baseTables({
      documentLegalHolds: [
        { _id: 'hold_released', documentId: 'doc_dup', companyId: COMPANY, status: 'RELEASED' },
      ],
    })
    const { ctx } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(tables.documents).toHaveLength(0)
    expect(tables.documentLegalHolds).toHaveLength(1)
  })

  it.each(['APPROVED', 'DELIVERED'])(
    'rechaza una rendition de un entregable %s sin borrar nada',
    async (status) => {
      const tables = baseTables({
        deliverables: [
          {
            _id: `deliverable_${status.toLowerCase()}`,
            companyId: COMPANY,
            kind: 'MODEL',
            status,
            renditions: [{ format: 'PDF', documentId: 'doc_dup' }],
            updatedAt: 1_750_000_000_000,
          },
        ],
      })
      const before = structuredClone(tables)
      const { ctx, deletedBlobs } = ctxWithStorage(tables)

      await expect(
        runHandler(deleteDocumentsHard, ctx, {
          ...operatorConfirmation,
          companyId: COMPANY,
          documentIds: ['doc_dup'],
          confirmCompanyName: COMPANY_NAME,
          execute: true,
        })
      ).rejects.toThrow(/entregable/i)

      expect(tables).toEqual(before)
      expect(deletedBlobs).toEqual([])
    }
  )

  it('rechaza la segunda corrida porque todo id solicitado debe existir', async () => {
    const tables = baseTables()
    const { ctx } = ctxWithStorage(tables)
    const args = {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    }

    await runHandler(deleteDocumentsHard, ctx, args)
    await expect(runHandler(deleteDocumentsHard, ctx, args)).rejects.toThrow(/no encontr/i)
  })

  it('rechaza un id inexistente antes de borrar cualquier fila del lote', async () => {
    const tables = baseTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_dup', 'documents_missing'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/no encontr/i)

    expect(tables).toEqual(before)
    expect(deletedBlobs).toEqual([])
  })

  it('rechaza ids duplicados antes de borrar', async () => {
    const tables = baseTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: ['doc_dup', 'doc_dup'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/duplicad/i)

    expect(tables).toEqual(before)
    expect(deletedBlobs).toEqual([])
  })

  it('rechaza una lista vacía antes de borrar', async () => {
    const tables = baseTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        companyId: COMPANY,
        documentIds: [],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/vacío/i)

    expect(tables).toEqual(before)
    expect(deletedBlobs).toEqual([])
  })

  it.each([
    {
      owner: 'versión de otro documento',
      patch: {
        documentVersions: [
          {
            _id: 'ver_dup',
            documentId: 'doc_dup',
            companyId: COMPANY,
            storageId: 'blob_dup',
          },
          {
            _id: 'ver_live',
            documentId: 'doc_live',
            companyId: COMPANY,
            storageId: 'blob_dup',
          },
        ],
      },
    },
  ])('conserva el blob compartido con $owner', async ({ patch }) => {
    const tables = baseTables(patch)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(deletedBlobs).toEqual([])
    expect(tables._storage).toEqual([{ _id: 'blob_dup' }])
  })

  it.each([
    ['intakeDocuments', { _id: 'intake_doc', storageId: 'blob_dup' }],
    ['intakeUploadIntents', { _id: 'intake_intent', storageId: 'blob_dup' }],
    ['vdrUploadIntents', { _id: 'vdr_intent', storageId: 'blob_dup' }],
    ['assetUploadIntents', { _id: 'asset_intent', storageId: 'blob_dup' }],
  ])('conserva el blob cuando %s todavía lo referencia', async (table, row) => {
    const tables = baseTables({ [table]: [row] })
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(deletedBlobs).toEqual([])
  })

  it('borra una sola vez un blob único compartido dentro del lote', async () => {
    const tables = baseTables()
    tables.documents.push({
      _id: 'doc_dos',
      companyId: COMPANY,
      name: 'Segundo documento',
      storageId: 'blob_dup',
      lifecycleStatus: 'ACTIVE',
    })
    tables.documentVersions.push({
      _id: 'ver_dos',
      documentId: 'doc_dos',
      companyId: COMPANY,
      storageId: 'blob_dup',
    })
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    const result = await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup', 'doc_dos'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect(deletedBlobs).toEqual(['blob_dup'])
    expect(result).toMatchObject({ totals: { documents: 2, blobs: 1 } })
  })

  it('preserva historia y legal holds RELEASED', async () => {
    const tables = baseTables({
      documentLegalHolds: [
        { _id: 'hold_released', documentId: 'doc_dup', companyId: COMPANY, status: 'RELEASED' },
      ],
      documentAccessLogs: [{ _id: 'access_history', documentId: 'doc_dup' }],
      vdrReadAudits: [{ _id: 'read_history', documentId: 'doc_dup' }],
    })
    const historyBefore = {
      documentLegalHolds: structuredClone(tables.documentLegalHolds),
      documentAccessLogs: structuredClone(tables.documentAccessLogs),
      vdrReadAudits: structuredClone(tables.vdrReadAudits),
    }
    const { ctx } = ctxWithStorage(tables)

    await runHandler(deleteDocumentsHard, ctx, {
      ...operatorConfirmation,
      companyId: COMPANY,
      documentIds: ['doc_dup'],
      confirmCompanyName: COMPANY_NAME,
      execute: true,
    })

    expect({
      documentLegalHolds: tables.documentLegalHolds,
      documentAccessLogs: tables.documentAccessLogs,
      vdrReadAudits: tables.vdrReadAudits,
    }).toEqual(historyBefore)
  })

  it.each([
    ['perfil inexistente', 'profile_missing', /ADMIN/i],
    ['perfil COMPANY', 'profile_owner', /ADMIN/i],
    ['perfil ADMIN inactivo', ADMIN_PROFILE, /activo/i],
  ])('rechaza $0 antes del borrado', async (_, operatorProfileId, expected) => {
    const tables = baseTables()
    if (operatorProfileId === ADMIN_PROFILE) {
      tables.profiles.find((row) => row._id === ADMIN_PROFILE)!.isActive = false
    }
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        operatorProfileId,
        companyId: COMPANY,
        documentIds: ['doc_dup'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(expected)

    expect(tables.documents).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(0)
    expect(deletedBlobs).toEqual([])
  })

  it('rechaza una razón vacía antes del borrado', async () => {
    const tables = baseTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(deleteDocumentsHard, ctx, {
        ...operatorConfirmation,
        reason: '   ',
        companyId: COMPANY,
        documentIds: ['doc_dup'],
        confirmCompanyName: COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(/razón/i)

    expect(tables.documents).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(0)
    expect(deletedBlobs).toEqual([])
  })
})
