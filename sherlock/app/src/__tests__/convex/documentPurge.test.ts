// ============================================================================
// BORRADO PERMANENTE DEL DUEÑO DE LA SALA (`documents.purge`)
// ============================================================================
// `documents.remove` archiva y conserva bytes; esto borra de verdad. Lo que
// estas pruebas fijan es la frontera, no el plan físico (ese ya lo cubre
// `operator-purge.test.ts` sobre el mismo `_documents/purge.ts`):
//
//   1. el dueño borra SU documento y con él sus filas de custodia y su blob;
//   2. el dueño NO puede borrar el de otra empresa, y el lote entero muere
//      antes de tocar nada;
//   3. un legal hold ACTIVE gana sobre la voluntad del dueño;
//   4. cuando quien borra es ADMIN, queda `DOCUMENT_PURGE` en `adminAuditLogs`.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import { purge } from '../../../convex/_documents/mutations'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const OWNER_IDENTITY = {
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

// El harness no simula `ctx.storage`; los blobs viven en la tabla `_storage` y
// este envoltorio borra de ahí, que es lo que la prueba necesita observar.
function ctxWithStorage(tables: Tables, identity: Record<string, unknown>) {
  const base = createConvexCtx(tables, { identity })
  const deletedBlobs: string[] = []
  return {
    ctx: {
      ...base,
      storage: {
        delete: vi.fn(async (id: string) => {
          deletedBlobs.push(id)
          tables._storage = (tables._storage ?? []).filter((row) => row._id !== id)
        }),
      },
    },
    deletedBlobs,
  }
}

function purgeTables(): Tables {
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
      {
        _id: 'user_rival',
        authProvider: 'workos',
        providerUserId: 'workos_rival',
        workosUserId: 'workos_rival',
        email: 'rival@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      { _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      { _id: 'profile_rival', userId: 'user_rival', role: 'COMPANY', isActive: true },
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
    companies: [
      { _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer' },
      { _id: 'company_2', ownerId: 'profile_rival', name: 'Rival' },
    ],
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
        _id: 'document_own',
        companyId: 'company_1',
        name: 'Estados financieros.pdf',
        lifecycleStatus: 'ACTIVE',
        folder: 'room_financial',
        storageId: 'blob_own',
      },
      {
        _id: 'document_held',
        companyId: 'company_1',
        name: 'Contrato retenido.pdf',
        lifecycleStatus: 'ACTIVE',
        folder: 'room_legal',
        storageId: 'blob_held',
      },
      {
        _id: 'document_rival',
        companyId: 'company_2',
        name: 'Modelo ajeno.xlsx',
        lifecycleStatus: 'ACTIVE',
        folder: 'room_financial',
        storageId: 'blob_rival',
      },
      {
        _id: 'document_delivered',
        companyId: 'company_1',
        name: 'Modelo v1.xlsx',
        lifecycleStatus: 'ACTIVE',
        folder: 'room_financial',
        storageId: 'blob_delivered',
      },
    ],
    documentVersions: [
      {
        _id: 'version_own',
        documentId: 'document_own',
        companyId: 'company_1',
        versionNumber: 1,
        storageId: 'blob_own_v1',
      },
    ],
    documentAccessGrants: [
      { _id: 'grant_own', documentId: 'document_own', companyId: 'company_1' },
    ],
    documentRedactions: [],
    documentTextIndex: [{ _id: 'text_own', documentId: 'document_own', companyId: 'company_1' }],
    documentLegalHolds: [
      { _id: 'hold_held', documentId: 'document_held', companyId: 'company_1', status: 'ACTIVE' },
    ],
    deliverables: [
      {
        _id: 'deliverable_model',
        companyId: 'company_1',
        status: 'APPROVED',
        renditions: [{ documentId: 'document_delivered' }],
      },
      // Un borrador NO bloquea: sólo lo aprobado o entregado es trabajo
      // publicado que el cliente no puede destruir por su cuenta.
      {
        _id: 'deliverable_draft',
        companyId: 'company_1',
        status: 'DRAFT',
        renditions: [{ documentId: 'document_own' }],
      },
    ],
    intakeDocuments: [],
    intakeUploadIntents: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    activityLogs: [],
    adminAuditLogs: [],
    adminVdrCapabilities: [],
    rateLimits: [],
    _storage: [
      { _id: 'blob_own' },
      { _id: 'blob_own_v1' },
      { _id: 'blob_held' },
      { _id: 'blob_delivered' },
    ],
  }
}

