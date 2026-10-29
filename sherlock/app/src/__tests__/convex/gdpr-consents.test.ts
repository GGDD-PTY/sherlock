// ============================================================================
// gdpr.ts — consentimientos: índice compuesto y frontera del cliente
// ============================================================================
// H5 y H14 del informe A2 (cobertura 2026-09-11). Handlers reales sobre el
// harness con semántica de índices; la suite vieja de gdpr.ts afirma sobre
// mocks que devuelven `this`.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../convex/_helpers/auth')>()
  return { ...actual, requireAuth: vi.fn() }
})

import { recordConsent, revokeConsent } from '../../../convex/gdpr'
import { requireAuth } from '../../../convex/_helpers/auth'
import { convexArgsValidator } from '../utils/convex-test-utils'
import { createConvexCtx, runHandler, type HarnessCtx, type Row } from './nda-convex-harness'

const mockRequireAuth = vi.mocked(requireAuth)
const OWNER = { _id: 'profiles_owner', role: 'COMPANY', userId: 'users_owner' }

function indexNamesUsed(ctx: HarnessCtx, table: string): string[] {
  return ctx.db.query.mock.calls.flatMap(([queried], position) => {
    if (queried !== table) return []
    const builder = ctx.db.query.mock.results[position]?.value as
      { withIndex: { mock: { calls: Array<[string]> } } } | undefined
    return builder?.withIndex.mock.calls.map(([name]) => name) ?? []
  })
}

describe('convex/gdpr.ts consentimientos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      identity: { subject: 'workos_owner' },
      user: { _id: OWNER.userId, email: 'owner@example.com' },
      profile: OWNER,
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)
  })

  it('cada tipo tiene su fila, revocar uno deja el otro intacto, y todo va por el índice compuesto', async () => {
    const ctx = createConvexCtx({ consents: [] })

    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'marketing_emails',
      accepted: true,
    })
    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'analytics_tracking',
      accepted: true,
    })
    await runHandler(revokeConsent, ctx, { profileId: OWNER._id, consentType: 'marketing_emails' })

    const byType = Object.fromEntries(
      ctx.tables.consents.map((row: Row) => [row.consentType, row.accepted])
    )
    expect(byType).toEqual({ marketing_emails: false, analytics_tracking: true })
    expect(new Set(indexNamesUsed(ctx, 'consents'))).toEqual(new Set(['by_profileId_consentType']))
  })

  it('re-registrar el mismo tipo actualiza la fila en vez de duplicarla', async () => {
    const ctx = createConvexCtx({ consents: [] })

    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'privacy_policy',
      accepted: true,
    })
    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'privacy_policy',
      accepted: false,
    })

    expect(ctx.tables.consents).toHaveLength(1)
    expect(ctx.tables.consents[0]).toMatchObject({ consentType: 'privacy_policy', accepted: false })
  })
})

describe('convex/gdpr.ts consentimientos — evidencia que no viene del cliente (H14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      identity: { subject: 'workos_owner' },
      user: { _id: OWNER.userId, email: 'owner@example.com' },
      profile: OWNER,
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)
  })

  it('no persiste ip ni user agent aunque el cliente los mande, y limpia los viejos al re-registrar', async () => {
    const ctx = createConvexCtx({
      consents: [
        {
          _id: 'consents_old',
          _creationTime: 1,
          profileId: OWNER._id,
          consentType: 'analytics_tracking',
          accepted: true,
          acceptedAt: 1,
          ipAddress: '203.0.113.9',
          userAgent: 'Mozilla/5.0',
        },
      ],
    })

    // El validador de Convex rechazaría los args extra en la frontera; el
    // handler crudo tiene que ignorarlos igual.
    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'marketing_emails',
      accepted: true,
      ipAddress: '198.51.100.7',
      userAgent: 'curl/8',
    })
    await runHandler(recordConsent, ctx, {
      profileId: OWNER._id,
      consentType: 'analytics_tracking',
      accepted: false,
    })

    const marketing = ctx.tables.consents.find((row) => row.consentType === 'marketing_emails')
    const analytics = ctx.tables.consents.find((row) => row._id === 'consents_old')
    expect(marketing).toMatchObject({ accepted: true })
    expect(marketing).not.toHaveProperty('ipAddress')
    expect(marketing).not.toHaveProperty('userAgent')
    expect(analytics).toMatchObject({ accepted: false })
    expect(analytics).not.toHaveProperty('ipAddress')
    expect(analytics).not.toHaveProperty('userAgent')
  })
})

describe('convex/gdpr.ts consentimientos — contrato de args en la frontera de Convex', () => {
  it('recordConsent ya no declara ipAddress ni userAgent', () => {
    // El harness salta el validador; este test lee el validador exportado, que
    // es lo que Convex aplica en producción.
    const validator = convexArgsValidator(recordConsent)
    expect(new Set(Object.keys(validator.value as Record<string, unknown>))).toEqual(
      new Set(['accepted', 'consentType', 'profileId'])
    )
  })
})
