import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequireAuth, mockResolveDownloadAccess, mockRecordDocumentAccessLog } = vi.hoisted(
  () => ({
    mockRequireAuth: vi.fn(),
    mockResolveDownloadAccess: vi.fn(),
    mockRecordDocumentAccessLog: vi.fn(),
  })
)

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_documents/shared', () => ({
  createDocumentAccessGrantToken: () => 'grant-token',
  hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
  recordDocumentAccessLog: (...args: unknown[]) => mockRecordDocumentAccessLog(...args),
  resolveDownloadAccess: (...args: unknown[]) => mockResolveDownloadAccess(...args),
}))

vi.mock('../../../convex/_documents/deliverableVersion', () => ({
  loadDeliverablePublishedVersion: vi.fn(async (_ctx: unknown, document: { storageId?: string }) =>
    document?.storageId
      ? { _id: 'version_1', sha256: 'a'.repeat(64), storageId: document.storageId }
      : null
  ),
}))

vi.mock('../../../convex/_generated/api', () => ({
  internal: { documents: { _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent' } },
}))

vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: {
    DATA_ROOM_DOWNLOADS_ALERT: 100,
    DATA_ROOM_DOWNLOADS_WARNING: 50,
  },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 60_000 },
}))

import { consumeDownloadGrant } from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'

const STORAGE_SECRET = 'document-delivery-secret-for-tests'

async function deliveryArgs(token: string) {
  const deliveryIssuedAt = Date.now()
  return {
    deliveryIssuedAt,
    deliveryProof: await createDocumentDeliveryProof(STORAGE_SECRET, {
      grantId: 'grant_1',
      token,
      profileId: 'profile_1',
      issuedAt: deliveryIssuedAt,
    }),
  }
}

const consume = (
  consumeDownloadGrant as unknown as {
    _handler: (
      ctx: Record<string, unknown>,
      args: { grantId: string; token: string }
    ) => Promise<unknown>
  }
)._handler

describe('consumeDownloadGrant single-use', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockResolveDownloadAccess.mockResolvedValue({
      decision: 'ALLOW',
      outcome: 'ALLOWED',
      classification: 'CONFIDENTIAL',
      riskScore: 10,
      stepUpRequirement: 'NONE',
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('revoca el grant al consumirlo y rechaza un replay', async () => {
    const grant: {
      _id: string
      documentId: string
      documentVersionId: string
      documentSha256: string
      companyId: string
      profileId: string
      tokenHash: string
      expiresAt: number
      useCount: number
      accessLevel: string
      classification: string
      revokedAt?: number
    } = {
      _id: 'grant_1',
      documentId: 'document_1',
      documentVersionId: 'version_1',
      documentSha256: 'a'.repeat(64),
      companyId: 'company_1',
      profileId: 'profile_1',
      tokenHash: 'hash:secret',
      // La emisión persiste la clasificación EVALUADA (inferida para documentos
      // legados sin `classification`); el consumo compara contra esa inferencia.
      classification: 'CONFIDENTIAL',
      expiresAt: Date.now() + 60_000,
      useCount: 0,
      accessLevel: 'NDA_REQUIRED',
    }
    const document = {
      _id: 'document_1',
      companyId: 'company_1',
      storageId: 'storage_1',
      name: 'memo.pdf',
      fileType: 'application/pdf',
      accessLevel: 'NDA_REQUIRED',
    }
    const patch = vi.fn()
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => (id === 'grant_1' ? grant : document)),
        patch,
        insert: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn().mockReturnThis(),
          collect: vi.fn().mockResolvedValue([]),
          take: vi.fn().mockResolvedValue([]),
        })),
      },
      scheduler: { runAfter: vi.fn() },
      storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/memo.pdf') },
    }

    await consume(ctx, {
      grantId: 'grant_1',
      token: 'secret',
      ...(await deliveryArgs('secret')),
    })

    expect(patch).toHaveBeenCalledWith(
      'grant_1',
      expect.objectContaining({
        useCount: 1,
        revokedAt: expect.any(Number),
        outcome: 'CONSUMED',
      })
    )

    grant.revokedAt = Date.now()
    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'secret',
        ...(await deliveryArgs('secret')),
      })
    ).rejects.toThrow(/expirado/i)
  })
})
