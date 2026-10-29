import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireAuth,
  mockResolveDownloadAccess,
  mockRecordDocumentAccessLog,
  mockEnforceRateLimit,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockResolveDownloadAccess: vi.fn(),
  mockRecordDocumentAccessLog: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_helpers/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}))

vi.mock('../../../convex/_documents/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../convex/_documents/shared')>(
    '../../../convex/_documents/shared'
  )
  return {
    ...actual,
    createDocumentAccessGrantToken: () => 'plain-token',
    hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
    recordDocumentAccessLog: (...args: unknown[]) => mockRecordDocumentAccessLog(...args),
    resolveDownloadAccess: (...args: unknown[]) => mockResolveDownloadAccess(...args),
  }
})

vi.mock('../../../convex/_generated/api', () => ({
  internal: {
    documents: {
      _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent',
      _logBulkAccessEvent: 'documents:_logBulkAccessEvent',
    },
  },
}))

vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: {
    DATA_ROOM_DOWNLOADS_ALERT: 50,
    DATA_ROOM_DOWNLOADS_WARNING: 20,
    DATA_ROOM_DELIVERIES_ALERT: 150,
    DATA_ROOM_DELIVERIES_WARNING: 80,
  },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 3_600_000 },
}))

import { consumeDownloadGrant, getDownloadUrl } from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>

const issue = (getDownloadUrl as unknown as { _handler: Handler })._handler
const consume = (consumeDownloadGrant as unknown as { _handler: Handler })._handler
const STORAGE_SECRET = 'document-delivery-secret-for-tests'

const DOCUMENT = {
  _id: 'document_1',
  companyId: 'company_1',
  storageId: 'storage_published',
  name: 'memo.pdf',
  fileType: 'application/pdf',
  accessLevel: 'NDA_REQUIRED',
  classification: 'CONFIDENTIAL',
  protectionPolicyVersion: 'trust-os-v2',
  lifecycleStatus: 'ACTIVE',
  currentVersionId: 'version_1',
  publishedVersionId: 'version_1',
}

const VERSION = {
  _id: 'version_1',
  documentId: 'document_1',
  companyId: 'company_1',
  versionNumber: 1,
  storageId: 'storage_published',
  displayName: 'memo.pdf',
  declaredMimeType: 'application/pdf',
  detectedMimeType: 'application/pdf',
  byteSize: 8,
  sha256: 'a'.repeat(64),
  signatureKind: 'PDF',
  verificationStatus: 'SIGNATURE_VERIFIED',
  malwareScanStatus: 'CLEAN',
  publicationStatus: 'PUBLISHED',
  createdAt: 1,
  createdByProfileId: 'profile_company',
}

const ALLOW = {
  decision: 'ALLOW',
  outcome: 'ALLOWED_CONFIDENTIAL',
  reason: 'Acceso autorizado.',
  classification: 'CONFIDENTIAL',
  riskScore: 35,
  stepUpRequirement: 'NONE',
}

function queryBuilder() {
  return {
    withIndex: vi.fn().mockReturnThis(),
    take: vi.fn().mockResolvedValue([]),
    first: vi.fn().mockResolvedValue(null),
  }
}

function createIssueCtx(document: Record<string, unknown> = DOCUMENT) {
  const rows: Record<string, Record<string, unknown>> = {
    [String(document._id)]: document,
    version_1: VERSION,
  }
  return {
    db: {
      get: vi.fn(async (id: string) => rows[id] ?? null),
      patch: vi.fn(),
      insert: vi.fn(async () => 'grant_1'),
      query: vi.fn(queryBuilder),
    },
    scheduler: { runAfter: vi.fn() },
    storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/published.pdf') },
  }
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'grant_1',
    documentId: 'document_1',
    documentVersionId: 'version_1',
    documentSha256: VERSION.sha256,
    companyId: 'company_1',
    protectionPolicyVersion: 'trust-os-v2',
    profileId: 'profile_1',
    action: 'DOWNLOAD',
    tokenHash: 'hash:plain-token',
    expiresAt: Date.now() + 60_000,
    useCount: 0,
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    ...overrides,
  }
}

