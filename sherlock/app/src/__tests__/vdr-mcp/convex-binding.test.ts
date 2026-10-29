// ============================================================================
// VDR READ MCP — server-side room binding (Convex entry points)
// ============================================================================
// The MCP token proves a WorkOS subject and nothing else. These tests pin the
// part that decides WHICH room that subject may read, and the uniform
// NOT_FOUND that hides everyone else's ids.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readTextIndexFromServer,
  recordReadAuditFromServer,
  resolveRoomFromServer,
  VDR_READ_RESULT_CAP,
  writeTextIndexFromServer,
} from '../../../convex/vdrRead'
import { createVdrReadServerProof } from '@/lib/vdr-mcp/server-proof'
import { createConvexCtx, runHandler, type Row, type Tables } from '../convex/nda-convex-harness'

const SECRET = 'x'.repeat(48)
const AUDIENCE = 'sherlock-dev/vdr-read'

const OWNER_SUBJECT = 'workos_owner'
const OTHER_OWNER_SUBJECT = 'workos_other_owner'
const ADMIN_SUBJECT = 'workos_admin'
const INVESTOR_SUBJECT = 'workos_investor'

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
      {
        _id: 'user_investor',
        _creationTime: 4,
        authProvider: 'workos',
        providerUserId: INVESTOR_SUBJECT,
        workosUserId: INVESTOR_SUBJECT,
        email: 'fixture-7ec9f04a@example.com',
        role: 'COMPANY',
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
      {
        _id: 'profile_investor',
        _creationTime: 4,
        userId: 'user_investor',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    organizationMemberships: [
      membership(),
      membership({
        _id: 'membership_other_owner',
        _creationTime: 101,
        userId: 'user_other_owner',
        profileId: 'profile_other_owner',
        providerOrgId: 'org_rival',
        workosOrgId: 'org_rival',
      }),
    ],
    companyAuthorizationControls: [],
    companyOrganizationBindings: [
      {
        _id: 'binding_andina',
        _creationTime: 200,
        companyId: 'company_andina',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_andina',
        createdAt: 200,
        createdByProfileId: 'profile_owner',
      },
      {
        _id: 'binding_rival',
        _creationTime: 201,
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
        _creationTime: 300,
        ownerId: 'profile_owner',
        name: 'Andina Solar, S. A.',
        country: 'PA',
      },
      {
        _id: 'company_rival',
        _creationTime: 301,
        ownerId: 'profile_other_owner',
        name: 'Rival Energy, S. A.',
        country: 'PA',
      },
    ],
    documents: [
      {
        _id: 'document_modelo',
        _creationTime: 500,
        companyId: 'company_andina',
        name: 'Modelo financiero v3.xlsx',
        folder: '3. Financieros',
        fileType: 'XLSX',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        lifecycleStatus: 'ACTIVE',
        currentVersionId: 'version_modelo',
        publishedVersionId: 'version_modelo',
      },
      {
        _id: 'document_rival',
        _creationTime: 501,
        companyId: 'company_rival',
        name: 'Modelo del rival.xlsx',
        folder: '3. Financieros',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        lifecycleStatus: 'ACTIVE',
        currentVersionId: 'version_rival',
        publishedVersionId: 'version_rival',
      },
    ],
    documentVersions: [
      {
        _id: 'version_modelo',
        _creationTime: 510,
        documentId: 'document_modelo',
        companyId: 'company_andina',
        versionNumber: 3,
        storageId: 'storage_modelo',
        displayName: 'Modelo financiero v3.xlsx',
        declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        detectedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        byteSize: 6254,
        sha256: 'a'.repeat(64),
        signatureKind: 'ZIP',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        createdAt: 505,
        createdByProfileId: 'profile_owner',
        publishedAt: 506,
      },
      {
        _id: 'version_rival',
        _creationTime: 511,
        documentId: 'document_rival',
        companyId: 'company_rival',
        versionNumber: 1,
        storageId: 'storage_rival',
        displayName: 'Modelo del rival.xlsx',
        declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        detectedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        byteSize: 1024,
        sha256: 'b'.repeat(64),
        signatureKind: 'ZIP',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        createdAt: 507,
        createdByProfileId: 'profile_other_owner',
        publishedAt: 508,
      },
    ],
    vdrReadAudits: [],
    documentTextIndex: [],
  }
}

