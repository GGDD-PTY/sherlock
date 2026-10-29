// ============================================================================
// PARIDAD DE AUDITORÍA DEL MOVIMIENTO DE CARPETA
// ============================================================================
// Mover UN documento (drag & drop del árbol del VDR → `documents.update` con
// `folder`) y mover CINCUENTA (`documents.bulkUpdate` con `MOVE_FOLDER`) son el
// mismo hecho de negocio. Antes, solo el lote dejaba `VDR_DOCUMENT_FOLDER_CHANGED`
// en `activityLogs`: el movimiento individual del dueño de la empresa no dejaba
// rastro en la vista de actividad de la sala. Estas pruebas fijan el contrato de
// que ambos caminos escriben la MISMA evidencia con la MISMA forma de payload.
// ============================================================================

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { bulkUpdate } from '../../../convex/_documents/bulk'
import { update } from '../../../convex/_documents/mutations'
import { VDR_SHELL_FOLDER_VALUES as SERVER_VDR_SHELL_FOLDER_VALUES } from '../../../convex/_documents/shared'
import { VDR_SHELL_FOLDER_VALUES } from '../../lib/vdr/document-taxonomy'
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

function moveTables(): Tables {
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
        _id: 'document_bulk',
        companyId: 'company_1',
        name: 'Model',
        lifecycleStatus: 'ACTIVE',
        folder: 'model',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
      },
      {
        _id: 'document_single',
        companyId: 'company_1',
        name: 'Financials',
        lifecycleStatus: 'ACTIVE',
        folder: 'model',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
      },
      {
        _id: 'document_library',
        companyId: 'company_1',
        name: 'Corporate library',
        lifecycleStatus: 'ACTIVE',
        folder: 'legal',
        accessLevel: 'PRIVATE',
        classification: 'LEGAL',
      },
      {
        _id: 'document_unfoldered',
        companyId: 'company_1',
        name: 'Loose file',
        lifecycleStatus: 'ACTIVE',
        accessLevel: 'PRIVATE',
        classification: 'LEGAL',
      },
    ],
    documentVersions: [],
    documentAccessGrants: [],
    documentLegalHolds: [],
    activityLogs: [],
    adminAuditLogs: [],
    adminVdrCapabilities: [],
    rateLimits: [],
  }
}

function folderChangeLogs(tables: Tables) {
  return tables.activityLogs.filter((row) => row.action === 'VDR_DOCUMENT_FOLDER_CHANGED')
}

