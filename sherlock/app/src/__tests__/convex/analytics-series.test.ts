// ============================================================================
// SERIES DIARIAS DEL TABLERO (analyticsSeries)
// ============================================================================
// Contratos: (0) el día es el de Panamá, UTC-5 fijo; (1) solo ADMIN lee la
// serie; (2) la ventana son 30 días completos,
// con cero donde no hubo filas; (3) lo anterior a la ventana no entra —el corte
// lo hace el índice `by_creation_time`, no un filtro en memoria; (4)
// `diasConDatos` cuenta los días que de verdad tienen filas, que es lo que
// decide si el tablero dibuja el gráfico o la tabla.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getActivityDaily,
  getDocumentsDaily,
  getIntakeDaily,
} from '../../../convex/analyticsSeries'
import { SERIES_SCAN_CAP } from '../../../convex/_analytics/series'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const DAY = 24 * 60 * 60 * 1000
// Mediodía UTC: la clave del día no depende de la hora de la corrida.
const NOW = Date.UTC(2026, 8, 11, 12)

type DailySeries = {
  dias: Array<{ fecha: string; valor: number }>
  diasConDatos: number
  truncado: boolean
}

function identity(subject: string) {
  return { issuer: 'https://api.workos.com/', subject, email: `${subject}@example.com` }
}

function seed(): Tables {
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
      {
        _id: 'user_company',
        _creationTime: 2,
        authProvider: 'workos',
        providerUserId: 'workos_company',
        workosUserId: 'workos_company',
        email: 'company@example.com',
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
      {
        _id: 'profile_company',
        _creationTime: 4,
        userId: 'user_company',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    documents: [
      { _id: 'doc_1', _creationTime: NOW, companyId: 'company_1' },
      { _id: 'doc_2', _creationTime: NOW - 60_000, companyId: 'company_1' },
      { _id: 'doc_3', _creationTime: NOW - 5 * DAY, companyId: 'company_1' },
      // Fuera de la ventana de 30 días: no puede aparecer en ningún día.
      { _id: 'doc_4', _creationTime: NOW - 40 * DAY, companyId: 'company_1' },
    ],
    intakeSessions: [{ _id: 'intake_1', _creationTime: NOW - 2 * DAY, status: 'ACTIVE' }],
    activityLogs: [
      { _id: 'log_1', _creationTime: NOW - DAY, action: 'LOGIN' },
      { _id: 'log_2', _creationTime: NOW - DAY, action: 'DOCUMENT_VIEWED' },
    ],
  }
}

function run(fn: unknown, tables: Tables, subject = 'workos_admin') {
  return runHandler<Record<string, never>, DailySeries>(
    fn,
    createConvexCtx(tables, { identity: identity(subject) }),
    {}
  )
}

describe('analyticsSeries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns thirty whole days, zero-filled, ending today', async () => {
    const result = await run(getDocumentsDaily, seed())

    expect(result.dias).toHaveLength(30)
    expect(result.dias[0]).toEqual({ fecha: '2026-08-13', valor: 0 })
    expect(result.dias.at(-1)).toEqual({ fecha: '2026-09-11', valor: 2 })
    expect(result.dias.find((dia) => dia.fecha === '2026-09-06')).toEqual({
      fecha: '2026-09-06',
      valor: 1,
    })
  })

  it('counts only the days that have rows', async () => {
    const result = await run(getDocumentsDaily, seed())

    expect(result.diasConDatos).toBe(2)
    expect(result.dias.reduce((total, dia) => total + dia.valor, 0)).toBe(3)
  })

  it('leaves rows older than the window out of every day', async () => {
    const result = await run(getDocumentsDaily, seed())

    expect(result.dias.some((dia) => dia.fecha < '2026-08-13')).toBe(false)
    expect(result.dias.reduce((total, dia) => total + dia.valor, 0)).toBe(3)
  })

  it('reads intake sessions and activity with the same window', async () => {
    const intake = await run(getIntakeDaily, seed())
    const activity = await run(getActivityDaily, seed())

    expect(intake.diasConDatos).toBe(1)
    expect(intake.dias.find((dia) => dia.fecha === '2026-09-09')?.valor).toBe(1)
    expect(activity.diasConDatos).toBe(1)
    expect(activity.dias.find((dia) => dia.fecha === '2026-09-10')?.valor).toBe(2)
  })

  // Panamá va cinco horas detrás de UTC: un archivo subido a las 9 de la noche
  // es de ese día para el equipo, no del siguiente.
  it('buckets by the Panama day, not the UTC day', async () => {
    const tables = seed()
    tables.documents = [
      { _id: 'doc_noche', _creationTime: Date.UTC(2026, 8, 11, 2), companyId: 'company_1' },
    ]

    const result = await run(getDocumentsDaily, tables)

    expect(result.dias.find((dia) => dia.fecha === '2026-09-10')?.valor).toBe(1)
    expect(result.dias.find((dia) => dia.fecha === '2026-09-11')?.valor).toBe(0)
  })

  it('reads the whole window without claiming truncation', async () => {
    const result = await run(getDocumentsDaily, seed())

    expect(result.truncado).toBe(false)
  })

  // Al techo se pierden los días más viejos de la ventana, que quedarían en cero
  // sin avisar: la serie tiene que decir que es un mínimo.
  it('says it truncated when the window has more rows than the cap', async () => {
    const tables = seed()
    tables.documents = Array.from({ length: SERIES_SCAN_CAP + 1 }, (_, index) => ({
      _id: `doc_bulk_${index}`,
      _creationTime: NOW - (index % 30) * DAY,
      companyId: 'company_1',
    }))

    const result = await run(getDocumentsDaily, tables)

    expect(result.truncado).toBe(true)
  })

  it('refuses a non-admin profile', async () => {
    await expect(run(getDocumentsDaily, seed(), 'workos_company')).rejects.toThrow(
      /Solo administradores/
    )
  })
})
