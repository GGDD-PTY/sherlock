import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  abandonDirectUploadIntent,
  expireIssuedUploadIntents,
  issueDirectUploadIntent,
  prepareDirectUploadIntent,
} from '../../../convex/_documents/uploadIntents'
import { MAX_CSV_UPLOAD_BYTES } from '../../../convex/_documents/uploadLimits'
import {
  createConvexCtx,
  runHandler,
  runMutationHandlerWithOcc,
  type Tables,
} from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}

const FILE_SHA256 = 'a'.repeat(64)

function intentTables(): Tables {
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
    documents: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    rateLimits: [],
  }
}

function withStorage(tables = intentTables()) {
  const systemGet = vi.fn().mockResolvedValue({
    _id: 'storage_1',
    _creationTime: 1,
    size: 8,
    contentType: 'application/pdf',
    sha256: FILE_SHA256,
  })
  const ctx = Object.assign(createConvexCtx(tables, { identity: ISSUER_IDENTITY }), {
    storage: {
      generateUploadUrl: vi.fn().mockResolvedValue('https://storage.example/upload-once'),
      delete: vi.fn(),
    },
  })
  Object.assign(ctx.db, {
    system: { get: systemGet },
  })
  return { ctx, tables, systemGet }
}

const ISSUE_ARGS = {
  companyId: 'company_1',
  fileName: 'Modelo financiero.pdf',
  declaredMimeType: 'application/pdf',
  declaredByteSize: 8,
  declaredSha256: FILE_SHA256,
  name: 'Modelo financiero',
  accessLevel: 'NDA_REQUIRED' as const,
  classification: 'CONFIDENTIAL' as const,
  folder: 'Información financiera',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VDR direct-upload intents', () => {
  it('issues one short-lived opaque intent bound to normalized room and file metadata', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { ctx, tables } = withStorage()

    const result = await runHandler<
      { [key: string]: unknown },
      { intentId: string; uploadUrl: string; expiresAt: number }
    >(issueDirectUploadIntent, ctx, {
      companyId: 'company_1',
      fileName: '  Modelo financiero.pdf  ',
      declaredMimeType: ' APPLICATION/PDF ',
      declaredByteSize: 8,
      declaredSha256: ` ${FILE_SHA256.toUpperCase()} `,
      name: '  Modelo financiero  ',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      folder: '  Información financiera  ',
    })

    expect(result).toEqual({
      intentId: expect.any(String),
      uploadUrl: 'https://storage.example/upload-once',
      expiresAt: 1_600_000,
    })
    expect(tables.vdrUploadIntents).toContainEqual(
      expect.objectContaining({
        _id: result.intentId,
        companyId: 'company_1',
        requestedByProfileId: 'profile_issuer',
        status: 'ACTIVE',
        fileName: 'Modelo financiero.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: FILE_SHA256,
        name: 'Modelo financiero',
        folder: 'Información financiera',
        expiresAt: 1_600_000,
      })
    )
    expect(ctx.storage.generateUploadUrl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['CSV at 20 MB', 'text/csv', MAX_CSV_UPLOAD_BYTES, true],
    ['CSV at 20 MB + 1', 'text/csv', MAX_CSV_UPLOAD_BYTES + 1, false],
    ['PDF at 20 MB + 1', 'application/pdf', MAX_CSV_UPLOAD_BYTES + 1, true],
  ])(
    'applies the per-format cap before issuing an upload URL: %s',
    async (_label, declaredMimeType, declaredByteSize, accepted) => {
      const { ctx, tables } = withStorage()

      const result = await runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        fileName: declaredMimeType === 'text/csv' ? 'balance.csv' : 'modelo.pdf',
        declaredMimeType,
        declaredByteSize,
      })

      if (accepted) {
        expect(result).toMatchObject({ intentId: expect.any(String) })
        expect(ctx.storage.generateUploadUrl).toHaveBeenCalledTimes(1)
        expect(tables.vdrUploadIntents).toHaveLength(1)
      } else {
        expect(result).toEqual({ registered: false, code: 'FILE_TOO_LARGE' })
        expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
        expect(tables.vdrUploadIntents).toHaveLength(0)
      }
    }
  )

  it('atomically blocks a second active intent for the exact requester, scope and SHA-256', async () => {
    const { ctx, tables } = withStorage()

    await runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)
    const duplicate = await runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)

    expect(duplicate).toEqual({ registered: false, code: 'UPLOAD_INTENT_ACTIVE' })
    expect(tables.vdrUploadIntents).toHaveLength(1)
    expect(ctx.storage.generateUploadUrl).toHaveBeenCalledTimes(1)
  })

  it('relies on Convex OCC to serialize concurrent identical issuance in one mutation boundary', async () => {
    const { ctx, tables } = withStorage()

    const results = await Promise.all([
      runMutationHandlerWithOcc(issueDirectUploadIntent, ctx, ISSUE_ARGS),
      runMutationHandlerWithOcc(issueDirectUploadIntent, ctx, ISSUE_ARGS),
    ])

    expect(results).toContainEqual({ registered: false, code: 'UPLOAD_INTENT_ACTIVE' })
    expect(results).toContainEqual(expect.objectContaining({ intentId: expect.any(String) }))
    expect(tables.vdrUploadIntents).toHaveLength(1)
    expect(ctx.storage.generateUploadUrl).toHaveBeenCalledTimes(1)
  })

  it('blocks the same exact bytes from a fresh request context used after reload or by a batch worker', async () => {
    const first = withStorage()
    await runHandler(issueDirectUploadIntent, first.ctx, ISSUE_ARGS)
    const fresh = withStorage(first.tables)

    await expect(runHandler(issueDirectUploadIntent, fresh.ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_ACTIVE',
    })
    expect(fresh.ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(first.tables.vdrUploadIntents).toHaveLength(1)
  })

  it('expires a new unbound ACTIVE intent before allowing the exact bytes again', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_active_expired',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ACTIVE',
      createdAt: 1,
      expiresAt: 1_999_999,
    })

    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toMatchObject({
      intentId: expect.any(String),
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'EXPIRED',
      expiredAt: 2_000_000,
    })
  })

  it('returns a stable rejected code for exact prior terminal evidence', async () => {
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_rejected',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'REJECTED',
      storageId: 'storage_private_locator',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      rejectedAt: Date.now(),
      rejectionReason: 'UPLOAD_INTENT_MISMATCH',
    })

    const result = await runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)

    expect(result).toEqual({ registered: false, code: 'UPLOAD_INTENT_REJECTED' })
    expect(JSON.stringify(result)).not.toContain('storage_private_locator')
    expect(JSON.stringify(result)).not.toContain(FILE_SHA256)
    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses cross-company issuance before minting upload authority', async () => {
    const { ctx, tables } = withStorage()
    tables.companies.push({ _id: 'company_other', ownerId: 'profile_other', name: 'Other' })

    await expect(
      runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        companyId: 'company_other',
      })
    ).rejects.toThrow(/dueño/i)

    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents).toHaveLength(0)
  })

  it('rejects a malformed client hash without echoing it or minting an upload URL', async () => {
    const { ctx, tables } = withStorage()
    const malformed = 'not-a-sha256-secret-value'

    await expect(
      runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        declaredSha256: malformed,
      })
    ).rejects.toThrow(/huella/i)

    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents).toHaveLength(0)
  })

  it('binds the first matching storage receipt to the immutable intent metadata', async () => {
    const { ctx, tables } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    const prepared = await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_1',
    })

    expect(prepared).toMatchObject({
      status: 'READY',
      bound: {
        intentId: issued.intentId,
        companyId: 'company_1',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: FILE_SHA256,
      },
      size: 8,
      sha256: FILE_SHA256,
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'INSPECTING',
      storageId: 'storage_1',
      preparedAt: expect.any(Number),
    })
  })

  it('accepts the Convex Storage base64 digest for a hex-declared SHA-256 (prod regression 2026-08-26)', async () => {
    // brainy-emu-822 devuelve `_storage.sha256` en base64; el cliente declara hex.
    const base64OfDeclaredDigest = 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo='
    const { ctx, tables, systemGet } = withStorage()
    systemGet.mockResolvedValue({
      _id: 'storage_1',
      _creationTime: 1,
      size: 8,
      contentType: 'application/pdf',
      sha256: base64OfDeclaredDigest,
    })
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    const prepared = await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_1',
    })

    expect(prepared).toMatchObject({
      status: 'READY',
      sha256: FILE_SHA256,
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'INSPECTING' })
  })

  it('fails closed before storage access when the live WorkOS membership is revoked', async () => {
    const { ctx, tables, systemGet } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )
    tables.organizationMemberships[0].status = 'REVOKED'

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/dueño/i)
    await expect(
      runHandler(abandonDirectUploadIntent, ctx, { intentId: issued.intentId })
    ).rejects.toThrow(/dueño/i)

    expect(systemGet).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.vdrUploadIntents[0]).not.toHaveProperty('storageId')
    expect(tables.vdrUploadIntents[0]).not.toHaveProperty('abortedAt')

    Object.assign(tables.vdrUploadIntents[0], {
      status: 'CONSUMED',
      storageId: 'storage_1',
      documentId: 'document_1',
      consumedAt: Date.now(),
    })
    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/dueño/i)
  })

  it('commits the inspection lease before the scanner action and rejects serialized replay', async () => {
    // This in-memory harness mutates shared rows and cannot model two isolated
    // Convex transactions racing. Convex serializes conflicting mutations in
    // production. The first call binds verified storage metadata and commits
    // INSPECTING before the action can read bytes or contact the scanner. The
    // next serialized call stops before touching storage. A true overlapping
    // race remains an external/provider integration check.
    const { ctx, tables, systemGet } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).resolves.toMatchObject({ status: 'READY' })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'INSPECTING',
      storageId: 'storage_1',
      preparedAt: expect.any(Number),
    })

    systemGet.mockClear()
    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/inspección|progreso|activo/i)
    expect(systemGet).not.toHaveBeenCalled()
    ctx.storage.generateUploadUrl.mockClear()
    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
  })

  it('never turns durable UNCERTAIN evidence back into READY or touches storage', async () => {
    const { ctx, tables, systemGet } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_uncertain',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'UNCERTAIN',
      storageId: 'storage_1',
      preparedAt: 1,
      uncertainAt: 2,
      createdAt: 1,
      expiresAt: Date.now() - 1,
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_uncertain',
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/activo|terminal|reconciliación/i)
    expect(systemGet).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'UNCERTAIN' })
  })

  it('turns an expired inspection lease into UNCERTAIN without re-reading the blob', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables, systemGet } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_inspecting_expired',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'INSPECTING',
      storageId: 'storage_1',
      preparedAt: 1_000_000,
      createdAt: 1,
      expiresAt: 1_999_999,
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_inspecting_expired',
        storageId: 'storage_1',
      })
    ).resolves.toEqual({
      status: 'BLOCKED',
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    expect(systemGet).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'UNCERTAIN',
      uncertainAt: 2_000_000,
    })
  })

  it('adopts legacy prepared ISSUED evidence but never returns READY to a second action', async () => {
    const { ctx, tables, systemGet } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_legacy_prepared',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ISSUED',
      storageId: 'storage_1',
      preparedAt: 1,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_legacy_prepared',
        storageId: 'storage_1',
      })
    ).resolves.toEqual({
      status: 'BLOCKED',
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    expect(systemGet).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'INSPECTING' })
  })

  it('enforces the inspection rate limit before reading or leasing the blob', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { ctx, tables, systemGet } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )
    tables.rateLimits.push({
      _id: 'rate_limit_inspection',
      key: 'inspectedDocumentIngest:profile_issuer',
      count: 120,
      windowStart: 1_000_000,
      windowMs: 60 * 60 * 1000,
      lastHitAt: 1_000_000,
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/rate limit/i)
    expect(systemGet).not.toHaveBeenCalled()
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.vdrUploadIntents[0]).not.toHaveProperty('storageId')
  })

  it('never rebinds a public asset blob into a VDR upload intent', async () => {
    const { ctx, tables, systemGet } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )
    tables.assetUploadIntents.push({
      _id: 'asset_intent_consumed',
      requestedByProfileId: 'profile_issuer',
      purpose: 'LOGO',
      status: 'CONSUMED',
      storageId: 'storage_1',
      declaredMimeType: 'image/png',
      declaredByteSize: 8,
      declaredSha256: FILE_SHA256,
      createdAt: 1,
      expiresAt: 2,
      consumedAt: 2,
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: issued.intentId,
        storageId: 'storage_1',
      })
    ).rejects.toThrow(/registrado|autorizado/i)
    expect(systemGet).not.toHaveBeenCalled()
  })

  it('terminalizes a mismatch without treating an opaque storageId as delete authority', async () => {
    const { ctx, tables, systemGet } = withStorage()
    systemGet.mockResolvedValue({
      _id: 'storage_1',
      _creationTime: 1,
      size: 9,
      contentType: 'application/pdf',
      sha256: FILE_SHA256,
    })
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    const result = await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_1',
    })

    expect(result).toEqual({
      status: 'REJECTED',
      registered: false,
      code: 'UPLOAD_INTENT_MISMATCH',
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'UPLOAD_INTENT_MISMATCH',
    })
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('terminalizes an exact SHA-256 mismatch without returning either hash', async () => {
    const actualSha256 = 'b'.repeat(64)
    const { ctx, tables, systemGet } = withStorage()
    systemGet.mockResolvedValue({
      _id: 'storage_1',
      _creationTime: 1,
      size: 8,
      contentType: 'application/pdf',
      sha256: actualSha256,
    })
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    const result = await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_1',
    })

    expect(result).toEqual({
      status: 'REJECTED',
      registered: false,
      code: 'UPLOAD_INTENT_MISMATCH',
    })
    expect(JSON.stringify(result)).not.toContain(FILE_SHA256)
    expect(JSON.stringify(result)).not.toContain(actualSha256)
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'UPLOAD_INTENT_MISMATCH',
    })
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('expires before touching an untrusted storageId and cannot be replayed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables, systemGet } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_expired',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ISSUED',
      createdAt: 1,
      expiresAt: 1_999_999,
    })

    const first = await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: 'intent_expired',
      storageId: 'storage_untrusted',
    })
    expect(first).toEqual({
      status: 'REJECTED',
      registered: false,
      code: 'UPLOAD_INTENT_EXPIRED',
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'EXPIRED', expiredAt: 2_000_000 })
    expect(systemGet).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_expired',
        storageId: 'storage_untrusted',
      })
    ).rejects.toThrow(/no está activo/i)
  })

  it('allows only same-receipt idempotency after consumption and rejects cross-storage replay', async () => {
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_consumed',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'CONSUMED',
      storageId: 'storage_1',
      documentId: 'document_1',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      consumedAt: Date.now(),
    })

    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_consumed',
        storageId: 'storage_1',
      })
    ).resolves.toEqual({ status: 'ALREADY_REGISTERED', documentId: 'document_1' })
    await expect(
      runHandler(prepareDirectUploadIntent, ctx, {
        intentId: 'intent_consumed',
        storageId: 'storage_2',
      })
    ).rejects.toThrow(/consumido/i)
  })

  it('keeps exact reconciliation isolated by requester, company, replacement scope and SHA-256', async () => {
    const { ctx, tables } = withStorage()
    tables.documents.push({
      _id: 'document_legacy',
      companyId: 'company_1',
      name: 'Legacy',
      lifecycleStatus: 'ACTIVE',
    })

    await runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)
    await expect(
      runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        replaceDocumentId: 'document_legacy',
      })
    ).resolves.toMatchObject({ intentId: expect.any(String) })
    await expect(
      runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        declaredSha256: 'b'.repeat(64),
      })
    ).resolves.toMatchObject({ intentId: expect.any(String) })

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
    ctx.auth.getUserIdentity.mockResolvedValue({
      subject: 'workos_admin',
      issuer: 'https://api.workos.com/',
      email: 'admin@example.com',
      sid: TEST_ADMIN_SESSION_ID,
    })
    const adminInput = await mintAdminVdrCapability({
      tables,
      input: ISSUE_ARGS,
      companyId: 'company_1',
      action: 'DOCUMENT_UPLOAD_INTENT',
      target: 'COMPANY:company_1',
    })
    const adminIntent = await runHandler<
      typeof adminInput,
      { intentId: string; uploadUrl: string; expiresAt: number }
    >(issueDirectUploadIntent, ctx, adminInput)
    expect(adminIntent).toMatchObject({
      intentId: expect.any(String),
    })
    expect(tables.adminVdrCapabilities?.[0]).toMatchObject({ consumedAt: expect.any(Number) })
    await expect(
      runHandler(abandonDirectUploadIntent, ctx, { intentId: adminIntent.intentId })
    ).resolves.toEqual({ aborted: true })

    // Cuatro intents distintos: el base, el de reemplazo, el de otra huella y
    // el del admin. El eje 'sala' salió con el subsistema de transacciones.
    expect(tables.vdrUploadIntents).toHaveLength(4)
  })

  it('reconciles a consumed exact version durably without minting or duplicating', async () => {
    const { ctx, tables } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )
    tables.documents.push({
      _id: 'document_1',
      companyId: 'company_1',
      name: ISSUE_ARGS.name,
    })
    tables.documentVersions = [
      {
        _id: 'version_1',
        documentId: 'document_1',
        companyId: 'company_1',
        storageId: 'storage_1',
        declaredMimeType: ISSUE_ARGS.declaredMimeType,
        byteSize: ISSUE_ARGS.declaredByteSize,
        sha256: FILE_SHA256,
        createdByProfileId: 'profile_issuer',
      },
    ]
    Object.assign(tables.vdrUploadIntents[0], {
      status: 'CONSUMED',
      storageId: 'storage_1',
      documentId: 'document_1',
      documentVersionId: 'version_1',
      consumedAt: Date.now(),
    })
    const fresh = withStorage(tables)

    await expect(runHandler(issueDirectUploadIntent, fresh.ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: true,
      documentId: 'document_1',
    })
    expect(tables.vdrUploadIntents).toHaveLength(1)
    expect(fresh.ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(issued.intentId).toBe(tables.vdrUploadIntents[0]._id)
  })

  it('fails closed when consumed evidence does not match the exact immutable version', async () => {
    const { ctx, tables } = withStorage()
    tables.documents.push({
      _id: 'document_1',
      companyId: 'company_1',
      name: ISSUE_ARGS.name,
    })
    tables.documentVersions = [
      {
        _id: 'version_1',
        documentId: 'document_1',
        companyId: 'company_1',
        storageId: 'storage_1',
        declaredMimeType: ISSUE_ARGS.declaredMimeType,
        byteSize: ISSUE_ARGS.declaredByteSize,
        sha256: 'b'.repeat(64),
        createdByProfileId: 'profile_issuer',
      },
    ]
    tables.vdrUploadIntents.push({
      _id: 'intent_consumed_mismatch',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'CONSUMED',
      storageId: 'storage_1',
      documentId: 'document_1',
      documentVersionId: 'version_1',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      consumedAt: Date.now(),
    })

    const result = await runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)

    expect(result).toEqual({ registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' })
    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(FILE_SHA256)
    expect(JSON.stringify(result)).not.toContain('storage_1')
  })

  it('preserves legacy ISSUED compatibility while expiring only unbound authority', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_legacy_active',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ISSUED',
      createdAt: 1,
      expiresAt: 2_000_001,
    })

    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_ACTIVE',
    })
    tables.vdrUploadIntents[0].expiresAt = 1_999_999
    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toMatchObject({
      intentId: expect.any(String),
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'EXPIRED', expiredAt: 2_000_000 })
  })

  it('adopts a live legacy prepared ISSUED intent as an inspection lease without reissuing', async () => {
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_legacy_bound',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ISSUED',
      storageId: 'storage_1',
      preparedAt: 1,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    })

    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({ status: 'INSPECTING' })
    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
  })

  it('abandons only authenticated pre-byte authority and permits a later exact upload', async () => {
    const { ctx, tables } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )

    await expect(
      runHandler(abandonDirectUploadIntent, ctx, { intentId: issued.intentId })
    ).resolves.toEqual({ aborted: true })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'ABORTED',
      abortedAt: expect.any(Number),
    })
    await expect(
      runHandler(abandonDirectUploadIntent, ctx, { intentId: issued.intentId })
    ).resolves.toEqual({ aborted: true })
    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toMatchObject({
      intentId: expect.any(String),
    })
  })

  it('denies cross-user abandon without revealing scope and never terminalizes preparation', async () => {
    const { ctx, tables } = withStorage()
    const issued = await runHandler<{ [key: string]: unknown }, { intentId: string }>(
      issueDirectUploadIntent,
      ctx,
      ISSUE_ARGS
    )
    await runHandler(prepareDirectUploadIntent, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_1',
    })

    tables.users.push({
      _id: 'user_other',
      authProvider: 'workos',
      providerUserId: 'workos_other',
      workosUserId: 'workos_other',
      email: 'other@example.com',
      role: 'COMPANY',
    })
    tables.profiles.push({
      _id: 'profile_other',
      userId: 'user_other',
      role: 'COMPANY',
      isActive: true,
    })
    const otherCtx = createConvexCtx(tables, {
      identity: {
        subject: 'workos_other',
        issuer: 'https://api.workos.com/',
        email: 'other@example.com',
      },
    })

    await expect(
      runHandler(abandonDirectUploadIntent, otherCtx, { intentId: issued.intentId })
    ).rejects.toThrow(/sesión/i)
    await expect(
      runHandler(abandonDirectUploadIntent, ctx, { intentId: issued.intentId })
    ).resolves.toEqual({ aborted: false, code: 'UPLOAD_INTENT_UNCERTAIN' })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'INSPECTING',
      storageId: 'storage_1',
    })
    expect(tables.vdrUploadIntents[0]).not.toHaveProperty('abortedAt')
  })

  it('expires intents in a bounded batch without claiming unknown-blob deletion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents = Array.from({ length: 105 }, (_, index) => ({
      _id: `intent_${index}`,
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'ISSUED',
      createdAt: index,
      expiresAt: 1_000_000 + index,
    }))

    const result = await runHandler(expireIssuedUploadIntents, ctx, { limit: 1_000 })

    expect(result).toEqual({ expired: 100, hasMore: true })
    expect(tables.vdrUploadIntents.filter((intent) => intent.status === 'EXPIRED')).toHaveLength(
      100
    )
    expect(tables.vdrUploadIntents.filter((intent) => intent.status === 'ISSUED')).toHaveLength(5)
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('moves an expired inspection lease to UNCERTAIN instead of erasing its in-flight evidence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents.push({
      _id: 'intent_inspecting_expired_by_cron',
      ...ISSUE_ARGS,
      requestedByProfileId: 'profile_issuer',
      status: 'INSPECTING',
      storageId: 'storage_1',
      preparedAt: 1_000_000,
      createdAt: 1,
      expiresAt: 1_999_999,
    })

    await expect(runHandler(expireIssuedUploadIntents, ctx, { limit: 100 })).resolves.toEqual({
      expired: 1,
      hasMore: false,
    })
    expect(tables.vdrUploadIntents[0]).toMatchObject({
      status: 'UNCERTAIN',
      uncertainAt: 2_000_000,
      storageId: 'storage_1',
      preparedAt: 1_000_000,
    })
    expect(tables.vdrUploadIntents[0]).not.toHaveProperty('expiredAt')
  })

  it('quarantines stale uncertainty so it cannot permanently exhaust the active limit or retry exact bytes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000_000)
    const { ctx, tables } = withStorage()
    tables.vdrUploadIntents = Array.from({ length: 20 }, (_, index) => ({
      _id: `intent_uncertain_${index}`,
      ...ISSUE_ARGS,
      declaredSha256: index === 0 ? FILE_SHA256 : `${index.toString(16).padStart(64, '0')}`,
      requestedByProfileId: 'profile_issuer',
      status: 'UNCERTAIN',
      storageId: `storage_${index}`,
      preparedAt: 1,
      uncertainAt: 2,
      createdAt: 1,
      expiresAt: 100_000_000 - 24 * 60 * 60 * 1000 - 1,
    }))

    await runHandler(expireIssuedUploadIntents, ctx, { limit: 100 })

    expect(
      tables.vdrUploadIntents.every(
        (intent) =>
          intent.status === 'REJECTED' &&
          intent.rejectionReason === 'UNCERTAIN_RECONCILIATION_REQUIRED'
      )
    ).toBe(true)
    await expect(runHandler(issueDirectUploadIntent, ctx, ISSUE_ARGS)).resolves.toEqual({
      registered: false,
      code: 'UPLOAD_INTENT_REJECTED',
    })
    await expect(
      runHandler(issueDirectUploadIntent, ctx, {
        ...ISSUE_ARGS,
        declaredSha256: 'f'.repeat(64),
      })
    ).resolves.toMatchObject({ intentId: expect.any(String) })
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })
})