function roomArgs(principalId: string, salaId?: string) {
  const base = {
    principalId,
    ...(salaId ? { salaId } : {}),
  }
  return {
    ...base,
    ...createVdrReadServerProof({
      operation: 'RESOLVE_BINDING',
      bindingParts: [principalId, salaId ?? ''],
    }),
  }
}

type RoomResult =
  | { code: 'DENIED' | 'NOT_FOUND' }
  | {
      sala: { salaId: string; empresa: string; rol: string }
      documentos: Array<{ documentId: string; versionId: string }>
      truncado: boolean
      telefonoPresente: boolean
      nombreConfirmado: boolean
      entregables: Array<{ etapa: string; estado: string; publicadoEn?: number }>
      conteosPorCarpeta: Record<string, number>
      ultimoMovimiento: { nombre: string; actualizadoEn: number } | null
    }

function authorizedPair(id: string, folder: string, createdAt: number) {
  return {
    document: {
      _id: `document_${id}`,
      _creationTime: createdAt,
      companyId: 'company_andina',
      name: `${id}.pdf`,
      folder,
      fileType: 'PDF',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      lifecycleStatus: 'ACTIVE',
      currentVersionId: `version_${id}`,
      publishedVersionId: `version_${id}`,
      updatedAt: createdAt,
    },
    version: {
      _id: `version_${id}`,
      _creationTime: createdAt,
      documentId: `document_${id}`,
      companyId: 'company_andina',
      versionNumber: 1,
      storageId: `storage_${id}`,
      displayName: `${id}.pdf`,
      declaredMimeType: 'application/pdf',
      detectedMimeType: 'application/pdf',
      byteSize: 100,
      sha256: id.padEnd(64, '0').slice(0, 64),
      signatureKind: 'ZIP',
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'CLEAN',
      publicationStatus: 'PUBLISHED',
      createdAt,
      createdByProfileId: 'profile_owner',
      publishedAt: createdAt,
    },
  }
}

