import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireAuth,
  mockFindDocumentByStorageId,
  mockFindVdrUploadIntentByStorageId,
  mockEnforceRateLimit,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFindDocumentByStorageId: vi.fn(),
  mockFindVdrUploadIntentByStorageId: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_helpers/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}))

vi.mock('../../../convex/_documents/shared', () => ({
  createDocumentAccessGrantToken: () => 'grant-token',
  hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
  recordDocumentAccessLog: vi.fn(),
  resolveDownloadAccess: vi.fn(),
  findDocumentByStoragePath: vi.fn(),
  findDocumentByStorageId: (...args: unknown[]) => mockFindDocumentByStorageId(...args),
}))

vi.mock('../../../convex/_documents/uploadIntents', () => ({
  findVdrUploadIntentByStorageId: (...args: unknown[]) =>
    mockFindVdrUploadIntentByStorageId(...args),
}))

vi.mock('../../../convex/_generated/api', () => ({
  internal: { documents: { _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent' } },
}))

vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: { DATA_ROOM_DOWNLOADS_ALERT: 100, DATA_ROOM_DOWNLOADS_WARNING: 50 },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 60_000 },
}))

import { getStorageUrl } from '../../../convex/_documents/storage'

const resolveUrl = (
  getStorageUrl as unknown as {
    _handler: (
      ctx: Record<string, unknown>,
      args: { storageId: string; assetIntentId: string }
    ) => Promise<string | null>
  }
)._handler

describe('getStorageUrl authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'user@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockEnforceRateLimit.mockResolvedValue(undefined)
    mockFindVdrUploadIntentByStorageId.mockResolvedValue(null)
  })

  it('niega resolver un storageId que pertenece a un documento VDR (IDOR)', async () => {
    // Un usuario autenticado cualquiera intenta resolver el storageId de un
    // documento protegido de otra empresa. Debe negarse — el acceso a documentos
    // solo pasa por getDownloadUrl + grants, jamás por getStorageUrl.
    mockFindDocumentByStorageId.mockResolvedValue({
      _id: 'document_ajeno',
      companyId: 'company_otra',
      storageId: 'storage_documento',
    })
    const getUrl = vi.fn().mockResolvedValue('https://files.example/leak.pdf')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'asset_intent_atacante',
          requestedByProfileId: 'profile_1',
          status: 'CONSUMED',
          storageId: 'storage_documento',
        }),
      },
      storage: { getUrl },
    }

    await expect(
      resolveUrl(ctx, {
        storageId: 'storage_documento',
        assetIntentId: 'asset_intent_atacante',
      })
    ).rejects.toThrow(/autorizado/i)
    expect(getUrl).not.toHaveBeenCalled()
  })

  it('niega un blob huérfano aunque no pertenezca a un documento VDR', async () => {
    mockFindDocumentByStorageId.mockResolvedValue(null)
    const getUrl = vi.fn().mockResolvedValue('https://files.example/orphan.png')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue(null),
      },
      storage: { getUrl },
    }

    await expect(
      resolveUrl(ctx, {
        storageId: 'storage_orphan',
        assetIntentId: 'asset_intent_inventado',
      })
    ).rejects.toThrow(/autorizado/i)

    expect(getUrl).not.toHaveBeenCalled()
  })

  it('niega un asset intent rechazado aunque esté ligado al storageId exacto', async () => {
    mockFindDocumentByStorageId.mockResolvedValue(null)
    const getUrl = vi.fn().mockResolvedValue('https://files.example/quarantine.png')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'asset_intent_rejected',
          requestedByProfileId: 'profile_1',
          status: 'REJECTED',
          storageId: 'storage_quarantine',
        }),
      },
      storage: { getUrl },
    }

    await expect(
      resolveUrl(ctx, {
        storageId: 'storage_quarantine',
        assetIntentId: 'asset_intent_rejected',
      })
    ).rejects.toThrow(/autorizado/i)
    expect(getUrl).not.toHaveBeenCalled()
  })

  it('niega un asset consumido por otro perfil sin revelar si existe', async () => {
    mockFindDocumentByStorageId.mockResolvedValue(null)
    const getUrl = vi.fn().mockResolvedValue('https://files.example/other-avatar.png')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'asset_intent_other',
          requestedByProfileId: 'profile_other',
          status: 'CONSUMED',
          storageId: 'storage_other',
        }),
      },
      storage: { getUrl },
    }

    await expect(
      resolveUrl(ctx, {
        storageId: 'storage_other',
        assetIntentId: 'asset_intent_other',
      })
    ).rejects.toThrow(/autorizado/i)
    expect(getUrl).not.toHaveBeenCalled()
  })

  it('resuelve únicamente el asset consumido por el perfil y storage exactos', async () => {
    mockFindDocumentByStorageId.mockResolvedValue(null)
    const getUrl = vi.fn().mockResolvedValue('https://files.example/avatar.png')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'asset_intent_owned',
          requestedByProfileId: 'profile_1',
          status: 'CONSUMED',
          storageId: 'storage_avatar',
        }),
      },
      storage: { getUrl },
    }

    const url = await resolveUrl(ctx, {
      storageId: 'storage_avatar',
      assetIntentId: 'asset_intent_owned',
    })

    expect(url).toBe('https://files.example/avatar.png')
    expect(getUrl).toHaveBeenCalledWith('storage_avatar')
  })

  it('niega un asset consumido si el blob también aparece en un intent VDR rechazado', async () => {
    mockFindDocumentByStorageId.mockResolvedValue(null)
    mockFindVdrUploadIntentByStorageId.mockResolvedValue({
      _id: 'vdr_intent_rejected',
      status: 'REJECTED',
      storageId: 'storage_overlap',
    })
    const getUrl = vi.fn().mockResolvedValue('https://files.example/quarantined.png')
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'asset_intent_owned',
          requestedByProfileId: 'profile_1',
          status: 'CONSUMED',
          storageId: 'storage_overlap',
        }),
      },
      storage: { getUrl },
    }

    await expect(
      resolveUrl(ctx, {
        storageId: 'storage_overlap',
        assetIntentId: 'asset_intent_owned',
      })
    ).rejects.toThrow(/autorizado/i)
    expect(getUrl).not.toHaveBeenCalled()
  })
})