describe('documents.purge — el dueño borra sus propios documentos', () => {
  it('borra el documento, sus filas de custodia y sus blobs sin dueño vivo', async () => {
    const tables = purgeTables()
    // El intento consumido que subió la versión no es un dueño vivo del blob.
    tables.vdrUploadIntents = [
      {
        _id: 'intent_consumed',
        status: 'CONSUMED',
        storageId: 'blob_own_v1',
        documentId: 'document_own',
        companyId: 'company_1',
      },
    ]
    const { ctx, deletedBlobs } = ctxWithStorage(tables, OWNER_IDENTITY)

    const result = await runHandler(purge, ctx, { documentIds: ['document_own'] })

    expect(result).toEqual({ purged: 1 })
    expect(tables.documents.map((row) => row._id)).toEqual([
      'document_held',
      'document_rival',
      'document_delivered',
    ])
    expect(tables.documentVersions).toHaveLength(0)
    expect(tables.documentAccessGrants).toHaveLength(0)
    expect(tables.documentTextIndex).toHaveLength(0)
    expect(deletedBlobs.sort()).toEqual(['blob_own', 'blob_own_v1'])
    expect(tables.activityLogs).toEqual([
      expect.objectContaining({
        userId: 'profile_issuer',
        action: 'VDR_DOCUMENT_DELETED',
        entityType: 'DOCUMENT',
        entityId: 'document_own',
        metadata: { resourceType: 'COMPANY', resourceId: 'company_1' },
      }),
    ])
    // El dueño no es ADMIN: su borrado no inventa una fila de auditoría admin.
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rechaza el documento de otra empresa y no borra nada del lote', async () => {
    const tables = purgeTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables, OWNER_IDENTITY)

    await expect(
      runHandler(purge, ctx, { documentIds: ['document_own', 'document_rival'] })
    ).rejects.toThrow(/dueño de la empresa/i)

    expect(tables.documents).toHaveLength(4)
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.documentAccessGrants).toHaveLength(1)
    expect(deletedBlobs).toEqual([])
    expect(tables.activityLogs).toHaveLength(0)
  })

  it('se niega mientras haya un legal hold ACTIVE, aunque lo pida el dueño', async () => {
    const tables = purgeTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables, OWNER_IDENTITY)

    await expect(
      runHandler(purge, ctx, { documentIds: ['document_own', 'document_held'] })
    ).rejects.toThrow(/legal hold ACTIVE/)

    expect(tables.documents).toHaveLength(4)
    expect(deletedBlobs).toEqual([])
    expect(tables.activityLogs).toHaveLength(0)
  })

  // El rol abre la puerta; la capability delegada acredita el gesto exacto de
  // esta sesión. Un ADMIN sin ella podía borrar de verdad lo que archivar sí le
  // exigía acreditar (Grok, ronda 1 del PR #562).
  it('rechaza al ADMIN que no trae la capability delegada', async () => {
    const tables = purgeTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables, ADMIN_IDENTITY)

    await expect(runHandler(purge, ctx, { documentIds: ['document_own'] })).rejects.toThrow(
      /autorización administrativa VDR/i
    )

    expect(tables.documents).toHaveLength(4)
    expect(deletedBlobs).toEqual([])
    expect(tables.activityLogs).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  // Un lote que cruza empresas no tiene UNA sala a la que atar la capability.
  it('rechaza al ADMIN un lote que mezcla dos salas', async () => {
    const tables = purgeTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables, ADMIN_IDENTITY)

    await expect(
      runHandler(purge, ctx, { documentIds: ['document_own', 'document_rival'] })
    ).rejects.toThrow(/misma empresa/i)

    expect(tables.documents).toHaveLength(4)
    expect(deletedBlobs).toEqual([])
  })

  it('deja auditoría admin cuando quien borra es del equipo con su capability', async () => {
    const tables = purgeTables()
    const { ctx } = ctxWithStorage(tables, ADMIN_IDENTITY)

    await runHandler(
      purge,
      ctx,
      await mintAdminVdrCapability({
        tables,
        input: { documentIds: ['document_own'] },
        companyId: 'company_1',
        action: 'DOCUMENT_PURGE',
        target: 'COMPANY:company_1',
      })
    )

    expect(tables.documents.map((row) => row._id)).toEqual([
      'document_held',
      'document_rival',
      'document_delivered',
    ])
    // La capability deja su propia fila de consumo; la del borrado se suma.
    expect(tables.adminAuditLogs.map((row) => row.action)).toEqual([
      'VDR_ADMIN_CAPABILITY_CONSUME',
      'DOCUMENT_PURGE',
    ])
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        adminEmail: 'admin@example.com',
        action: 'DOCUMENT_PURGE',
        targetType: 'DOCUMENT',
        targetId: 'document_own',
        previousValue: {
          documents: [
            { id: 'document_own', name: 'Estados financieros.pdf', lifecycleStatus: 'ACTIVE' },
          ],
        },
        newValue: {
          totals: { documents: 1, versions: 1, grants: 1, textRows: 1, blobs: 2 },
        },
      })
    )
  })

  // La purga física NO se relajó con el archivado ([F] 2026-09-17): quitar de
  // la sala conserva bytes y auditoría, borrar los destruye. El dueño archiva
  // su entrega cuando quiere; borrarla sigue siendo del equipo.
  it('no deja borrar una entrega ya aprobada del equipo', async () => {
    const tables = purgeTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables, OWNER_IDENTITY)

    await expect(
      runHandler(purge, ctx, { documentIds: ['document_own', 'document_delivered'] })
    ).rejects.toThrow(/entrega del equipo/i)

    expect(tables.documents).toHaveLength(4)
    expect(tables.documentVersions).toHaveLength(1)
    expect(deletedBlobs).toEqual([])
    expect(tables.activityLogs).toHaveLength(0)
  })

  it('rechaza un lote vacío y uno con ids repetidos', async () => {
    const tables = purgeTables()
    const { ctx } = ctxWithStorage(tables, OWNER_IDENTITY)

    await expect(runHandler(purge, ctx, { documentIds: [] })).rejects.toThrow(/al menos un/i)
    await expect(
      runHandler(purge, ctx, { documentIds: ['document_own', 'document_own'] })
    ).rejects.toThrow(/duplicados/i)
    expect(tables.documents).toHaveLength(4)
  })
})
