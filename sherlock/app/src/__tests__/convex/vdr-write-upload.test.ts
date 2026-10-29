import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  issueUploadIntentFromServer,
  registerUploadFromServer,
  VDR_READ_MAX_BYTES,
} from '../../../convex/vdrRead'
import {
  finalizeMcpUploadFromServer,
  prepareMcpUploadFromServer,
  rejectMcpUploadFromServer,
} from '../../../convex/_vdrWrite/upload'
import { createVdrReadServerProof } from '@/lib/vdr-mcp/server-proof'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const SECRET = 'x'.repeat(48)
const AUDIENCE = 'sherlock-dev/vdr-read'
const OWNER_SUBJECT = 'workos_owner'
const OTHER_OWNER_SUBJECT = 'workos_other_owner'
const ADMIN_SUBJECT = 'workos_admin'

function membership(overrides: Partial<Row> = {}): Row {
  return {
    _id: 'membership_owner',
    _creationTime: 100,
    userId: 'user_owner',
    profileId: 'profile_owner',
    authProvider: 'workos',
    providerOrgId: 'org_andina',
    workosOrgId: 'org_andina',
    betaRole: 'COMPANY_OWNER',
    profileRole: 'COMPANY',
    status: 'ACTIVE',
    createdAt: 100,
    ...overrides,
  }
}

function baseTables(): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: OWNER_SUBJECT,
        workosUserId: OWNER_SUBJECT,
        email: 'fixture-b961e41e@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_other_owner',
        _creationTime: 2,
        authProvider: 'workos',
        providerUserId: OTHER_OWNER_SUBJECT,
        workosUserId: OTHER_OWNER_SUBJECT,
        email: 'fixture-177e40cf@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_admin',
        _creationTime: 3,
        authProvider: 'workos',
        providerUserId: ADMIN_SUBJECT,
        workosUserId: ADMIN_SUBJECT,
        email: 'fixture-e47435ef@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [
      {
        _id: 'profile_owner',
        _creationTime: 1,
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_other_owner',
        _creationTime: 2,
        userId: 'user_other_owner',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_admin',
        _creationTime: 3,
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
    ],
    organizationMemberships: [
      membership(),
      membership({
        _id: 'membership_other_owner',
        userId: 'user_other_owner',
        profileId: 'profile_other_owner',
        providerOrgId: 'org_rival',
        workosOrgId: 'org_rival',
      }),
      membership({
        _id: 'membership_admin',
        userId: 'user_admin',
        profileId: 'profile_admin',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'ADMIN',
        providerOrgId: 'org_sherlock',
        workosOrgId: 'org_sherlock',
      }),
    ],
    companyAuthorizationControls: [],
    companyOrganizationBindings: [
      {
        _id: 'binding_andina',
        companyId: 'company_andina',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_andina',
        createdAt: 200,
        createdByProfileId: 'profile_owner',
      },
      {
        _id: 'binding_rival',
        companyId: 'company_rival',
        ownerProfileId: 'profile_other_owner',
        authProvider: 'workos',
        providerOrgId: 'org_rival',
        createdAt: 201,
        createdByProfileId: 'profile_other_owner',
      },
    ],
    workosDirectories: [],
    workosDirectoryUsers: [],
    companies: [
      {
        _id: 'company_andina',
        ownerId: 'profile_owner',
        name: 'Andina Solar, S. A.',
        country: 'PA',
      },
      {
        _id: 'company_rival',
        ownerId: 'profile_other_owner',
        name: 'Rival Energy, S. A.',
        country: 'PA',
      },
    ],
    documents: [],
    documentVersions: [],
    documentAccessLogs: [],
    activityLogs: [],
    vdrUploadIntents: [],
    rateLimits: [],
    _storage: [],
  }
}

function issueArgs(
  principalId: string,
  overrides: {
    salaId?: string
    carpeta?: string
    nombre?: string
    mime?: string
    tamanoBytes?: number
    nota?: string
  } = {}
) {
  const carpeta = overrides.carpeta ?? 'room_legal'
  const nombre = overrides.nombre ?? 'acta.pdf'
  const mime = overrides.mime ?? 'application/pdf'
  const tamanoBytes = overrides.tamanoBytes ?? 1024
  const nota = overrides.nota
  return {
    principalId,
    salaId: overrides.salaId,
    carpeta,
    nombre,
    mime,
    tamanoBytes,
    nota,
    ...createVdrReadServerProof({
      operation: 'ISSUE_UPLOAD_INTENT',
      bindingParts: [
        principalId,
        overrides.salaId ?? '',
        carpeta,
        nombre,
        mime,
        String(tamanoBytes),
        nota ?? '',
      ],
    }),
  }
}

function withStorage(tables = baseTables()) {
  const ctx = Object.assign(createConvexCtx(tables), {
    storage: {
      generateUploadUrl: vi.fn().mockResolvedValue('https://storage.example/upload-once'),
      get: vi.fn(),
    },
  })
  return { ctx, tables }
}