describe('documents.update — evidencia del movimiento individual de carpeta', () => {
  it('records VDR_DOCUMENT_FOLDER_CHANGED when a company owner moves one document', async () => {
    const tables = moveTables()

    await runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      documentId: 'document_single',
      folder: 'room_legal',
    })

    expect(tables.documents[1]).toMatchObject({ _id: 'document_single', folder: 'room_legal' })
    expect(folderChangeLogs(tables)).toEqual([
      expect.objectContaining({
        userId: 'profile_issuer',
        action: 'VDR_DOCUMENT_FOLDER_CHANGED',
        entityType: 'DOCUMENT',
        entityId: 'document_single',
        metadata: {
          resourceType: 'COMPANY',
          resourceId: 'company_1',
          operation: 'MOVE_FOLDER',
          previousValue: { folder: 'model' },
          newValue: { folder: 'room_legal' },
        },
      }),
    ])
  })

  it('writes a payload identical to the bulk path for the same move', async () => {
    const tables = moveTables()
    const bulkInput = {
      companyId: 'company_1',
      documentIds: ['document_bulk'],
      operation: { type: 'MOVE_FOLDER' as const, folder: ' room_legal ' },
    }

    await runHandler(bulkUpdate, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), bulkInput)
    await runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      documentId: 'document_single',
      folder: ' room_legal ',
    })

    const [fromBulk, fromSingle] = folderChangeLogs(tables)
    expect(fromBulk).toBeDefined()
    expect(fromSingle).toBeDefined()
    // Mismo hecho, misma forma: solo cambia a QUÉ documento apunta la fila.
    expect(fromSingle.metadata).toEqual(fromBulk.metadata)
    expect(fromSingle.userId).toEqual(fromBulk.userId)
    expect(fromSingle.entityType).toEqual(fromBulk.entityType)
    expect(fromBulk.entityId).toBe('document_bulk')
    expect(fromSingle.entityId).toBe('document_single')
  })

  it('falls back to the General bucket as the previous value when the document had no folder', async () => {
    const tables = moveTables()

    await runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      documentId: 'document_unfoldered',
      folder: 'room_legal',
    })

    expect(folderChangeLogs(tables)).toEqual([
      expect.objectContaining({
        entityId: 'document_unfoldered',
        metadata: expect.objectContaining({
          resourceType: 'COMPANY',
          resourceId: 'company_1',
          previousValue: { folder: 'General' },
          newValue: { folder: 'room_legal' },
        }),
      }),
    ])
  })

  it('does not record a folder change when the update never touches the folder', async () => {
    const tables = moveTables()

    await runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      documentId: 'document_single',
      name: 'Financials v2',
    })

    expect(tables.documents[1]).toMatchObject({ name: 'Financials v2', folder: 'model' })
    expect(folderChangeLogs(tables)).toHaveLength(0)
  })

  it('does not record a folder change when the submitted folder equals the current one', async () => {
    const tables = moveTables()
    tables.documents[1].folder = 'room_financial'

    // El diálogo de edición manda SIEMPRE la carpeta junto al resto de la
    // metadata: reenviar el mismo valor no es un movimiento y no puede ensuciar
    // la vista de actividad de la sala.
    await runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      documentId: 'document_single',
      name: 'Financials v2',
      folder: 'room_financial',
    })

    expect(folderChangeLogs(tables)).toHaveLength(0)
  })

  it('records the room activity once for an ADMIN move without duplicating the admin audit', async () => {
    const tables = moveTables()
    const input = { documentId: 'document_library', folder: 'room_legal' }

    await runHandler(
      update,
      createConvexCtx(tables, { identity: ADMIN_IDENTITY }),
      await mintAdminVdrCapability({
        tables,
        input,
        companyId: 'company_1',
        action: 'DOCUMENT_UPDATE',
        target: 'DOCUMENT:document_library',
      })
    )

    expect(folderChangeLogs(tables)).toEqual([
      expect.objectContaining({
        userId: 'profile_admin',
        entityId: 'document_library',
        metadata: expect.objectContaining({
          operation: 'MOVE_FOLDER',
          previousValue: { folder: 'legal' },
          newValue: { folder: 'room_legal' },
        }),
      }),
    ])
    // La mutation ya escribía su propio DOCUMENT_METADATA_UPDATE; la evidencia
    // de sala se suma, no se duplica el rastro administrativo.
    expect(
      tables.adminAuditLogs.filter((row) => row.action === 'DOCUMENT_METADATA_UPDATE')
    ).toHaveLength(1)
  })

  it('rejects an empty destination on the individual update path', async () => {
    const tables = moveTables()

    await expect(
      runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        documentId: 'document_single',
        folder: '   ',
      })
    ).rejects.toThrow(/carpeta debe tener entre 1 y 120 caracteres/i)

    expect(tables.documents[1]).toMatchObject({ folder: 'model' })
    expect(folderChangeLogs(tables)).toHaveLength(0)
  })

  it('rejects an empty destination on the bulk update path', async () => {
    const tables = moveTables()

    await expect(
      runHandler(bulkUpdate, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        companyId: 'company_1',
        documentIds: ['document_bulk'],
        operation: { type: 'MOVE_FOLDER', folder: '   ' },
      })
    ).rejects.toThrow(/carpeta debe tener entre 1 y 120 caracteres/i)

    expect(tables.documents[0]).toMatchObject({ folder: 'model' })
    expect(folderChangeLogs(tables)).toHaveLength(0)
  })

  it('rejects a legacy alias as an individual destination while preserving legacy reads', async () => {
    const tables = moveTables()

    await expect(
      runHandler(update, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        documentId: 'document_single',
        folder: 'legal',
      })
    ).rejects.toThrow(/destino válido de la sala/i)

    expect(tables.documents[1]).toMatchObject({ folder: 'model' })
  })

  it('rejects a legacy alias as a bulk destination', async () => {
    const tables = moveTables()

    await expect(
      runHandler(bulkUpdate, createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
        companyId: 'company_1',
        documentIds: ['document_bulk'],
        operation: { type: 'MOVE_FOLDER', folder: 'legal' },
      })
    ).rejects.toThrow(/destino válido de la sala/i)

    expect(tables.documents[0]).toMatchObject({ folder: 'model' })
  })

  it('keeps the server destinations in parity with the VDR shell taxonomy', () => {
    expect(SERVER_VDR_SHELL_FOLDER_VALUES).toEqual(VDR_SHELL_FOLDER_VALUES)
  })

  // Tercera copia de la lista: `scripts/operator/vdr-push.mjs` valida la carpeta
  // en la Mac del operador y un `.mjs` no puede importar el módulo TypeScript.
  // Sin este pin, una sexta carpeta dejaría al CLI rechazando una llave que la
  // sala sí acepta, y nada se pondría rojo.
  it('keeps the operator CLI folder list in parity with the VDR shell taxonomy', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'operator', 'vdr-push.mjs'),
      'utf8'
    )
    const block = /const ROOM_FOLDERS = \[([\s\S]*?)\]/.exec(source)
    expect(block).not.toBeNull()
    const cliFolders = [...block![1].matchAll(/'([^']+)'/g)].map((match) => match[1])

    expect(cliFolders).toEqual(VDR_SHELL_FOLDER_VALUES)
  })
})
