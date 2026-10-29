import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveDownloadAccess } from '../../../convex/_documents/shared'
import { listExportableDocuments, recordRoomExport } from '../../../convex/vdrExport'
import { getVdrShellFolderValue } from '@/lib/vdr/document-taxonomy'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

vi.mock('../../../convex/_documents/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../convex/_documents/shared')>()
  return {
    ...actual,
    resolveDownloadAccess: vi.fn(actual.resolveDownloadAccess),
  }
})

const NOW = 1_900_000_000_000
const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}
const OTHER_IDENTITY = {
  subject: 'workos_other',
  issuer: 'https://api.workos.com/',
  email: 'other@example.com',
}
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function document(overrides: Partial<Row> = {}): Row {
  return {
    _id: 'document_legal',
    _creationTime: 1_000,
    companyId: 'company_1',
    name: 'Estatutos.pdf',
    folder: 'room_legal',
    fileType: 'application/pdf',
    lifecycleStatus: 'ACTIVE',
    accessLevel: 'PRIVATE',
    classification: 'CONFIDENTIAL',
    storageId: 'storage_legal',
    currentVersionId: 'version_legal',
    publishedVersionId: 'version_legal',
    currentVersionNumber: 1,
    ...overrides,
  }
}

function version(overrides: Partial<Row> = {}): Row {
  return {
    _id: 'version_legal',
    _creationTime: 1_001,
    documentId: 'document_legal',
    companyId: 'company_1',
    versionNumber: 1,
    storageId: 'storage_legal',
    displayName: 'Estatutos.pdf',
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    byteSize: 1_024,
    sha256: 'a'.repeat(64),
    signatureKind: 'PDF',
    verificationStatus: 'SIGNATURE_VERIFIED',
    malwareScanStatus: 'CLEAN',
    publicationStatus: 'PUBLISHED',
    createdAt: NOW - 10_000,
    createdByProfileId: 'profile_owner',
    publishedAt: NOW - 9_000,
    ...overrides,
  }
}

