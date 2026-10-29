import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  finalizeInspectedUpload,
  inspectAndRegisterDirectUpload,
  rejectUnsafeUpload,
} from '../../../convex/_documents/ingest'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { buildZipFixture } from '../utils/zip-fixtures'

const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}

const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

const ACTION_ARGS = {
  intentId: 'intent_1',
  storageId: 'storage_1',
}

const INGEST_ARGS = {
  ...ACTION_ARGS,
  requestedByProfileId: 'profile_issuer',
  companyId: 'company_1',
  dealId: 'deal_1',
  fileName: 'financial-model.pdf',
  declaredMimeType: 'application/pdf',
  declaredByteSize: 8,
  declaredSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Financial model',
  accessLevel: 'NDA_REQUIRED' as const,
  classification: 'CONFIDENTIAL' as const,
  folder: 'financial_information',
}

function readyInspection(
  contentType = 'application/pdf',
  size = 8,
  expectedCurrentVersionNumber = 0
) {
  const { storageId: _storageId, ...bound } = INGEST_ARGS
  return {
    status: 'READY',
    bound,
    size,
    contentType,
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expectedCurrentVersionNumber,
  }
}

beforeEach(() => {
  vi.stubEnv('CONVEX_ENV', 'dev')
  vi.stubEnv('VDR_FILE_SCANNER_URL', '')
  vi.stubEnv('VDR_FILE_SCANNER_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function ingestTables(): Tables {
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
    ],
    profiles: [{ _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true }],
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
    deals: [{ _id: 'deal_1', companyId: 'company_1', title: 'Growth facility' }],
    documents: [],
    documentVersions: [],
    documentAccessGrants: [],
    activityLogs: [],
    adminAuditLogs: [],
    rateLimits: [],
    vdrUploadIntents: [
      {
        _id: 'intent_1',
        companyId: 'company_1',
        dealId: 'deal_1',
        requestedByProfileId: 'profile_issuer',
        status: 'INSPECTING',
        storageId: 'storage_1',
        preparedAt: Date.now(),
        fileName: 'financial-model.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'Financial model',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        folder: 'financial_information',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ],
  }
}

describe('document ingest inspection action', () => {
  it('detects a real PDF signature and binds the finalization to storage metadata', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(readyInspection())
      .mockResolvedValueOnce('document_1')
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

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toBe('document_1')
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      inspectedSize: 8,
      inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })
  })

  it('rejects and routes a MIME/signature mismatch through the cleanup mutation', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(readyInspection())
      .mockResolvedValue({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    const ctx = {
      runMutation,
      storage: {
        get: vi
          .fn()
          .mockResolvedValue(new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0])])),
      },
    }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toEqual({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      reason: 'INVALID_FILE_SIGNATURE',
    })
  })

  it('rejects a malformed OOXML container before finalization', async () => {
    const zipHeaderOnly = new Uint8Array(16)
    zipHeaderOnly.set([0x50, 0x4b, 0x03, 0x04])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(
        readyInspection(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          zipHeaderOnly.byteLength
        )
      )
      .mockResolvedValue({ registered: false, code: 'INVALID_ARCHIVE' })
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([zipHeaderOnly])) },
    }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toEqual({ registered: false, code: 'INVALID_ARCHIVE' })
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      reason: 'INVALID_ARCHIVE',
    })
  })

  it('rejects a structurally valid generic ZIP renamed as OOXML', async () => {
    const bytes = buildZipFixture(['payload.bin'])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(
        readyInspection(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes.byteLength
        )
      )
      .mockResolvedValue({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([bytes.buffer as ArrayBuffer])) },
    }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toEqual({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      reason: 'INVALID_FILE_SIGNATURE',
    })
  })

  it('fails closed in production when the private scanner is not configured', async () => {
    vi.stubEnv('CONVEX_ENV', 'production')
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(readyInspection('application/pdf', bytes.byteLength))
      .mockResolvedValue({ registered: false, code: 'SCAN_UNAVAILABLE' })
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([bytes])) },
    }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toEqual({ registered: false, code: 'SCAN_UNAVAILABLE' })
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      reason: 'SCAN_UNAVAILABLE',
    })
  })

  it('honors the explicit [F] production scanner opt-out and finalizes as NOT_CONFIGURED', async () => {
    vi.stubEnv('CONVEX_ENV', 'production')
    vi.stubEnv('VDR_SCANNER_OPTIONAL', 'true')
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(readyInspection('application/pdf', bytes.byteLength))
      .mockResolvedValueOnce('document_1')
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([bytes])) },
    }

    await expect(runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)).resolves.toBe(
      'document_1'
    )
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      inspectedSize: bytes.byteLength,
      inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })
    expect(JSON.stringify(runMutation.mock.calls[1]?.[1])).not.toMatch(/SCAN_UNAVAILABLE/)
  })

  it.each([undefined, 'prodution'])(
    'fails closed when the deployment environment is missing or invalid (%s)',
    async (convexEnv) => {
      if (convexEnv === undefined) {
        Reflect.deleteProperty(process.env, 'CONVEX_ENV')
      } else {
        vi.stubEnv('CONVEX_ENV', convexEnv)
      }
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
      const runMutation = vi
        .fn()
        .mockResolvedValueOnce(readyInspection('application/pdf', bytes.byteLength))
        .mockResolvedValue({ registered: false, code: 'SCAN_UNAVAILABLE' })
      const ctx = {
        runMutation,
        storage: { get: vi.fn().mockResolvedValue(new Blob([bytes])) },
      }

      await expect(runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)).resolves.toEqual({
        registered: false,
        code: 'SCAN_UNAVAILABLE',
      })
      expect(runMutation.mock.calls[1]?.[1]).toEqual({
        ...INGEST_ARGS,
        reason: 'SCAN_UNAVAILABLE',
      })
    }
  )

  it('returns the existing document without reading or registering the blob on an idempotent retry', async () => {
    const runMutation = vi.fn().mockResolvedValue({
      status: 'ALREADY_REGISTERED',
      documentId: 'document_existing',
    })
    const storageGet = vi.fn()
    const ctx = { runMutation, storage: { get: storageGet } }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toBe('document_existing')
    expect(storageGet).not.toHaveBeenCalled()
    expect(runMutation).toHaveBeenCalledTimes(1)
  })

  it('returns durable uncertainty without reading bytes when the inspection lease is blocked', async () => {
    const runMutation = vi.fn().mockResolvedValue({
      status: 'BLOCKED',
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    const storageGet = vi.fn()
    const ctx = { runMutation, storage: { get: storageGet } }

    await expect(runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    expect(storageGet).not.toHaveBeenCalled()
    expect(runMutation).toHaveBeenCalledTimes(1)
  })
})

describe('document ingest finalization', () => {
  it('terminalizes the bound intent when content inspection rejects the known blob', async () => {
    const tables = ingestTables()
    const ctx = Object.assign(createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
      storage: { delete: vi.fn() },
    })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      },
    })

    const result = await runHandler(rejectUnsafeUpload, ctx, {
      ...INGEST_ARGS,
      reason: 'INVALID_FILE_SIGNATURE',
    })

    expect(result).toEqual({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INVALID_FILE_SIGNATURE',
      rejectedAt: expect.any(Number),
    })
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('finalizes when Convex Storage reports the blob digest in base64 against hex (residual ingest.ts:238)', async () => {
    const HEX = 'c60c38b9d3cdd5082c298f5ef7c35029b7bf7834c16c49bd370f36d7abbf4d86'
    const BASE64 = 'xgw4udPN1QgsKY9e98NQKbe/eDTBbEm9Nw8216u/TYY='
    const tables = ingestTables()
    tables.vdrUploadIntents[0].declaredSha256 = HEX
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: BASE64,
        }),
      },
    })

    const documentId = await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      declaredSha256: HEX,
      inspectedSize: 8,
      inspectedSha256: HEX,
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })

    expect(tables.documentVersions[0]).toMatchObject({
      documentId,
      sha256: HEX,
      publicationStatus: 'PUBLISHED',
    })
    expect(tables.documentVersions[0]?.sha256).not.toBe(BASE64)
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'CONSUMED' })
  })

  it('creates one immutable version and publishes it through stable document pointers', async () => {
    const tables = ingestTables()
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      },
    })

    const documentId = await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      inspectedSize: 8,
      inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })

    expect(tables.documents).toHaveLength(1)
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.documents[0]).toMatchObject({
      _id: documentId,
      lifecycleStatus: 'ACTIVE',
      currentVersionNumber: 1,
      currentVersionId: tables.documentVersions[0]?._id,
      publishedVersionId: tables.documentVersions[0]?._id,
    })
    expect(tables.documentVersions[0]).toMatchObject({
      documentId,
      versionNumber: 1,
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signatureKind: 'PDF',
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'NOT_CONFIGURED',
      publicationStatus: 'PUBLISHED',
    })
    expect(tables.activityLogs).toContainEqual(
      expect.objectContaining({ action: 'VDR_DOCUMENT_VERSION_INGESTED' })
    )
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'CONSUMED',
      documentId,
      documentVersionId: tables.documentVersions[0]?._id,
      consumedAt: expect.any(Number),
    })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('adds a minimal admin audit only when an ADMIN finalizes the upload', async () => {
    const tables = ingestTables()
    tables.users.push({
      _id: 'user_admin',
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'admin@example.com',
      role: 'ADMIN',
    })
    tables.profiles.push({
      _id: 'profile_admin',
      userId: 'user_admin',
      role: 'ADMIN',
      isActive: true,
    })
    tables.vdrUploadIntents[0].requestedByProfileId = 'profile_admin'
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      },
    })

    const documentId = await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      requestedByProfileId: 'profile_admin',
      inspectedSize: 8,
      inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })

    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        action: 'DOCUMENT_UPLOAD',
        targetType: 'DOCUMENT',
        targetId: documentId,
        newValue: {
          versionNumber: 1,
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: 'NOT_CONFIGURED',
        },
      })
    )
    expect(JSON.stringify(tables.adminAuditLogs)).not.toContain('storage_1')
    expect(JSON.stringify(tables.adminAuditLogs)).not.toContain('financial-model.pdf')
    expect(tables.activityLogs).toContainEqual(
      expect.objectContaining({ action: 'VDR_DOCUMENT_VERSION_INGESTED' })
    )
  })

  it('refuses finalization when the inspected hash no longer matches storage', async () => {
    const tables = ingestTables()
    tables.vdrUploadIntents[0].declaredSha256 =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      },
    })

    await expect(
      runHandler(finalizeInspectedUpload, ctx, {
        ...INGEST_ARGS,
        declaredSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        inspectedSize: 8,
        inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        signature: 'PDF',
        malwareScanStatus: 'NOT_CONFIGURED',
        expectedCurrentVersionNumber: 0,
      })
    ).rejects.toThrow(/inspección/i)
    expect(tables.documents).toHaveLength(0)
    expect(tables.documentVersions).toHaveLength(0)
  })

  it('revalidates the declared hash during finalization without disclosing either hash', async () => {
    const tables = ingestTables()
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          _creationTime: 1,
          size: 8,
          contentType: 'application/pdf',
          sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      },
    })

    const rejection = await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      inspectedSize: 8,
      inspectedSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    }).catch((error: unknown) => error)

    expect(String(rejection)).toMatch(/huella/i)
    expect(String(rejection)).not.toContain(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
    expect(String(rejection)).not.toContain(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
    expect(tables.documents).toHaveLength(0)
    expect(tables.documentVersions).toHaveLength(0)
  })

  it('supersedes the prior immutable version and revokes outstanding delivery grants', async () => {
    const tables = ingestTables()
    tables.vdrUploadIntents[0].declaredSha256 =
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const ctx = createConvexCtx(tables, { identity: ISSUER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn(async (storageId: string) => ({
          _id: storageId,
          _creationTime: storageId === 'storage_1' ? 1 : 2,
          size: 8,
          contentType: 'application/pdf',
          sha256:
            storageId === 'storage_1'
              ? 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
              : 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        })),
      },
    })

    const documentId = (await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      declaredSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      inspectedSize: 8,
      inspectedSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })) as string
    tables.documentAccessGrants.push({
      _id: 'grant_1',
      documentId,
      profileId: 'profile_investor',
      tokenHash: 'token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    tables.vdrUploadIntents.push({
      _id: 'intent_2',
      companyId: 'company_1',
      dealId: 'deal_1',
      requestedByProfileId: 'profile_issuer',
      status: 'INSPECTING',
      storageId: 'storage_2',
      preparedAt: Date.now(),
      fileName: 'financial-model-v2.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 8,
      declaredSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      replaceDocumentId: documentId,
      name: 'Financial model',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      folder: 'financial_information',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    await runHandler(finalizeInspectedUpload, ctx, {
      ...INGEST_ARGS,
      intentId: 'intent_2',
      fileName: 'financial-model-v2.pdf',
      declaredSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      storageId: 'storage_2',
      replaceDocumentId: documentId,
      inspectedSize: 8,
      inspectedSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      signature: 'PDF',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 1,
    })

    const [versionOne, versionTwo] = tables.documentVersions
    expect(versionOne).toMatchObject({
      versionNumber: 1,
      publicationStatus: 'SUPERSEDED',
      sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    })
    expect(versionTwo).toMatchObject({
      versionNumber: 2,
      publicationStatus: 'PUBLISHED',
      sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      replacesVersionId: versionOne?._id,
    })
    expect(tables.documents[0]).toMatchObject({
      _id: documentId,
      storageId: 'storage_2',
      currentVersionNumber: 2,
      currentVersionId: versionTwo?._id,
      publishedVersionId: versionTwo?._id,
    })
    expect(tables.documentAccessGrants[0]).toMatchObject({
      revokedAt: expect.any(Number),
      outcome: 'DOCUMENT_VERSION_SUPERSEDED',
    })
  })
})