beforeEach(() => {
  vi.stubEnv('VDR_MCP_SERVER_SECRET', SECRET)
  vi.stubEnv('VDR_MCP_SERVER_AUDIENCE', AUDIENCE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveRoomFromServer', () => {
  it('binds a COMPANY owner to its own room and only its own documents', async () => {
    const ctx = createConvexCtx(baseTables())
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      ctx,
      roomArgs(OWNER_SUBJECT)
    )

    expect('sala' in result).toBe(true)
    if (!('sala' in result)) return
    expect(result.sala.salaId).toBe('company_andina')
    expect(result.sala.empresa).toBe('Andina Solar, S. A.')
    expect(result.sala.rol).toBe('COMPANY')
    expect(result.documentos.map((row) => row.documentId)).toEqual(['document_modelo'])
    expect(result).toMatchObject({
      nombreConfirmado: false,
      telefonoPresente: false,
      conteosPorCarpeta: expect.objectContaining({ room_financial: 1 }),
      entregables: expect.arrayContaining([{ etapa: 'TEASER', estado: 'PENDING' }]),
    })
  })

  it('marks phone present and name confirmed from the same sources as the panel', async () => {
    const tables = baseTables()
    tables.profiles[0]!.phone = '+507 6000-1234'
    tables.companyChecklist = [
      {
        _id: 'checklist_andina',
        _creationTime: 310,
        companyId: 'company_andina',
        nameConfirmedAt: 1_700_000_000_000,
        nameConfirmedSource: 'ROOM_RENAME',
        createdAt: 310,
        updatedAt: 310,
      },
    ]
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(tables),
      roomArgs(OWNER_SUBJECT)
    )
    expect(result).toMatchObject({ nombreConfirmado: true, telefonoPresente: true })
  })

  it('projects deliverable stages with the same order as the preparation panel', async () => {
    const tables = baseTables()
    tables.deliverables = [
      {
        _id: 'deliverable_teaser',
        _creationTime: 800,
        companyId: 'company_andina',
        kind: 'TEASER',
        status: 'DELIVERED',
        updatedAt: 1_700_000_100_000,
        deliveredAt: 1_700_000_100_000,
      },
    ]
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(tables),
      roomArgs(OWNER_SUBJECT)
    )
    expect(result).toMatchObject({
      entregables: [
        { etapa: 'MODEL_V1', estado: 'PENDING' },
        { etapa: 'MODEL_V2', estado: 'PENDING' },
        { etapa: 'TEASER', estado: 'DELIVERED', publicadoEn: 1_700_000_100_000 },
        { etapa: 'CIM', estado: 'PENDING' },
        { etapa: 'MGMT_PRESENTATION', estado: 'PENDING' },
        { etapa: 'DECKS', estado: 'PENDING' },
        { etapa: 'QA', estado: 'PENDING' },
        { etapa: 'IRL', estado: 'PENDING' },
      ],
    })
  })

  it('counts every active document even when the inventory page is truncated', async () => {
    const tables = baseTables()
    for (let index = 0; index < VDR_READ_RESULT_CAP; index += 1) {
      const pair = authorizedPair(`legal_${index}`, 'room_legal', 600 + index)
      tables.documents.push(pair.document)
      tables.documentVersions.push(pair.version)
    }
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(tables),
      roomArgs(OWNER_SUBJECT)
    )
    expect(result).toMatchObject({
      truncado: true,
      conteosPorCarpeta: expect.objectContaining({
        room_legal: VDR_READ_RESULT_CAP,
        room_financial: 1,
      }),
      ultimoMovimiento: { nombre: 'legal_199.pdf', actualizadoEn: 799 },
    })
  })

  it('answers NOT_FOUND when a COMPANY owner names another company as sala', async () => {
    const ctx = createConvexCtx(baseTables())
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      ctx,
      roomArgs(OWNER_SUBJECT, 'company_rival')
    )
    expect(result).toEqual({ code: 'NOT_FOUND' })
  })

  it('requires ADMIN to name a room, and honours the one it names', async () => {
    const missing = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(baseTables()),
      roomArgs(ADMIN_SUBJECT)
    )
    expect(missing).toEqual({ code: 'NOT_FOUND' })

    const named = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(baseTables()),
      roomArgs(ADMIN_SUBJECT, 'company_rival')
    )
    expect('sala' in named && named.sala.salaId).toBe('company_rival')
    expect('sala' in named && named.sala.rol).toBe('ADMIN')
  })

  it('denies a deactivated profile', async () => {
    const tables = baseTables()
    tables.profiles[0]!.isActive = false
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(tables),
      roomArgs(OWNER_SUBJECT)
    )
    expect(result).toEqual({ code: 'DENIED' })
  })

  it('denies an unknown WorkOS subject', async () => {
    const result = await runHandler<unknown, RoomResult>(
      resolveRoomFromServer,
      createConvexCtx(baseTables()),
      roomArgs('workos_nobody')
    )
    expect(result).toEqual({ code: 'DENIED' })
  })

  it('rejects a forged server proof', async () => {
    const ctx = createConvexCtx(baseTables())
    await expect(
      runHandler(resolveRoomFromServer, ctx, {
        principalId: OWNER_SUBJECT,
        serverIssuedAt: Date.now(),
        serverProof: 'z'.repeat(43),
      })
    ).rejects.toThrow()
  })

  it('rejects a proof signed for another audience', async () => {
    const ctx = createConvexCtx(baseTables())
    await expect(
      runHandler(resolveRoomFromServer, ctx, {
        principalId: OWNER_SUBJECT,
        ...createVdrReadServerProof({
          operation: 'RESOLVE_BINDING',
          bindingParts: [OWNER_SUBJECT, '', ''],
          audience: 'sherlock-dev/other-surface',
        }),
      })
    ).rejects.toThrow()
  })

  it('rejects a proof whose binding parts do not match the arguments', async () => {
    const ctx = createConvexCtx(baseTables())
    await expect(
      runHandler(resolveRoomFromServer, ctx, {
        principalId: OWNER_SUBJECT,
        salaId: 'company_rival',
        ...createVdrReadServerProof({
          operation: 'RESOLVE_BINDING',
          bindingParts: [OWNER_SUBJECT, 'company_andina', ''],
        }),
      })
    ).rejects.toThrow()
  })
})

