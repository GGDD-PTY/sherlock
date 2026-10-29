import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  finalizeAssetUpload,
  issueAssetUploadIntent,
  prepareAssetUpload,
  resolveAssetUpload,
} from '../../../convex/_documents/assetUploadIntents'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}

const SHA256 = 'a'.repeat(64)

function assetTables(): Tables {
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
    ],
    profiles: [{ _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true }],
    documents: [],
    documentVersions: [],
    documentRedactions: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    rateLimits: [],
  }
}

function withStorage(tables = assetTables()) {
  const systemGet = vi.fn().mockResolvedValue({
    _id: 'storage_asset',
    _creationTime: 1,
    size: 8,
    contentType: 'image/png',
    sha256: SHA256,
  })
  const ctx = Object.assign(createConvexCtx(tables, { identity: IDENTITY }), {
    storage: {
      generateUploadUrl: vi.fn().mockResolvedValue('https://storage.example/upload-once'),
      getUrl: vi.fn().mockResolvedValue('https://storage.example/public-asset'),
      delete: vi.fn(),
    },
  })
  Object.assign(ctx.db, { system: { get: systemGet } })
  return { ctx, tables, systemGet }
}

beforeEach(() => {
  vi.stubEnv('CONVEX_ENV', 'dev')
  vi.stubEnv('VDR_FILE_SCANNER_URL', '')
  vi.stubEnv('VDR_FILE_SCANNER_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('purpose-bound public asset uploads', () => {
  it('issues one short-lived intent bound to owner, purpose, size, MIME and SHA-256', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { ctx, tables } = withStorage()

    const result = await runHandler<
      Record<string, unknown>,
      { intentId: string; uploadUrl: string; expiresAt: number }
    >(issueAssetUploadIntent, ctx, {
      purpose: 'LOGO',
      declaredMimeType: ' IMAGE/PNG ',
      declaredByteSize: 8,
      declaredSha256: ` ${SHA256.toUpperCase()} `,
    })

    expect(result).toEqual({
      intentId: expect.any(String),
      uploadUrl: 'https://storage.example/upload-once',
      expiresAt: 1_600_000,
    })
    expect(tables.assetUploadIntents).toContainEqual(
      expect.objectContaining({
        _id: result.intentId,
        requestedByProfileId: 'profile_owner',
        purpose: 'LOGO',
        status: 'ISSUED',
        declaredMimeType: 'image/png',
        declaredByteSize: 8,
        declaredSha256: SHA256,
        expiresAt: 1_600_000,
      })
    )
  })

  it('rejects a declared MIME that is not an allowed image type without minting an upload URL', async () => {
    const { ctx, tables } = withStorage()

    await expect(
      runHandler(issueAssetUploadIntent, ctx, {
        purpose: 'LOGO',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 8,
        declaredSha256: SHA256,
      })
    ).rejects.toThrow(/tipo de imagen no está permitido/i)

    expect(ctx.storage.generateUploadUrl).not.toHaveBeenCalled()
    expect(tables.assetUploadIntents).toHaveLength(0)
  })

  it('quarantines a storageId already bound to any VDR intent, including REJECTED', async () => {
    const { ctx, tables, systemGet } = withStorage()
    const issued = await runHandler<Record<string, unknown>, { intentId: string }>(
      issueAssetUploadIntent,
      ctx,
      {
        purpose: 'LOGO',
        declaredMimeType: 'image/png',
        declaredByteSize: 8,
        declaredSha256: SHA256,
      }
    )
    tables.vdrUploadIntents.push({
      _id: 'vdr_intent_rejected',
      requestedByProfileId: 'profile_owner',
      status: 'REJECTED',
      storageId: 'storage_asset',
      createdAt: 1,
      expiresAt: 2,
    })

    const result = await runHandler(prepareAssetUpload, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_asset',
    })

    expect(result).toEqual({ status: 'REJECTED', code: 'ASSET_UPLOAD_REJECTED' })
    expect(tables.assetUploadIntents[0]).toMatchObject({
      status: 'REJECTED',
      storageId: 'storage_asset',
      rejectionReason: 'VDR_STORAGE_CONFLICT',
    })
    expect(systemGet).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('rejects bytes whose real signature does not match the declared image MIME', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'READY',
        intentId: 'asset_intent_1',
        requestedByProfileId: 'profile_owner',
        purpose: 'LOGO',
        storageId: 'storage_asset',
        size: 8,
        contentType: 'image/png',
        sha256: SHA256,
      })
      .mockResolvedValueOnce({ status: 'REJECTED', code: 'ASSET_UPLOAD_REJECTED' })
    const ctx = {
      runMutation,
      storage: {
        get: vi.fn().mockResolvedValue(new Blob([new TextEncoder().encode('<script>')])),
      },
    }

    const result = await runHandler(resolveAssetUpload, ctx, {
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
    })

    expect(result).toEqual({ resolved: false, code: 'ASSET_UPLOAD_REJECTED' })
    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
      reason: 'INVALID_ASSET_SIGNATURE',
    })
  })

  it('returns only the URL after real signature inspection and atomic intent consumption', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'READY',
        intentId: 'asset_intent_1',
        requestedByProfileId: 'profile_owner',
        purpose: 'LOGO',
        storageId: 'storage_asset',
        size: png.byteLength,
        contentType: 'image/png',
        sha256: SHA256,
      })
      .mockResolvedValueOnce('https://storage.example/public-asset')
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([png])) },
    }

    const result = await runHandler(resolveAssetUpload, ctx, {
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
    })

    expect(result).toEqual({ resolved: true, url: 'https://storage.example/public-asset' })
    expect(result).not.toHaveProperty('storageId')
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
      inspectedSize: png.byteLength,
      inspectedSha256: SHA256,
      signature: 'PNG',
      malwareScanStatus: 'NOT_CONFIGURED',
    })
  })

  it('fails closed in production when the private malware scanner is unavailable', async () => {
    vi.stubEnv('CONVEX_ENV', 'production')
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'READY',
        intentId: 'asset_intent_1',
        requestedByProfileId: 'profile_owner',
        purpose: 'AVATAR',
        storageId: 'storage_asset',
        size: png.byteLength,
        contentType: 'image/png',
        sha256: SHA256,
      })
      .mockResolvedValueOnce({ status: 'REJECTED', code: 'ASSET_UPLOAD_REJECTED' })
    const ctx = {
      runMutation,
      storage: { get: vi.fn().mockResolvedValue(new Blob([png])) },
    }

    const result = await runHandler(resolveAssetUpload, ctx, {
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
    })

    expect(result).toEqual({ resolved: false, code: 'ASSET_UPLOAD_REJECTED' })
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      intentId: 'asset_intent_1',
      storageId: 'storage_asset',
      reason: 'SCAN_UNAVAILABLE',
    })
  })

  it('atomically consumes the exact owned intent before resolving its public asset URL', async () => {
    const { ctx, tables } = withStorage()
    const issued = await runHandler<Record<string, unknown>, { intentId: string }>(
      issueAssetUploadIntent,
      ctx,
      {
        purpose: 'LOGO',
        declaredMimeType: 'image/png',
        declaredByteSize: 8,
        declaredSha256: SHA256,
      }
    )
    await runHandler(prepareAssetUpload, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_asset',
    })

    const url = await runHandler(finalizeAssetUpload, ctx, {
      intentId: issued.intentId,
      storageId: 'storage_asset',
      inspectedSize: 8,
      inspectedSha256: SHA256,
      signature: 'PNG',
      malwareScanStatus: 'NOT_CONFIGURED',
    })

    expect(url).toBe('https://storage.example/public-asset')
    expect(tables.assetUploadIntents[0]).toMatchObject({
      status: 'CONSUMED',
      storageId: 'storage_asset',
      signatureKind: 'PNG',
      malwareScanStatus: 'NOT_CONFIGURED',
      consumedAt: expect.any(Number),
    })
    expect(ctx.storage.getUrl).toHaveBeenCalledTimes(1)
  })
})