function baseTables(): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_other',
        authProvider: 'workos',
        providerUserId: 'workos_other',
        workosUserId: 'workos_other',
        email: 'other@example.com',
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
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_other', userId: 'user_other', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    companies: [
      { _id: 'company_1', ownerId: 'profile_owner', name: 'SAMPLE_ENERGY' },
      { _id: 'company_2', ownerId: 'profile_other', name: 'Otra' },
    ],
    documents: [
      document(),
      document({
        _id: 'document_financial',
        _creationTime: 1_100,
        name: 'Modelo.xlsx',
        folder: 'room_financial',
        storageId: 'storage_financial',
        currentVersionId: 'version_financial',
        publishedVersionId: 'version_financial',
      }),
      document({
        _id: 'document_legacy_model',
        _creationTime: 1_150,
        name: 'Modelo Financiero.xlsx',
        // Carpeta legada, no un valor del shell: el export tiene que traducirla
        // con la misma tabla que usa la sala, no con una copia propia.
        folder: 'Modelo Financiero',
        storageId: 'storage_legacy_model',
        currentVersionId: 'version_legacy_model',
        publishedVersionId: 'version_legacy_model',
      }),
      // Cuatro exclusiones, UNA razon cada una: si un caso acumulara motivos, el
      // test seguiria verde aunque el handler dejara de mirar el que dice medir.
      document({
        _id: 'document_quarantined',
        _creationTime: 1_200,
        name: 'Cuarentena.pdf',
        folder: 'room_legal',
        lifecycleStatus: 'QUARANTINED',
        storageId: 'storage_quarantined',
        currentVersionId: 'version_quarantined',
        publishedVersionId: 'version_quarantined',
      }),
      document({
        _id: 'document_infected',
        _creationTime: 1_300,
        name: 'Infectado.pdf',
        folder: 'room_legal',
        storageId: 'storage_infected',
        currentVersionId: 'version_infected',
        publishedVersionId: 'version_infected',
      }),
      document({
        _id: 'document_stale',
        _creationTime: 1_400,
        name: 'Borrador.pdf',
        folder: 'room_legal',
        storageId: 'storage_stale',
        currentVersionId: 'version_stale_current',
        publishedVersionId: 'version_stale_published',
      }),
      document({
        _id: 'document_expired',
        _creationTime: 1_500,
        name: 'Vencido.pdf',
        folder: 'room_legal',
        isExpired: true,
        storageId: 'storage_expired',
        currentVersionId: 'version_expired',
        publishedVersionId: 'version_expired',
      }),
      document({
        _id: 'document_other',
        _creationTime: 1_600,
        companyId: 'company_2',
        name: 'Ajeno.pdf',
        folder: 'room_legal',
        storageId: 'storage_other',
        currentVersionId: 'version_other',
        publishedVersionId: 'version_other',
      }),
    ],
    documentVersions: [
      version(),
      version({
        _id: 'version_financial',
        documentId: 'document_financial',
        storageId: 'storage_financial',
        displayName: 'Modelo.xlsx',
        byteSize: 2_048,
      }),
      version({
        _id: 'version_legacy_model',
        documentId: 'document_legacy_model',
        storageId: 'storage_legacy_model',
        displayName: 'Modelo Financiero.xlsx',
        byteSize: 4_096,
      }),
      version({
        _id: 'version_quarantined',
        documentId: 'document_quarantined',
        storageId: 'storage_quarantined',
        displayName: 'Cuarentena.pdf',
      }),
      version({
        _id: 'version_infected',
        documentId: 'document_infected',
        storageId: 'storage_infected',
        displayName: 'Infectado.pdf',
        malwareScanStatus: 'INFECTED',
      }),
      version({
        _id: 'version_stale_current',
        documentId: 'document_stale',
        storageId: 'storage_stale',
        displayName: 'Borrador.pdf',
        versionNumber: 2,
      }),
      version({
        _id: 'version_stale_published',
        documentId: 'document_stale',
        storageId: 'storage_stale',
        displayName: 'Borrador.pdf',
      }),
      version({
        _id: 'version_expired',
        documentId: 'document_expired',
        storageId: 'storage_expired',
        displayName: 'Vencido.pdf',
      }),
      version({
        _id: 'version_other',
        documentId: 'document_other',
        companyId: 'company_2',
        storageId: 'storage_other',
        displayName: 'Ajeno.pdf',
      }),
    ],
    rateLimits: [],
    documentAccessLogs: [],
  }
}

function withStorage(tables: Tables, identity: typeof OWNER_IDENTITY | null) {
  const ctx = createConvexCtx(tables, { identity })
  Object.assign(ctx, {
    storage: {
      getUrl: vi.fn(async (storageId: string) => `https://files.test/${storageId}`),
    },
  })
  return ctx
}

