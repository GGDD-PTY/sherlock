// ============================================================================
// notifications.ts — topes y uso de índices (H9, H10, H16 del informe A2)
// ============================================================================
// Handlers reales sobre el harness con semántica de `withIndex` + `take`. La
// suite vieja de notifications.ts afirma sobre mocks que devuelven `this`; esta
// afirma lo que el cliente recibe.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../convex/_helpers/auth')>()
  return { ...actual, requireAuth: vi.fn(), requireAuthAdmin: vi.fn() }
})

vi.mock('../../../convex/_helpers/auditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../convex/_helpers/auditLog')>()
  return { ...actual, logAdminAction: vi.fn().mockResolvedValue('adminAuditLogs_1') }
})

import {
  cleanupDuplicatePreferences,
  deleteReadNotifications,
  getNotifications,
  getUnreadCount,
  updatePreferences,
} from '../../../convex/notifications'
import { requireAuth, requireAuthAdmin } from '../../../convex/_helpers/auth'
import { logAdminAction } from '../../../convex/_helpers/auditLog'
import { createConvexCtx, runHandler, type HarnessCtx, type Row } from './nda-convex-harness'

const mockRequireAuth = vi.mocked(requireAuth)
const mockRequireAuthAdmin = vi.mocked(requireAuthAdmin)
const mockLogAdminAction = vi.mocked(logAdminAction)
const ADMIN = { _id: 'profiles_admin', role: 'ADMIN', userId: 'users_admin' }

const OWNER = { _id: 'profiles_owner', role: 'COMPANY', userId: 'users_owner' }
const OTHER = { _id: 'profiles_other', role: 'COMPANY', userId: 'users_other' }

function notification(index: number, userId: string, isRead: boolean): Row {
  return {
    _id: `notifications_${userId}_${index}`,
    _creationTime: index,
    userId,
    type: 'system',
    title: `Aviso ${index}`,
    message: 'cuerpo',
    isRead,
  }
}

function seedInbox(count: number, unreadEvery = 1): Row[] {
  const rows: Row[] = []
  for (let i = 1; i <= count; i += 1) rows.push(notification(i, OWNER._id, i % unreadEvery !== 0))
  rows.push(notification(9_999, OTHER._id, false))
  return rows
}

function indexNamesUsed(ctx: HarnessCtx, table: string): string[] {
  return ctx.db.query.mock.calls.flatMap(([queried], position) => {
    if (queried !== table) return []
    const builder = ctx.db.query.mock.results[position]?.value as
      { withIndex: { mock: { calls: Array<[string]> } } } | undefined
    return builder?.withIndex.mock.calls.map(([name]) => name) ?? []
  })
}

function asOwner() {
  mockRequireAuth.mockResolvedValue({
    identity: { subject: 'workos_owner' },
    user: { _id: OWNER.userId, email: 'owner@example.com' },
    profile: OWNER,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>)
}

describe('convex/notifications.ts getNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('acota el límite del cliente a 100 y cae a 20 sin valor', async () => {
    const ctx = createConvexCtx({ notifications: seedInbox(150) })

    const capped = await runHandler<Record<string, unknown>, Row[]>(getNotifications, ctx, {
      userId: OWNER._id,
      limit: 10_000,
    })
    const fallback = await runHandler<Record<string, unknown>, Row[]>(getNotifications, ctx, {
      userId: OWNER._id,
    })

    expect(capped).toHaveLength(100)
    expect(fallback).toHaveLength(20)
    expect(fallback[0]?._id).toBe('notifications_profiles_owner_150')
    expect(fallback.every((row) => row.userId === OWNER._id)).toBe(true)
  })

  it('solo no leídas va por by_userId_unread', async () => {
    const ctx = createConvexCtx({ notifications: seedInbox(30, 3) })

    const unread = await runHandler<Record<string, unknown>, Row[]>(getNotifications, ctx, {
      userId: OWNER._id,
      unreadOnly: true,
      limit: 5,
    })

    expect(unread).toHaveLength(5)
    expect(unread.every((row) => row.isRead === false)).toBe(true)
    expect(indexNamesUsed(ctx, 'notifications')).toEqual(['by_userId_unread'])
  })

  it('no deja leer la bandeja de otro perfil', async () => {
    const ctx = createConvexCtx({ notifications: seedInbox(3) })

    await expect(runHandler(getNotifications, ctx, { userId: OTHER._id })).rejects.toThrow(
      /permiso/
    )
  })
})