describe('document ingest of CSV sources', () => {
  const csv = new TextEncoder().encode(
    'Codigo,Cuenta,Debito,Credito\n1000,Caja y bancos,1650000.00,0.00\n1280,Venta de energia,0.00,9834840.00\n'
  )

  it('registers a text/csv trial balance with the TEXT signature bound to storage metadata', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce(readyInspection('text/csv', csv.byteLength))
      .mockResolvedValueOnce('document_csv')
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([csv])) },
    }

    const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

    expect(result).toBe('document_csv')
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      ...INGEST_ARGS,
      inspectedSize: csv.byteLength,
      inspectedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      signature: 'TEXT',
      malwareScanStatus: 'NOT_CONFIGURED',
      expectedCurrentVersionNumber: 0,
    })
  })

  it('rejects a csv-declared blob that carries a zip container or NUL bytes', async () => {
    for (const bytes of [
      buildZipFixture(['payload.bin']),
      new Uint8Array([...csv, 0x00, 0x41, 0x0a]),
    ]) {
      const runMutation = vi
        .fn()
        .mockResolvedValueOnce(readyInspection('text/csv', bytes.byteLength))
        .mockResolvedValue({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
      const ctx = {
        runMutation,
        storage: {
          get: vi.fn().mockResolvedValue(new Blob([new Uint8Array(bytes).buffer as ArrayBuffer])),
        },
      }

      const result = await runHandler(inspectAndRegisterDirectUpload, ctx, ACTION_ARGS)

      expect(result).toEqual({ registered: false, code: 'INVALID_FILE_SIGNATURE' })
      expect(runMutation.mock.calls[1]?.[1]).toEqual({
        ...INGEST_ARGS,
        reason: 'INVALID_FILE_SIGNATURE',
      })
    }
  })
})
