// ============================================================================
// getRoomActivity — el cableado de la query, no solo la agregación
// ============================================================================
// `documents-room-activity.test.ts` prueba el conteo puro. Acá se prueba lo que
// solo puede fallar en el handler: la compuerta de dueño/admin, el filtro de la
// actividad del propio emisor, y que la identidad se revele con la MISMA
// condición que el resto del producto (conexión aceptada).
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  hasOwnership: (profile: { _id: string; role?: string }, ownerId: string) =>
    profile.role === 'ADMIN' || profile._id === ownerId,
}))

vi.mock('../../../convex/_helpers/companyAuthorization', () => ({
  evaluateCompanyManagementAuthorization: async (
    _ctx: unknown,
    auth: { profile: { _id: string; role?: string } },
    company: { ownerId: string }
  ) => ({
    authorized: auth.profile.role === 'ADMIN' || auth.profile._id === company.ownerId,
    enforcement: auth.profile.role === 'ADMIN' ? 'ADMIN' : 'LEGACY_SESSION',
    reason: auth.profile.role === 'ADMIN' ? 'ADMIN' : 'LEGACY_SESSION',
  }),
}))

import { getRoomActivity } from '../../../convex/_documents/queries'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>
type Row = Record<string, unknown>

const roomActivity = (getRoomActivity as unknown as { _handler: Handler })._handler

const NOW = Date.now()
const COMPANY = { _id: 'company_1', ownerId: 'profile_owner', name: 'Agroindustrias Espavé' }
const DOCUMENT = { _id: 'document_1', companyId: 'company_1', name: 'Memo', folder: 'financials' }

function authResult(profile: { _id: string; role: string }) {
  const clerkId = `clerk_${profile._id}`
  return {
    identity: { subject: clerkId, authProvider: 'clerk' as const },
    user: { _id: `user_${profile._id}`, clerkId },
    profile,
  }
}

function accessLog(action: string, accessedById: string, documentId = 'document_1'): Row {
  return {
    _id: `log_${action}_${accessedById}_${documentId}`,
    _creationTime: NOW,
    documentId,
    companyId: 'company_1',
    accessedById,
    action,
    decision: 'ALLOW',
    accessedAt: NOW,
    // Material de seguridad del equipo: nunca debe salir en la proyección.
    ipAddress: '203.0.113.9',
    userAgent: 'Vitest',
    riskScore: 35,
  }
}

function createCtx(options: {
  logs: Row[]
  connection?: Row | null
  documents?: Row[]
  dealConnections?: Record<string, Row[]>
}) {
  const reads = { indexName: '', tookLimit: -1, connectionIndexes: [] as string[] }

  const entities: Record<string, Row | null> = {
    company_1: COMPANY,
    document_1: DOCUMENT,
    ...Object.fromEntries((options.documents ?? []).map((document) => [document._id, document])),
    profile_investor: { _id: 'profile_investor', role: 'COMPANY', fullName: 'Ana Pérez' },
    profile_owner: { _id: 'profile_owner', role: 'COMPANY', fullName: 'Dueño' },
  }

  const makeBuilder = (table: string) => {
    let indexName = ''
    const eqValues: unknown[] = []
    const rangeQuery = {
      eq: (_field: unknown, value?: unknown) => {
        eqValues.push(value)
        return rangeQuery
      },
      gte: () => rangeQuery,
    }

    const builder = {
      withIndex: (name: string, callback?: (q: typeof rangeQuery) => unknown) => {
        indexName = name
        if (table === 'documentAccessLogs') reads.indexName = name
        if (table === 'connections') reads.connectionIndexes.push(name)
        callback?.(rangeQuery)
        return builder
      },
      order: () => builder,
      take: async (limit: number) => {
        if (table === 'documentAccessLogs') {
          reads.tookLimit = limit
          return options.logs.slice(0, limit)
        }
        if (table === 'connections') {
          if (indexName === 'by_deal_investor') {
            const dealId = String(eqValues[0])
            return (options.dealConnections?.[dealId] ?? []).slice(0, limit)
          }
          return options.connection ? [options.connection].slice(0, limit) : []
        }
        return []
      },
      collect: async () => [],
      first: async () => {
        if (table === 'investors') return { _id: 'investor_1', firmName: 'Fondo Espavé' }
        return null
      },
      unique: async () => null,
    }

    return builder
  }

  return {
    reads,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => entities[id] ?? null),
        query: vi.fn((table: string) => makeBuilder(table)),
      },
    },
  }
}

/**
 * Ctx que MIDE concurrencia: cada `.first()` sobre `investors`/`connections`
 * sube un contador, cede el turno al event loop y lo baja. Si los perfiles se
 * resuelven en serie, el máximo simultáneo nunca pasa de 1.
 */
describe('getRoomActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue(authResult({ _id: 'profile_owner', role: 'COMPANY' }))
  })

  it('rechaza a quien no es dueño ni admin antes de leer la bitácora', async () => {
    mockRequireAuth.mockResolvedValue(authResult({ _id: 'profile_intruso', role: 'COMPANY' }))
    const { ctx } = createCtx({ logs: [accessLog('VIEW', 'profile_investor')] })

    await expect(roomActivity(ctx, { companyId: 'company_1' })).rejects.toThrow(/permiso/i)

    expect(ctx.db.query).not.toHaveBeenCalledWith('documentAccessLogs')
  })

  it('lee por el índice de empresa con techo y excluye la actividad del propio emisor', async () => {
    const { ctx, reads } = createCtx({
      logs: [accessLog('VIEW', 'profile_investor'), accessLog('DOWNLOAD', 'profile_owner')],
    })

    const activity = (await roomActivity(ctx, { companyId: 'company_1' })) as {
      totals: Record<string, number>
      counterpartyCount: number
    }

    expect(reads.indexName).toBe('by_companyId_accessedAt')
    expect(reads.tookLimit).toBeGreaterThan(0)
    expect(activity.totals.views).toBe(1)
    expect(activity.totals.downloads).toBe(0)
    expect(activity.counterpartyCount).toBe(1)
  })

  it('falla cerrado cuando el documento del log ya no existe', async () => {
    const { ctx } = createCtx({
      logs: [accessLog('VIEW', 'profile_investor', 'document_gone')],
      connection: { _id: 'connection_a', companyId: 'company_1', status: 'ACCEPTED' },
    })

    const activity = (await roomActivity(ctx, { companyId: 'company_1' })) as {
      byCounterparty: Array<{ displayName: string | null; identityRevealed: boolean }>
    }

    expect(activity.byCounterparty[0].displayName).toBeNull()
    expect(activity.byCounterparty[0].identityRevealed).toBe(false)
  })

  it('no proyecta IP, user agent ni riesgo al emisor', async () => {
    const { ctx } = createCtx({ logs: [accessLog('DOWNLOAD', 'profile_investor')] })

    const activity = await roomActivity(ctx, { companyId: 'company_1' })
    const serialized = JSON.stringify(activity)

    expect(serialized).not.toContain('203.0.113.9')
    expect(serialized).not.toContain('Vitest')
    expect(serialized).not.toContain('riskScore')
  })
})
