// ============================================================================
// activityLogs.getStats — el día es el de Panamá, no UTC
// ============================================================================
// La serie del tablero (`convex/_analytics/series.ts`) ya cuenta por día de
// Panamá (UTC-5 fijo). getStats usaba `toISOString()` y partía el día en UTC:
// un evento a las 21:00 en Panamá caía en el día siguiente. Misma función
// `dayKey` que la serie.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getStats } from '../../../convex/activityLogs'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = Date.UTC(2026, 8, 11, 12)

type Stats = {
  totalActivities: number
  byType: Record<string, number>
  byDay: Record<string, number>
}

function identity(subject: string) {
  return { issuer: 'https://api.workos.com/', subject, email: `${subject}@example.com` }
}

function adminTables(activityLogs: Tables['activityLogs'] = []): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        _creationTime: 3,
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
    ],
    activityLogs,
  }
}

function run(tables: Tables, args: { days?: number } = {}) {
  return runHandler<{ days?: number }, Stats>(
    getStats,
    createConvexCtx(tables, { identity: identity('workos_admin') }),
    args
  )
}

describe('activityLogs.getStats', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Panamá va cinco horas detrás de UTC: un log a las 21:00 del 10 es de ese
  // día para el equipo, no del 11.
  it('buckets by the Panama day, not the UTC day', async () => {
    const result = await run(
      adminTables([{ _id: 'log_noche', _creationTime: Date.UTC(2026, 8, 11, 2), action: 'LOGIN' }])
    )

    expect(result.byDay['2026-09-10']).toBe(1)
    expect(result.byDay['2026-09-11']).toBeUndefined()
    expect(result.totalActivities).toBe(1)
    expect(result.byType.LOGIN).toBe(1)
  })
})