describe('convex/notifications.ts getUnreadCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('cuenta exacto por el índice, también por encima de 100', async () => {
    // Greptile en el PR #589: `useNotifications` dispara el toast cuando este
    // número sube y la página lo muestra como total; un tope lo congelaría.
    const small = createConvexCtx({ notifications: seedInbox(9, 3) })
    const large = createConvexCtx({ notifications: seedInbox(150) })

    const exact = await runHandler<Record<string, unknown>, number>(getUnreadCount, small, {
      userId: OWNER._id,
    })
    const beyondHundred = await runHandler<Record<string, unknown>, number>(getUnreadCount, large, {
      userId: OWNER._id,
    })

    // 9 avisos, no leído cada tercero: 3, 6 y 9. El de OTRO perfil no cuenta.
    expect(exact).toBe(3)
    expect(beyondHundred).toBe(150)
    expect(indexNamesUsed(large, 'notifications')).toEqual(['by_userId_unread'])
  })
})

describe('convex/notifications.ts deleteReadNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('borra solo las leídas del que llama, por el índice compuesto', async () => {
    const ctx = createConvexCtx({ notifications: seedInbox(9, 3) })

    const deleted = await runHandler<Record<string, never>, number>(
      deleteReadNotifications,
      ctx,
      {}
    )

    expect(deleted).toBe(6)
    expect(ctx.tables.notifications.map((row) => row._id)).toEqual([
      'notifications_profiles_owner_3',
      'notifications_profiles_owner_6',
      'notifications_profiles_owner_9',
      'notifications_profiles_other_9999',
    ])
    expect(indexNamesUsed(ctx, 'notifications')).toEqual(['by_userId_unread'])
  })
})

function asAdmin() {
  const session = {
    identity: { subject: 'workos_admin' },
    user: { _id: ADMIN.userId, email: 'fixture-14e4636f@example.com' },
    profile: ADMIN,
  }
  mockRequireAuth.mockResolvedValue(session as unknown as Awaited<ReturnType<typeof requireAuth>>)
  mockRequireAuthAdmin.mockResolvedValue(
    session as unknown as Awaited<ReturnType<typeof requireAuthAdmin>>
  )
}

describe('convex/notifications.ts preferencias — auditoría de admin (H13)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('un admin que cambia las preferencias de otro perfil deja rastro', async () => {
    asAdmin()
    const ctx = createConvexCtx({ notificationPreferences: [] })

    await runHandler(updatePreferences, ctx, { userId: OWNER._id, emailWeeklyDigest: false })

    expect(ctx.tables.notificationPreferences).toHaveLength(1)
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminProfileId: ADMIN._id,
        action: 'NOTIFICATION_PREFERENCES_UPDATE',
        targetType: 'PROFILE',
        targetId: OWNER._id,
        newValue: { emailWeeklyDigest: false },
      })
    )
  })

  it('el dueño cambiando las suyas no se audita', async () => {
    asOwner()
    const ctx = createConvexCtx({ notificationPreferences: [] })

    await runHandler(updatePreferences, ctx, { userId: OWNER._id, pushEnabled: true })

    expect(ctx.tables.notificationPreferences).toHaveLength(1)
    expect(mockLogAdminAction).not.toHaveBeenCalled()
  })

  it('la limpieza de duplicados registra cuántos consolidó y borró', async () => {
    asAdmin()
    const ctx = createConvexCtx({
      notificationPreferences: [
        { _id: 'prefs_a', _creationTime: 1, userId: OWNER._id, pushEnabled: false },
        { _id: 'prefs_b', _creationTime: 2, userId: OWNER._id, pushEnabled: true },
        { _id: 'prefs_c', _creationTime: 3, userId: OTHER._id, pushEnabled: true },
      ],
    })

    const result = await runHandler<
      Record<string, never>,
      { cleanedUsers: number; deletedDuplicates: number }
    >(cleanupDuplicatePreferences, ctx, {})

    expect(result).toMatchObject({ cleanedUsers: 1, deletedDuplicates: 1 })
    expect(ctx.tables.notificationPreferences.map((row) => row._id)).toEqual(['prefs_b', 'prefs_c'])
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'NOTIFICATION_PREFERENCES_CLEANUP',
        targetType: 'SYSTEM',
        newValue: { cleanedUsers: 1, deletedDuplicates: 1 },
      })
    )
  })
})
