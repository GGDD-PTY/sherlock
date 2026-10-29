// ============================================================================
// VDR — emisión de grants de descarga (getDownloadUrl) fail-closed
// ============================================================================
// getDownloadUrl es el emisor de los grants de descarga del data room: si la
// policy no devuelve ALLOW debe devolver el resultado DENY estructurado SIN
// insertar en `documentAccessGrants` — y sin lanzar, porque en Convex un throw
// revierte la fila DENIED de auditoría recién insertada (#15). Un
// reordenamiento (deny después del insert) o un `=== 'DENY'` en vez de
// `!== 'ALLOW'` dejaría pasar a un inversionista sin NDA con la suite en verde.
// ============================================================================

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

vi.mock('../../../convex/_documents/shared', () => ({
  createDocumentAccessGrantToken: () => 'plain-token',
  hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
  recordDocumentAccessLog: (...args: unknown[]) => mockRecordDocumentAccessLog(...args),
  resolveDownloadAccess: (...args: unknown[]) => mockResolveDownloadAccess(...args),
  findDocumentByStorageId: vi.fn(async () => null),
  findDocumentByStoragePath: vi.fn(async () => null),
}))

vi.mock('../../../convex/_documents/deliverableVersion', () => ({
  loadDeliverablePublishedVersion: vi.fn(async (_ctx: unknown, document: { storageId?: string }) =>
    document?.storageId
      ? {
          _id: 'version_1',
          sha256: 'a'.repeat(64),
          storageId: document.storageId,
        }
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

import { consumeDownloadGrant, getDownloadUrl } from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>

const issue = (getDownloadUrl as unknown as { _handler: Handler })._handler
const consume = (consumeDownloadGrant as unknown as { _handler: Handler })._handler
const STORAGE_SECRET = 'document-delivery-secret-for-tests'

async function deliveryArgs(token: string, grantId = 'grant_1') {
  const deliveryIssuedAt = Date.now()
  return {
    deliveryIssuedAt,
    deliveryProof: await createDocumentDeliveryProof(STORAGE_SECRET, {
      grantId,
      token,
      profileId: 'profile_1',
      issuedAt: deliveryIssuedAt,
    }),
  }
}

const CONFIDENTIAL_DOCUMENT = {
  _id: 'document_1',
  companyId: 'company_1',
  storageId: 'storage_1',
  name: 'memo.pdf',
  fileType: 'application/pdf',
  accessLevel: 'NDA_REQUIRED',
}

const ALLOW = {
  decision: 'ALLOW',
  outcome: 'ALLOWED_CONFIDENTIAL',
  reason: 'Acceso autorizado por la policy del data room.',
  classification: 'CONFIDENTIAL',
  riskScore: 35,
  stepUpRequirement: 'NONE',
}

function createCtx(document: Record<string, unknown> | null = CONFIDENTIAL_DOCUMENT) {
  return {
    db: {
      get: vi.fn(async () => document),
      patch: vi.fn(),
      insert: vi.fn(async (_table: string, _doc: Record<string, unknown>) => 'grant_1'),
      query: vi.fn(() => ({
        withIndex: vi.fn().mockReturnThis(),
        collect: vi.fn().mockResolvedValue([]),
        take: vi.fn().mockResolvedValue([]),
      })),
    },
    scheduler: { runAfter: vi.fn() },
    storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/memo.pdf') },
  }
}

const grantInsertCalls = (ctx: ReturnType<typeof createCtx>) =>
  ctx.db.insert.mock.calls.filter((call) => call[0] === 'documentAccessGrants')

describe('getDownloadUrl: no emite grant sin ALLOW', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'true')
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockEnforceRateLimit.mockResolvedValue(undefined)
  })

  it('rechaza a un inversionista sin NDA y no inserta ningún grant', async () => {
    mockResolveDownloadAccess.mockResolvedValue({
      decision: 'REQUIRE_STEP_UP',
      outcome: 'REQUIRE_SIGNED_NDA',
      reason: 'Debes firmar un NDA activo antes de acceder.',
      classification: 'CONFIDENTIAL',
      riskScore: 35,
      stepUpRequirement: 'SIGNED_NDA',
    })
    const ctx = createCtx()

    // El deny se devuelve, no se lanza: así la fila DOWNLOAD_DENIED commitea.
    await expect(issue(ctx, { documentId: 'document_1' })).resolves.toEqual({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: expect.stringMatching(/NDA/i),
    })

    expect(grantInsertCalls(ctx)).toHaveLength(0)
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD_DENIED' })
    )
  })

  it('rechaza un documento privado (solo owner/admin)', async () => {
    mockResolveDownloadAccess.mockResolvedValue({
      decision: 'DENY',
      outcome: 'DENIED_PRIVATE_OWNER_ONLY',
      reason: 'Este documento es privado y solo el owner o admin puede acceder.',
      classification: 'RESTRICTED',
      riskScore: 65,
      stepUpRequirement: 'NONE',
    })
    const ctx = createCtx()

    await expect(issue(ctx, { documentId: 'document_1' })).resolves.toEqual({
      allowed: false,
      code: 'DENIED_PRIVATE_OWNER_ONLY',
      message: expect.stringMatching(/privado/i),
    })
    expect(grantInsertCalls(ctx)).toHaveLength(0)
  })

  it('emite un grant single-use con hash del token cuando la policy permite', async () => {
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
    const ctx = createCtx()
    const before = Date.now()

    const url = (await issue(ctx, { documentId: 'document_1' })) as string

    const [table, grant] = grantInsertCalls(ctx)[0]
    expect(table).toBe('documentAccessGrants')
    expect(grant.useCount).toBe(0)
    expect(grant.profileId).toBe('profile_1')
    expect(grant.tokenHash).toBe('hash:plain-token')
    expect(grant.tokenHash).not.toBe('plain-token')
    expect(grant).not.toHaveProperty('ipAddress')
    expect(grant).not.toHaveProperty('userAgent')
    expect(grant.expiresAt as number).toBeGreaterThan(before)
    expect(url).toContain('grant_1')
    expect(url).toContain('token=plain-token')
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD_GRANT_ISSUED' })
    )
    expect(mockRecordDocumentAccessLog.mock.calls.at(-1)?.[1]).not.toHaveProperty('ipAddress')
    expect(mockRecordDocumentAccessLog.mock.calls.at(-1)?.[1]).not.toHaveProperty('userAgent')
  })

  it('devuelve null y marca el documento expirado sin evaluar la policy', async () => {
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
    const ctx = createCtx({ ...CONFIDENTIAL_DOCUMENT, expiresAt: Date.now() - 1_000 })

    await expect(issue(ctx, { documentId: 'document_1' })).resolves.toBeNull()

    expect(ctx.db.patch).toHaveBeenCalledWith('document_1', { isExpired: true })
    expect(mockResolveDownloadAccess).not.toHaveBeenCalled()
    expect(grantInsertCalls(ctx)).toHaveLength(0)
  })

  it('no emite grant si el rate limit corta la petición', async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error('Límite de solicitudes excedido'))
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
    const ctx = createCtx()

    await expect(issue(ctx, { documentId: 'document_1' })).rejects.toThrow(/Límite/i)

    expect(grantInsertCalls(ctx)).toHaveLength(0)
    expect(mockRecordDocumentAccessLog).not.toHaveBeenCalled()
  })
})

