// ============================================================================
// CRON cleanupOldData — RANGO POR ÍNDICE, NO FULL-TABLE SCAN
// ============================================================================
// cleanupOldData purgaba notifications/documentAccessLogs/activityLogs con
// `.filter(...).take(100)` SIN `withIndex`: Convex evalúa el predicado fila
// por fila sobre TODA la tabla y solo después recorta a 100 resultados — el
// costo escala con el tamaño de la tabla, no con el trabajo real (filas
// vencidas). El corte en las tres es por `_creationTime`, así que el índice
// implícito `by_creation_time` acota el escaneo al rango < cutoff antes de
// aplicar cualquier filtro adicional (isRead en notifications).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupOldData } from '../../../convex/cronHandlers'
import {
  createConvexCtx,
  runHandler,
  type HarnessCtx,
  type Row,
  type Tables,
} from './nda-convex-harness'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

type QueryBuilderMock = {
  withIndex: { mock: { calls: unknown[][] } }
  filter: { mock: { calls: unknown[][] } }
  collect: { mock: { calls: unknown[] } }
  take: { mock: { calls: unknown[] } }
}

function queryCallsFor(ctx: HarnessCtx, table: string): QueryBuilderMock[] {
  return ctx.db.query.mock.calls
    .map((call: unknown[], index: number) => ({
      table: call[0],
      builder: ctx.db.query.mock.results[index]?.value,
    }))
    .filter((entry: { table: unknown }) => entry.table === table)
    .map((entry: { builder: unknown }) => entry.builder as QueryBuilderMock)
}

function seed(): Tables {
  return {
    notifications: [
      {
        _id: 'notif_old_read',
        _creationTime: NOW - 60 * DAY_MS,
        isRead: true,
        userId: 'u1',
        type: 'system',
        title: 't',
        message: 'm',
        link: '/x',
      },
      {
        _id: 'notif_old_unread',
        _creationTime: NOW - 60 * DAY_MS,
        isRead: false,
        userId: 'u1',
        type: 'system',
        title: 't',
        message: 'm',
        link: '/x',
      },
      {
        _id: 'notif_new_read',
        _creationTime: NOW - DAY_MS,
        isRead: true,
        userId: 'u1',
        type: 'system',
        title: 't',
        message: 'm',
        link: '/x',
      },
    ],
    documentAccessLogs: [
      {
        _id: 'log_old',
        _creationTime: NOW - 6 * 365 * DAY_MS,
        documentId: 'doc_1',
        accessedById: 'profile_1',
      },
      {
        _id: 'log_new',
        _creationTime: NOW - DAY_MS,
        documentId: 'doc_1',
        accessedById: 'profile_1',
      },
    ],
    activityLogs: [
      { _id: 'activity_old', _creationTime: NOW - 6 * 365 * DAY_MS, action: 'LOGIN' },
      { _id: 'activity_new', _creationTime: NOW - DAY_MS, action: 'LOGIN' },
    ],
    serverErrorAlerts: [
      {
        _id: 'alert_old',
        _creationTime: NOW - 200 * DAY_MS,
        openedAt: NOW - 200 * DAY_MS,
        dedupeKey: '/api/x|Error',
      },
      {
        _id: 'alert_new',
        _creationTime: NOW - DAY_MS,
        openedAt: NOW - DAY_MS,
        dedupeKey: '/api/x|Error',
      },
    ],
  }
}

describe('cronHandlers.cleanupOldData — rango por índice, no full scan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('usa el índice implícito by_creation_time en las tres tablas (no un .filter() sin índice)', async () => {
    const ctx = createConvexCtx(seed())
    await runHandler(cleanupOldData, ctx, {})

    for (const table of ['notifications', 'documentAccessLogs', 'activityLogs']) {
      const [builder] = queryCallsFor(ctx, table)
      expect(builder.withIndex.mock.calls.length).toBeGreaterThan(0)
      expect(builder.withIndex.mock.calls[0][0]).toBe('by_creation_time')
      expect(builder.take.mock.calls.length).toBeGreaterThan(0)
    }
  })

  it('borra solo las notificaciones leídas Y vencidas — deja intacta la no leída vieja y la leída reciente', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    await runHandler(cleanupOldData, ctx, {})

    const ids = tables.notifications.map((row) => row._id)
    expect(ids).not.toContain('notif_old_read')
    expect(ids).toContain('notif_old_unread')
    expect(ids).toContain('notif_new_read')
  })

  it('borra los access logs y activity logs vencidos, deja los recientes', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    await runHandler(cleanupOldData, ctx, {})

    expect(tables.documentAccessLogs.map((row) => row._id)).toEqual(['log_new'])
    expect(tables.activityLogs.map((row) => row._id)).toEqual(['activity_new'])
  })

  // La ventana de 15 minutos acota cuántas filas ESCRIBE una tormenta de 5xx;
  // nada acotaba cuántas se quedan. Sin esta poda `serverErrorAlerts` era la
  // única tabla de avisos que crecía para siempre.
  it('poda las alertas de 5xx vencidas por openedAt y deja las recientes', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    await runHandler(cleanupOldData, ctx, {})

    expect(tables.serverErrorAlerts.map((row) => row._id)).toEqual(['alert_new'])
    const [builder] = queryCallsFor(ctx, 'serverErrorAlerts')
    expect(builder.withIndex.mock.calls[0][0]).toBe('by_openedAt')
    expect(builder.take.mock.calls.length).toBeGreaterThan(0)
  })

  it('acota la poda de alertas de 5xx a 100 por corrida', async () => {
    const manyOld: Row[] = Array.from({ length: 150 }, (_, i) => ({
      _id: `alert_${i}`,
      _creationTime: NOW - 200 * DAY_MS - i,
      openedAt: NOW - 200 * DAY_MS - i,
      dedupeKey: '/api/x|Error',
    }))
    const tables: Tables = {
      notifications: [],
      documentAccessLogs: [],
      activityLogs: [],
      serverErrorAlerts: manyOld,
    }
    const ctx = createConvexCtx(tables)
    await runHandler(cleanupOldData, ctx, {})

    expect(tables.serverErrorAlerts.length).toBe(50)
  })

  it('acota a 100 por corrida — la próxima corrida procesa el resto', async () => {
    const manyOldRead: Row[] = Array.from({ length: 150 }, (_, i) => ({
      _id: `notif_${i}`,
      _creationTime: NOW - 60 * DAY_MS - i,
      isRead: true,
      userId: 'u1',
      type: 'system',
      title: 't',
      message: 'm',
      link: '/x',
    }))
    const tables: Tables = { notifications: manyOldRead, documentAccessLogs: [], activityLogs: [] }
    const ctx = createConvexCtx(tables)
    const result = await runHandler<Record<string, never>, { deletedCount: number }>(
      cleanupOldData,
      ctx,
      {}
    )

    expect(result.deletedCount).toBe(100)
    expect(tables.notifications.length).toBe(50)
  })
})