function createConsumeCtx(
  grantRow = grant(),
  document: Record<string, unknown> = DOCUMENT,
  version = VERSION
) {
  const rows: Record<string, Record<string, unknown>> = {
    grant_1: grantRow,
    document_1: document,
    version_1: version,
  }
  return {
    db: {
      get: vi.fn(async (id: string) => rows[id] ?? null),
      patch: vi.fn(),
      insert: vi.fn(),
      query: vi.fn(queryBuilder),
    },
    scheduler: { runAfter: vi.fn() },
    storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/published.pdf') },
  }
}

async function deliveryArgs() {
  const deliveryIssuedAt = Date.now()
  return {
    grantId: 'grant_1',
    token: 'plain-token',
    deliveryIssuedAt,
    deliveryProof: await createDocumentDeliveryProof(STORAGE_SECRET, {
      grantId: 'grant_1',
      token: 'plain-token',
      profileId: 'profile_1',
      issuedAt: deliveryIssuedAt,
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
  vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'true')
  mockRequireAuth.mockResolvedValue({
    user: { _id: 'user_1', email: 'investor@example.com' },
    profile: { _id: 'profile_1', role: 'COMPANY' },
  })
  mockEnforceRateLimit.mockResolvedValue(undefined)
  mockResolveDownloadAccess.mockResolvedValue(ALLOW)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('immutable published-version download grants', () => {
  it('persists immutable version, digest and exact scope when issuing a grant', async () => {
    const ctx = createIssueCtx()

    await issue(ctx, { documentId: 'document_1' })

    expect(ctx.db.insert).toHaveBeenCalledWith(
      'documentAccessGrants',
      expect.objectContaining({
        documentId: 'document_1',
        documentVersionId: 'version_1',
        documentSha256: VERSION.sha256,
        companyId: 'company_1',
        protectionPolicyVersion: 'trust-os-v2',
      })
    )
  })

  it('does not issue a grant for a legacy document without immutable published pointers', async () => {
    const legacy = {
      ...DOCUMENT,
      currentVersionId: undefined,
      publishedVersionId: undefined,
    }
    const ctx = createIssueCtx(legacy)

    await expect(issue(ctx, { documentId: 'document_1' })).resolves.toBeNull()
    expect(ctx.db.insert).not.toHaveBeenCalled()
    expect(mockResolveDownloadAccess).not.toHaveBeenCalled()
  })

  it('rejects a legacy grant missing immutable version evidence before storage resolution', async () => {
    const ctx = createConsumeCtx(grant({ documentVersionId: undefined, documentSha256: undefined }))

    await expect(consume(ctx, await deliveryArgs())).rejects.toThrow(/autorizad|inválido/i)
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('rejects a grant when its bound digest no longer matches the published version', async () => {
    const ctx = createConsumeCtx(grant({ documentSha256: 'b'.repeat(64) }))

    await expect(consume(ctx, await deliveryArgs())).rejects.toThrow(/autorizad|inválido/i)
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('accepts a grant for a legacy document whose classification was inferred at issuance', async () => {
    // Documento legado sin `classification`: la emisión persiste la
    // clasificación EVALUADA (CONFIDENTIAL inferida de NDA_REQUIRED) y el
    // consumo debe comparar contra esa misma inferencia, no contra undefined.
    const legacyDocument = { ...DOCUMENT, classification: undefined }
    const ctx = createConsumeCtx(grant(), legacyDocument)

    const result = await consume(ctx, await deliveryArgs())

    expect(result).toMatchObject({
      downloadUrl: 'https://files.example/published.pdf',
      documentId: 'document_1',
    })
  })

  it('still rejects a grant whose classification no longer matches the inferred one', async () => {
    const reclassifiedDocument = { ...DOCUMENT, accessLevel: 'PUBLIC', classification: undefined }
    const ctx = createConsumeCtx(
      grant({ accessLevel: 'PUBLIC', classification: 'CONFIDENTIAL' }),
      reclassifiedDocument
    )

    await expect(consume(ctx, await deliveryArgs())).rejects.toThrow(/autorizad|inválido/i)
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('delivers only the storageId loaded from the exact clean published version', async () => {
    const ctx = createConsumeCtx()

    const result = await consume(ctx, await deliveryArgs())

    expect(result).toMatchObject({
      downloadUrl: 'https://files.example/published.pdf',
      documentId: 'document_1',
    })
    expect(ctx.storage.getUrl).toHaveBeenCalledWith('storage_published')
  })
})
