// ============================================================================
// webhookEvents.getRecentEvents / getStats — índice, tope y proyección
// ============================================================================
// H7, H9 y H13 del informe A2 (cobertura 2026-09-11). Los tests corren el
// handler real sobre un harness con semántica de `withIndex` + `filter` +
// `order` + `take`, no sobre mocks que devuelven `this`.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuthAdmin: vi.fn(),
}))

import { getRecentEvents, getStats } from '../../../convex/webhookEvents'
import { requireAuthAdmin } from '../../../convex/_helpers/auth'
import { createConvexCtx, runHandler, type Row } from './nda-convex-harness'

const mockRequireAuthAdmin = vi.mocked(requireAuthAdmin)

type Provider = 'workos' | 'clerk'
type Status = 'completed' | 'failed' | 'processing'

function event(
  index: number,
  provider: Provider,
  status: Status,
  overrides: Record<string, unknown> = {}
): Row {
  return {
    _id: `webhookEvents_${index}`,
    _creationTime: index,
    provider,
    eventId: `evt_${index}`,
    eventType: 'user.updated',
    status,
    payload: { data: { id: `user_${index}`, email: '[redacted]' } },
    receivedAt: index,
    ...overrides,
  }
}

type RecentEvent = { eventId: string; provider: Provider; status: Status } & Record<string, unknown>

describe('convex/webhookEvents.ts getRecentEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthAdmin.mockResolvedValue({} as Awaited<ReturnType<typeof requireAuthAdmin>>)
  })

  it('devuelve la página completa cuando el filtro es selectivo, en orden descendente', async () => {
    // 40 eventos clerk completados delante y solo 5 workos fallidos, viejos:
    // el `take(limit * 2)` en memoria de antes devolvía cero con limit 3.
    const rows: Row[] = []
    for (let i = 1; i <= 5; i += 1) rows.push(event(i, 'workos', 'failed'))
    for (let i = 6; i <= 45; i += 1) rows.push(event(i, 'clerk', 'completed'))
    const ctx = createConvexCtx({ webhookEvents: rows })

    const result = await runHandler<Record<string, unknown>, RecentEvent[]>(getRecentEvents, ctx, {
      provider: 'workos',
      status: 'failed',
      limit: 3,
    })

    expect(result.map((row) => row.eventId)).toEqual(['evt_5', 'evt_4', 'evt_3'])
    expect(result.every((row) => row.provider === 'workos' && row.status === 'failed')).toBe(true)
  })

  it('filtra por estado solo con by_status y por proveedor solo con by_provider', async () => {
    const ctx = createConvexCtx({
      webhookEvents: [
        event(1, 'workos', 'completed'),
        event(2, 'clerk', 'failed'),
        event(3, 'workos', 'failed'),
      ],
    })

    const failed = await runHandler<Record<string, unknown>, RecentEvent[]>(getRecentEvents, ctx, {
      status: 'failed',
    })
    const workos = await runHandler<Record<string, unknown>, RecentEvent[]>(getRecentEvents, ctx, {
      provider: 'workos',
    })

    expect(failed.map((row) => row.eventId)).toEqual(['evt_3', 'evt_2'])
    expect(workos.map((row) => row.eventId)).toEqual(['evt_3', 'evt_1'])
  })

  it('nunca devuelve el payload al panel', async () => {
    const ctx = createConvexCtx({ webhookEvents: [event(1, 'workos', 'completed')] })

    const [row] = await runHandler<Record<string, unknown>, RecentEvent[]>(getRecentEvents, ctx, {})

    expect(row).not.toHaveProperty('payload')
    expect(row).toMatchObject({
      eventId: 'evt_1',
      provider: 'workos',
      eventType: 'user.updated',
      status: 'completed',
      receivedAt: 1,
    })
  })

  it('acota el límite que manda el cliente a 200 y cae a 50 sin valor', async () => {
    const rows: Row[] = []
    for (let i = 1; i <= 260; i += 1) rows.push(event(i, 'workos', 'completed'))
    const ctx = createConvexCtx({ webhookEvents: rows })

    const capped = await runHandler<Record<string, unknown>, RecentEvent[]>(getRecentEvents, ctx, {
      limit: 10_000,
    })
    const fallback = await runHandler<Record<string, unknown>, RecentEvent[]>(
      getRecentEvents,
      ctx,
      {}
    )

    expect(capped).toHaveLength(200)
    expect(fallback).toHaveLength(50)
  })

  it('rechaza a quien no es admin antes de leer', async () => {
    mockRequireAuthAdmin.mockRejectedValue(new Error('Se requiere rol de administrador'))
    const ctx = createConvexCtx({ webhookEvents: [event(1, 'workos', 'completed')] })

    await expect(runHandler(getRecentEvents, ctx, {})).rejects.toThrow(/administrador/)
    expect(ctx.db.query).not.toHaveBeenCalled()
  })
})

describe('convex/webhookEvents.ts getStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthAdmin.mockResolvedValue({} as Awaited<ReturnType<typeof requireAuthAdmin>>)
    vi.useFakeTimers({ now: 1_000 * 60 * 60 * 24 * 400, toFake: ['Date'] })
  })

  it('acota hoursBack a 30 días aunque el cliente pida más', async () => {
    const hour = 60 * 60 * 1_000
    const now = Date.now()
    const ctx = createConvexCtx({
      webhookEvents: [
        event(1, 'workos', 'completed', { receivedAt: now - 2 * hour }),
        event(2, 'workos', 'failed', { receivedAt: now - 20 * 24 * hour }),
        event(3, 'clerk', 'completed', { receivedAt: now - 60 * 24 * hour }),
      ],
    })

    const stats = await runHandler<
      { hoursBack?: number },
      { total: number; hoursBack: number; byStatus: Record<string, number> }
    >(getStats, ctx, { hoursBack: 10_000 })

    expect(stats.hoursBack).toBe(720)
    expect(stats.total).toBe(2)
    expect(stats.byStatus).toEqual({ completed: 1, failed: 1 })
  })
})
