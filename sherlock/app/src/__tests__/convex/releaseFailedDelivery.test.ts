// ============================================================================
// releaseFailedDelivery — convex/_documents/storage.ts
// ============================================================================
// `consumeDownloadGrant` quema el grant ANTES de que la ruta HTTP entregue los
// bytes. Cuando el watermark/proxy falla, esta mutation revierte el consumo —
// UNA vez por grant, con el mismo HMAC servidor-a-servidor que el consumo —
// y reetiqueta la fila de bitácora para que una entrega que nunca ocurrió no
// alimente la alarma de extracción masiva.
//
// El contrato clave es el candado: sin proof no libera, con proof de otro
// perfil no libera, dos veces no libera, y fuera de la ventana no libera.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

import { releaseFailedDelivery } from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'
import { hashDocumentAccessGrantToken } from '../../../convex/_documents/shared'

const STORAGE_SECRET = 'document-delivery-secret-for-tests'
const TOKEN = 'grant-token-secret'

const release = (
  releaseFailedDelivery as unknown as {
    _handler: (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>
  }
)._handler

async function releaseArgs(overrides: Record<string, unknown> = {}) {
  const releaseIssuedAt = Date.now()
  return {
    grantId: 'grant_1',
    token: TOKEN,
    releaseIssuedAt,
    releaseProof: await createDocumentDeliveryProof(STORAGE_SECRET, {
      grantId: 'grant_1',
      token: TOKEN,
      profileId: 'profile_1',
      issuedAt: releaseIssuedAt,
    }),
    ...overrides,
  }
}

type GrantRow = {
  _id: string
  documentId: string
  profileId: string
  tokenHash: string
  action?: 'VIEW' | 'DOWNLOAD'
  expiresAt: number
  useCount: number
  revokedAt?: number
  releasedAt?: number
  outcome?: string
}

async function createConsumedGrant(overrides: Partial<GrantRow> = {}): Promise<GrantRow> {
  return {
    _id: 'grant_1',
    documentId: 'document_1',
    profileId: 'profile_1',
    tokenHash: await hashDocumentAccessGrantToken(TOKEN),
    action: 'VIEW',
    expiresAt: Date.now() + 60_000,
    useCount: 1,
    revokedAt: Date.now() - 1_000,
    outcome: 'CONSUMED',
    ...overrides,
  }
}

function createCtx(grant: GrantRow, logs: Array<Record<string, unknown>> = []) {
  const patch = vi.fn()
  return {
    ctx: {
      db: {
        get: vi.fn(async (id: string) => (id === grant._id ? grant : null)),
        patch,
        query: vi.fn(() => ({
          withIndex: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          take: vi.fn().mockResolvedValue(logs),
        })),
      },
    },
    patch,
  }
}

describe('documents.releaseFailedDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reopens a freshly consumed grant exactly once and relabels its audit row', async () => {
    const grant = await createConsumedGrant()
    const deliveryLog = {
      _id: 'log_view',
      grantId: 'grant_1',
      action: 'VIEW',
      accessedAt: Date.now() - 1_000,
    }
    const { ctx, patch } = createCtx(grant, [deliveryLog])

    await expect(release(ctx, await releaseArgs())).resolves.toEqual({ released: true })

    expect(patch).toHaveBeenCalledWith(
      'grant_1',
      expect.objectContaining({
        revokedAt: undefined,
        outcome: 'DELIVERY_FAILED_RELEASED',
        releasedAt: expect.any(Number),
      })
    )
    // La fila de bitácora deja de contar como VIEW entregado: nunca hubo bytes.
    expect(patch).toHaveBeenCalledWith('log_view', {
      action: 'VIEW_DELIVERY_FAILED',
      outcome: 'DELIVERY_FAILED',
    })
  })

  it('refuses without a valid server proof', async () => {
    const grant = await createConsumedGrant()
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs({ releaseProof: 'f'.repeat(64) }))).rejects.toThrow(
      /no autorizada/i
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('fails closed when STORAGE_SECRET is not configured', async () => {
    vi.stubEnv('STORAGE_SECRET', '')
    const grant = await createConsumedGrant()
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/no autorizada/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('refuses a grant that belongs to another profile', async () => {
    const grant = await createConsumedGrant({ profileId: 'profile_other' })
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/inválido/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('refuses a mismatched token even with a valid proof shape', async () => {
    const grant = await createConsumedGrant({
      tokenHash: await hashDocumentAccessGrantToken('otro-token'),
    })
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/inválido/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('releases only once per grant', async () => {
    const grant = await createConsumedGrant({ releasedAt: Date.now() - 500 })
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/ya fue liberado/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('refuses a grant that was never consumed', async () => {
    const grant = await createConsumedGrant({ revokedAt: undefined, outcome: undefined })
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/no está en estado consumido/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('refuses once the release window has passed', async () => {
    const grant = await createConsumedGrant({ revokedAt: Date.now() - 6 * 60 * 1000 })
    const { ctx, patch } = createCtx(grant)

    await expect(release(ctx, await releaseArgs())).rejects.toThrow(/ventana de liberación/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('still releases the grant when no matching audit row is found', async () => {
    const grant = await createConsumedGrant()
    const { ctx, patch } = createCtx(grant, [])

    await expect(release(ctx, await releaseArgs())).resolves.toEqual({ released: true })
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith(
      'grant_1',
      expect.objectContaining({ releasedAt: expect.any(Number) })
    )
  })
})