describe('vdrExport.listExportableDocuments', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects an anonymous caller before listing the room', async () => {
    const ctx = withStorage(baseTables(), null)
    await expect(
      runHandler(listExportableDocuments, ctx, { companyId: 'company_1' })
    ).rejects.toMatchObject({
      data: { code: 'AUTH_NOT_AUTHENTICATED' },
    })
  })

  it('rejects a COMPANY owner of another room', async () => {
    const ctx = withStorage(baseTables(), OTHER_IDENTITY)
    await expect(
      runHandler(listExportableDocuments, ctx, { companyId: 'company_1' })
    ).rejects.toMatchObject({
      data: { code: 'AUTHZ_UNAUTHORIZED' },
    })
  })

  it('returns the published version of every ACTIVE document', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      {
        companyId: string
        companyName: string
        documents: Array<{
          documentId: string
          name: string
          folder: string
          byteSize: number
          storageUrl: string
        }>
      }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(result.companyName).toBe('SAMPLE_ENERGY')
    expect(result.documents.map((row) => row.documentId).sort()).toEqual([
      'document_financial',
      'document_legacy_model',
      'document_legal',
    ])
    expect(result.documents.find((row) => row.documentId === 'document_legal')).toMatchObject({
      name: 'Estatutos.pdf',
      folder: 'room_legal',
      byteSize: 1_024,
      storageUrl: 'https://files.test/storage_legal',
    })
  })

  it('excludes a QUARANTINED document whose version is otherwise deliverable', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(JSON.stringify(result)).not.toContain('document_quarantined')
    expect(JSON.stringify(result)).not.toContain('storage_quarantined')
  })

  it('excludes an ACTIVE document whose published version is INFECTED', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(JSON.stringify(result)).not.toContain('document_infected')
    expect(JSON.stringify(result)).not.toContain('storage_infected')
  })

  it('excludes a document whose current version is not the published one', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(JSON.stringify(result)).not.toContain('document_stale')
    expect(JSON.stringify(result)).not.toContain('storage_stale')
  })

  it('excludes an ACTIVE document that is already expired', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(JSON.stringify(result)).not.toContain('document_expired')
    expect(JSON.stringify(result)).not.toContain('storage_expired')
    expect(JSON.stringify(result)).not.toContain('document_other')
    expect(JSON.stringify(result)).not.toContain('storage_other')
  })

  it('lets an admin list another company room', async () => {
    const ctx = withStorage(baseTables(), ADMIN_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })
    expect(result.documents).toHaveLength(3)
  })

  it('filters by a shell folder when requested', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string; folder?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1', folder: 'room_financial' })
    expect(result.documents.map((row) => row.documentId).sort()).toEqual([
      'document_financial',
      'document_legacy_model',
    ])
  })

  it('lists every published document of the room, past the old 500 cap', async () => {
    const tables = baseTables()
    const extra = 520
    for (let index = 0; index < extra; index += 1) {
      tables.documents?.push(
        document({
          _id: `document_bulk_${index}`,
          _creationTime: 2_000 + index,
          name: `Anexo ${index}.pdf`,
          storageId: `storage_bulk_${index}`,
          currentVersionId: `version_bulk_${index}`,
          publishedVersionId: `version_bulk_${index}`,
        })
      )
      tables.documentVersions?.push(
        version({
          _id: `version_bulk_${index}`,
          documentId: `document_bulk_${index}`,
          storageId: `storage_bulk_${index}`,
          displayName: `Anexo ${index}.pdf`,
        })
      )
    }

    const ctx = withStorage(tables, OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    // 3 documentos entregables del fixture base + los 520 anexos: ninguno se
    // cae en silencio por un `.take()`.
    expect(result.documents).toHaveLength(3 + extra)
  })

  it('routes a legacy folder alias to the shell folder the room shows', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    const result = await runHandler<
      { companyId?: string },
      { documents: Array<{ documentId: string; folder: string }> }
    >(listExportableDocuments, ctx, { companyId: 'company_1' })

    expect(result.documents.find((row) => row.documentId === 'document_legacy_model')?.folder).toBe(
      getVdrShellFolderValue('Modelo Financiero')
    )
  })
})