describe('documentTextIndex', () => {
  it('refuses to store text under a digest the version does not carry', async () => {
    const ctx = createConvexCtx(baseTables())
    const stored = await runHandler<unknown, { stored: boolean }>(writeTextIndexFromServer, ctx, {
      documentVersionId: 'version_modelo',
      sha256: 'c'.repeat(64),
      extractor: 'PDF',
      pages: [{ n: 1, text: 'texto' }],
      truncated: false,
      ...createVdrReadServerProof({
        operation: 'WRITE_TEXT_INDEX',
        bindingParts: ['version_modelo', 'c'.repeat(64), 'PDF'],
      }),
    })
    expect(stored).toEqual({ stored: false })
    expect(ctx.tables.documentTextIndex).toHaveLength(0)
  })

  it('stores and reads back text pinned to the exact blob digest', async () => {
    const ctx = createConvexCtx(baseTables())
    const sha256 = 'a'.repeat(64)
    await runHandler(writeTextIndexFromServer, ctx, {
      documentVersionId: 'version_modelo',
      sha256,
      extractor: 'PDF',
      pages: [{ n: 1, text: 'Andina Solar' }],
      truncated: false,
      ...createVdrReadServerProof({
        operation: 'WRITE_TEXT_INDEX',
        bindingParts: ['version_modelo', sha256, 'PDF'],
      }),
    })
    expect(ctx.tables.documentTextIndex).toHaveLength(1)

    const hit = await runHandler<unknown, { found: boolean }>(readTextIndexFromServer, ctx, {
      documentVersionId: 'version_modelo',
      sha256,
      ...createVdrReadServerProof({
        operation: 'READ_TEXT_INDEX',
        bindingParts: ['version_modelo', sha256],
      }),
    })
    expect(hit.found).toBe(true)

    const stale = await runHandler<unknown, { found: boolean }>(readTextIndexFromServer, ctx, {
      documentVersionId: 'version_modelo',
      sha256: 'd'.repeat(64),
      ...createVdrReadServerProof({
        operation: 'READ_TEXT_INDEX',
        bindingParts: ['version_modelo', 'd'.repeat(64)],
      }),
    })
    expect(stale.found, 'a replaced blob must never serve the old text').toBe(false)
  })
})

describe('vdrReadAudits', () => {
  it('writes one bounded row per tool invocation', async () => {
    const ctx = createConvexCtx(baseTables())
    await runHandler(recordReadAuditFromServer, ctx, {
      principalId: OWNER_SUBJECT,
      clientId: 'client_01ABC',
      salaId: 'company_andina',
      tool: 'modelo_rango',
      argsSha256: 'e'.repeat(64),
      outcome: 'OK' as const,
      resultSummary: 'citations=1',
      ...createVdrReadServerProof({
        operation: 'AUDIT_TOOL',
        bindingParts: [OWNER_SUBJECT, 'client_01ABC', 'modelo_rango', 'e'.repeat(64), 'OK'],
      }),
    })

    expect(ctx.tables.vdrReadAudits).toHaveLength(1)
    expect(ctx.tables.vdrReadAudits[0]).toMatchObject({
      principalId: OWNER_SUBJECT,
      companyId: 'company_andina',
      tool: 'modelo_rango',
      outcome: 'OK',
    })
    // The audit row never carries the caller's raw arguments.
    expect(JSON.stringify(ctx.tables.vdrReadAudits[0])).not.toContain('Supuestos')
  })
})