describe('consumeDownloadGrant: validación de titular, token y policy vigente', () => {
  const baseGrant = {
    _id: 'grant_1',
    documentId: 'document_1',
    documentVersionId: 'version_1',
    documentSha256: 'a'.repeat(64),
    companyId: 'company_1',
    profileId: 'profile_1',
    tokenHash: 'hash:plain-token',
    expiresAt: Date.now() + 60_000,
    useCount: 0,
    accessLevel: 'NDA_REQUIRED',
    // La emisión persiste la clasificación EVALUADA (inferida para documentos
    // legados sin `classification`); el consumo compara contra esa inferencia.
    classification: 'CONFIDENTIAL',
  }

  function createConsumeCtx(grant: Record<string, unknown>) {
    return {
      db: {
        get: vi.fn(async (id: string) => (id === 'grant_1' ? grant : CONFIDENTIAL_DOCUMENT)),
        patch: vi.fn(),
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
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'true')
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rechaza un HMAC inválido aunque una variable legacy intente desactivar enforcement', async () => {
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'false')
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
        deliveryIssuedAt: Date.now(),
        deliveryProof: '0'.repeat(64),
      })
    ).rejects.toThrow(/Entrega documental no autorizada/i)

    expect(ctx.db.get).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('rechaza una llamada legacy cuando enforcement ya está activo', async () => {
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
      })
    ).rejects.toThrow(/Entrega documental no autorizada/i)

    expect(ctx.db.get).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('falla cerrado si el flag de rollout no está configurado explícitamente', async () => {
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', '')
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
      })
    ).rejects.toThrow(/Entrega documental no autorizada/i)

    expect(ctx.db.get).not.toHaveBeenCalled()
  })

  it('falla cerrado si enforcement está activo pero Convex no tiene el secreto', async () => {
    vi.stubEnv('STORAGE_SECRET', '')
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
        ...(await deliveryArgs('plain-token')),
      })
    ).rejects.toThrow(/Entrega documental no autorizada/i)

    expect(ctx.db.get).not.toHaveBeenCalled()
  })

  it('ignora el bypass legacy y exige siempre la prueba servidor-a-servidor', async () => {
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'false')
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
      })
    ).rejects.toThrow(/Entrega documental no autorizada/i)

    expect(ctx.db.get).not.toHaveBeenCalled()
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('rechaza un grant emitido para otro perfil', async () => {
    const ctx = createConsumeCtx({ ...baseGrant, profileId: 'profile_other' })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
        ...(await deliveryArgs('plain-token')),
      })
    ).rejects.toThrow(/Grant de acceso inválido/i)
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('rechaza un token que no corresponde al hash del grant', async () => {
    const ctx = createConsumeCtx({ ...baseGrant })

    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'otro-token',
        ...(await deliveryArgs('otro-token')),
      })
    ).rejects.toThrow(/Grant de acceso inválido/i)
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })

  it('rechaza si el NDA se revoca entre la emisión y el consumo', async () => {
    mockResolveDownloadAccess.mockResolvedValue({
      decision: 'REQUIRE_STEP_UP',
      outcome: 'REQUIRE_NDA_RENEWAL',
      reason: 'Tu NDA ha expirado y debe renovarse antes de acceder.',
      classification: 'CONFIDENTIAL',
      riskScore: 35,
      stepUpRequirement: 'RENEW_NDA',
    })
    const ctx = createConsumeCtx({ ...baseGrant })

    // El deny se devuelve, no se lanza: así la fila DOWNLOAD_DENIED commitea.
    await expect(
      consume(ctx, {
        grantId: 'grant_1',
        token: 'plain-token',
        ...(await deliveryArgs('plain-token')),
      })
    ).resolves.toEqual({
      allowed: false,
      code: expect.any(String),
      message: expect.stringMatching(/NDA/i),
    })

    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD_DENIED' })
    )
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  })
})