beforeEach(() => {
  vi.stubEnv('VDR_MCP_SERVER_SECRET', SECRET)
  vi.stubEnv('VDR_MCP_SERVER_AUDIENCE', AUDIENCE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('issueUploadIntentFromServer', () => {
  it('emite URL e intent para el dueño COMPANY de su sala', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { ctx, tables } = withStorage()

    const result = await runHandler<
      ReturnType<typeof issueArgs>,
      { intentId: string; uploadUrl: string; expiresAt: number }
    >(issueUploadIntentFromServer, ctx, issueArgs(OWNER_SUBJECT, { nota: 'subida MCP' }))

    expect(result).toEqual({
      intentId: expect.any(String),
      uploadUrl: 'https://storage.example/upload-once',
      expiresAt: 1_600_000,
    })
    expect(tables.vdrUploadIntents).toContainEqual(
      expect.objectContaining({
        _id: result.intentId,
        companyId: 'company_andina',
        requestedByProfileId: 'profile_owner',
        status: 'ACTIVE',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 1024,
        folder: 'room_legal',
        description: 'subida MCP',
        accessLevel: 'NDA_REQUIRED',
      })
    )
  })

  it('niega a un dueño ajeno con NOT_FOUND uniforme', async () => {
    const { ctx } = withStorage()
    const result = await runHandler(issueUploadIntentFromServer, ctx, {
      ...issueArgs(OWNER_SUBJECT, { salaId: 'company_rival' }),
    })
    expect(result).toEqual({ code: 'NOT_FOUND' })
  })

  it('niega a un ADMIN: esta superficie es del dueño COMPANY', async () => {
    const { ctx } = withStorage()
    const result = await runHandler(
      issueUploadIntentFromServer,
      ctx,
      issueArgs(ADMIN_SUBJECT, { salaId: 'company_andina' })
    )
    expect(result).toEqual({ code: 'NOT_FOUND' })
  })

  it('rechaza un mime fuera de la allowlist', async () => {
    const { ctx } = withStorage()
    const result = await runHandler(
      issueUploadIntentFromServer,
      ctx,
      issueArgs(OWNER_SUBJECT, { mime: 'image/png' })
    )
    expect(result).toEqual({ registered: false, code: 'INVALID_FILE_TYPE' })
  })

  it('rechaza un CSV por encima de 20 MB', async () => {
    const { ctx } = withStorage()
    const result = await runHandler(
      issueUploadIntentFromServer,
      ctx,
      issueArgs(OWNER_SUBJECT, {
        mime: 'text/csv',
        tamanoBytes: 21 * 1024 * 1024,
        nombre: 'tape.csv',
      })
    )
    expect(result).toEqual({ registered: false, code: 'FILE_TOO_LARGE' })
  })

  it('rechaza un PDF que la lectura del MCP no puede devolver', async () => {
    const { ctx } = withStorage()
    const result = await runHandler(
      issueUploadIntentFromServer,
      ctx,
      issueArgs(OWNER_SUBJECT, {
        tamanoBytes: VDR_READ_MAX_BYTES + 1,
      })
    )
    expect(result).toEqual({ registered: false, code: 'FILE_TOO_LARGE' })
  })
})

describe('prepareMcpUploadFromServer', () => {
  it('liga el blob, sustituye la huella y pasa a INSPECTING', async () => {
    const tables = baseTables()
    tables.vdrUploadIntents = [
      {
        _id: 'intent_1',
        companyId: 'company_andina',
        requestedByProfileId: 'profile_owner',
        status: 'ACTIVE',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: '0'.repeat(64),
        name: 'acta.pdf',
        folder: 'room_legal',
        accessLevel: 'NDA_REQUIRED',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    ]
    tables._storage = [
      {
        _id: 'storage_1',
        _creationTime: 1,
        size: 8,
        contentType: 'application/pdf',
        sha256: 'a'.repeat(64),
      },
    ]
    const ctx = createConvexCtx(tables)

    const result = await runHandler(prepareMcpUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_1',
      storageId: 'storage_1',
    })

    expect(result).toMatchObject({
      status: 'READY',
      intentId: 'intent_1',
      storageId: 'storage_1',
      sha256: 'a'.repeat(64),
      folder: 'room_legal',
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'INSPECTING',
      storageId: 'storage_1',
      declaredSha256: 'a'.repeat(64),
    })
  })

  it('rechaza un blob que coincide con el intent pero supera el techo de lectura', async () => {
    const tables = baseTables()
    const bytes = VDR_READ_MAX_BYTES + 1
    tables.vdrUploadIntents = [
      {
        _id: 'intent_grande',
        companyId: 'company_andina',
        requestedByProfileId: 'profile_owner',
        status: 'ACTIVE',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: bytes,
        declaredSha256: '0'.repeat(64),
        name: 'acta.pdf',
        folder: 'room_legal',
        accessLevel: 'NDA_REQUIRED',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    ]
    tables._storage = [
      {
        _id: 'storage_grande',
        _creationTime: 1,
        size: bytes,
        contentType: 'application/pdf',
        sha256: 'c'.repeat(64),
      },
    ]
    const ctx = createConvexCtx(tables)

    const result = await runHandler(prepareMcpUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_grande',
      storageId: 'storage_grande',
    })

    expect(result).toEqual({ status: 'REJECTED', registered: false, code: 'FILE_TOO_LARGE' })
  })

  it('un storageId de otra sala no se distingue de NOT_FOUND', async () => {
    const tables = baseTables()
    tables.vdrUploadIntents = [
      {
        _id: 'intent_rival',
        companyId: 'company_rival',
        requestedByProfileId: 'profile_other_owner',
        status: 'ACTIVE',
        fileName: 'secreto.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: 'b'.repeat(64),
        name: 'secreto.pdf',
        folder: 'room_legal',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    ]
    const ctx = createConvexCtx(tables)
    const result = await runHandler(prepareMcpUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_rival',
      storageId: 'storage_1',
    })
    expect(result).toEqual({ code: 'NOT_FOUND' })
  })
})

describe('rejectMcpUploadFromServer', () => {
  it('marca el intent REJECTED con el motivo de inspección', async () => {
    const tables = baseTables()
    tables.vdrUploadIntents = [
      {
        _id: 'intent_1',
        companyId: 'company_andina',
        requestedByProfileId: 'profile_owner',
        status: 'INSPECTING',
        storageId: 'storage_1',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: 'a'.repeat(64),
        name: 'acta.pdf',
        folder: 'room_legal',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    ]
    const ctx = createConvexCtx(tables)
    const result = await runHandler(rejectMcpUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_1',
      storageId: 'storage_1',
      reason: 'INVALID_FILE_SIGNATURE',
    })
    expect(result).toEqual({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INVALID_FILE_SIGNATURE',
    })
  })
})

describe('finalizeMcpUploadFromServer', () => {
  it('publica el documento, audita upload_mcp y avisa al equipo', async () => {
    const tables = baseTables()
    tables.vdrUploadIntents = [
      {
        _id: 'intent_1',
        companyId: 'company_andina',
        requestedByProfileId: 'profile_owner',
        status: 'INSPECTING',
        storageId: 'storage_1',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: 'a'.repeat(64),
        name: 'acta.pdf',
        description: 'nota MCP',
        folder: 'room_legal',
        accessLevel: 'NDA_REQUIRED',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        preparedAt: Date.now(),
      },
    ]
    tables._storage = [
      {
        _id: 'storage_1',
        size: 8,
        contentType: 'application/pdf',
        sha256: 'a'.repeat(64),
      },
    ]
    const ctx = createConvexCtx(tables)

    const result = await runHandler(finalizeMcpUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_1',
      storageId: 'storage_1',
      inspectedSize: 8,
      inspectedSha256: 'a'.repeat(64),
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
    })

    expect(result).toMatchObject({
      nombre: 'acta.pdf',
      carpeta: 'room_legal',
      versionNumero: 1,
    })
    expect(tables.documents).toContainEqual(
      expect.objectContaining({
        name: 'acta.pdf',
        folder: 'room_legal',
        description: 'nota MCP',
        sourceType: 'USER_UPLOAD',
        companyId: 'company_andina',
      })
    )
    expect(tables.documentAccessLogs).toContainEqual(
      expect.objectContaining({
        action: 'upload_mcp',
        accessedById: 'profile_owner',
        decision: 'ALLOW',
      })
    )
    expect(ctx.scheduler.runAfter).toHaveBeenCalled()
  })
})

describe('registerUploadFromServer', () => {
  it('inspecciona un PDF y finaliza con los bytes reales', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'READY',
        intentId: 'intent_1',
        requestedByProfileId: 'profile_owner',
        companyId: 'company_andina',
        storageId: 'storage_1',
        fileName: 'acta.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: 'a'.repeat(64),
        name: 'acta.pdf',
        folder: 'room_legal',
        size: 8,
        contentType: 'application/pdf',
        sha256: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        documentId: 'document_1',
        versionId: 'version_1',
        versionNumero: 1,
        nombre: 'acta.pdf',
        carpeta: 'room_legal',
      })
    const ctx = {
      runMutation,
      storage: {
        get: vi
          .fn()
          .mockResolvedValue(
            new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])])
          ),
      },
    }

    const result = await runHandler(registerUploadFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      intentId: 'intent_1',
      storageId: 'storage_1',
      ...createVdrReadServerProof({
        operation: 'REGISTER_UPLOAD',
        bindingParts: [OWNER_SUBJECT, 'intent_1', 'storage_1'],
      }),
    })

    expect(result).toEqual({
      documentId: 'document_1',
      versionId: 'version_1',
      versionNumero: 1,
      nombre: 'acta.pdf',
      carpeta: 'room_legal',
    })
    expect(runMutation).toHaveBeenCalledTimes(2)
  })
})