describe('vdrExport.recordRoomExport', () => {
  beforeEach(() => {
    vi.mocked(resolveDownloadAccess).mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a DOWNLOAD access log per published document', async () => {
    const tables = baseTables()
    const ctx = withStorage(tables, OWNER_IDENTITY)
    const result = await runHandler<
      { companyId: string; documentIds: string[]; exportId: string },
      { logged: number }
    >(recordRoomExport, ctx, {
      companyId: 'company_1',
      exportId: 'export-abc123',
      documentIds: [
        'document_legal',
        'document_financial',
        'document_quarantined',
        'document_infected',
        'document_stale',
      ],
    })

    expect(result.logged).toBe(2)
    const logs = tables.documentAccessLogs ?? []
    expect(logs).toHaveLength(2)
    expect(logs.every((row) => row.action === 'DOWNLOAD')).toBe(true)
    expect(logs.map((row) => row.documentId).sort()).toEqual([
      'document_financial',
      'document_legal',
    ])
  })

  it('marks every row as a zip export with its exportId, folder and count', async () => {
    const tables = baseTables()
    const ctx = withStorage(tables, OWNER_IDENTITY)
    await runHandler<
      { companyId: string; documentIds: string[]; exportId: string; folder?: string },
      { logged: number }
    >(recordRoomExport, ctx, {
      companyId: 'company_1',
      exportId: 'export-abc123',
      folder: 'room_legal',
      documentIds: ['document_legal'],
    })

    const logs = tables.documentAccessLogs ?? []
    expect(logs).toHaveLength(1)
    // Sin la marca, una descarga individual y una sala entera son la misma fila.
    expect(logs[0]?.userAgent).toBe(
      'vdr-zip-export exportId=export-abc123 folder=room_legal count=1'
    )
  })

  it('records the whole room as folder=all when no folder was requested', async () => {
    const tables = baseTables()
    const ctx = withStorage(tables, OWNER_IDENTITY)
    await runHandler<
      { companyId: string; documentIds: string[]; exportId: string },
      { logged: number }
    >(recordRoomExport, ctx, {
      companyId: 'company_1',
      exportId: 'export-abc123',
      documentIds: ['document_legal', 'document_financial'],
    })

    const logs = tables.documentAccessLogs ?? []
    expect(logs.map((row) => row.userAgent)).toEqual([
      'vdr-zip-export exportId=export-abc123 folder=all count=2',
      'vdr-zip-export exportId=export-abc123 folder=all count=2',
    ])
  })

  it('rejects an exportId that is not an opaque token', async () => {
    const ctx = withStorage(baseTables(), OWNER_IDENTITY)
    await expect(
      runHandler(recordRoomExport, ctx, {
        companyId: 'company_1',
        exportId: 'export abc/../123',
        documentIds: ['document_legal'],
      })
    ).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } })
  })

  it('does not write an access log for a document that belongs to another room', async () => {
    const tables = baseTables()
    const ctx = withStorage(tables, OWNER_IDENTITY)
    const result = await runHandler<
      { companyId: string; documentIds: string[]; exportId: string },
      { logged: number }
    >(recordRoomExport, ctx, {
      companyId: 'company_1',
      exportId: 'export-abc123',
      documentIds: ['document_legal', 'document_other'],
    })

    expect(result.logged).toBe(1)
    const logs = tables.documentAccessLogs ?? []
    expect(logs).toHaveLength(1)
    expect(logs[0]?.documentId).toBe('document_legal')
    expect(JSON.stringify(logs)).not.toContain('document_other')
    expect(JSON.stringify(logs)).not.toContain('storage_other')
    expect(JSON.stringify(logs)).not.toContain('company_2')
  })

  it('logs DOWNLOAD_DENIED when access is not ALLOW, and still counts the row', async () => {
    vi.mocked(resolveDownloadAccess).mockResolvedValueOnce({
      decision: 'DENY',
      outcome: 'DENIED_PRIVATE_OWNER_ONLY',
      reason: 'Este documento es privado y solo el owner o admin puede acceder.',
      classification: 'CONFIDENTIAL',
      riskScore: 80,
      stepUpRequirement: 'NONE',
    })

    const tables = baseTables()
    const ctx = withStorage(tables, OWNER_IDENTITY)
    const result = await runHandler<
      { companyId: string; documentIds: string[]; exportId: string },
      { logged: number }
    >(recordRoomExport, ctx, {
      companyId: 'company_1',
      exportId: 'export-denied-1',
      documentIds: ['document_legal'],
    })

    expect(result.logged).toBe(1)
    const logs = tables.documentAccessLogs ?? []
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      documentId: 'document_legal',
      action: 'DOWNLOAD_DENIED',
      decision: 'DENY',
      outcome: 'DENIED_PRIVATE_OWNER_ONLY',
    })
    expect(logs[0]?.userAgent).toBe('vdr-zip-export exportId=export-denied-1 folder=all count=1')
  })
})
