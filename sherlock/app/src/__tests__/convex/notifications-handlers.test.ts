import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../convex/_helpers/auth')>()
  return { ...actual, requireAuth: vi.fn(), requireAuthAdmin: vi.fn() }
})

vi.mock('../../../convex/email', () => ({
  sendTeamAlertEmail: vi.fn(async () => {
    /* Resend stays out of this test */
  }),
  sendServerErrorAlertEmail: vi.fn(async () => {
    /* Resend stays out of this test */
  }),
  isProductEmailEnabled: () => false,
}))

import type { EmailEvent, EmailId } from '@convex-dev/resend'

import { requireAuth } from '../../../convex/_helpers/auth'
import {
  _attachCompanyToIntakeAlert,
  _dispatchTeamAlertEmail,
  _recordCompanyWorkspaceCreated,
  _recordEmailFailure,
  _recordIntakeUpload,
  _recordServerError,
  _recordVdrUpload,
  deleteNotification,
  getPreferences,
  markAllAsRead,
  markAsRead,
  updatePreferences,
} from '../../../convex/notifications'
import { createConvexCtx, runHandler, type Row } from './nda-convex-harness'

const mockRequireAuth = vi.mocked(requireAuth)

const OWNER = { _id: 'profiles_owner', role: 'COMPANY', userId: 'users_owner' }
const OTHER = { _id: 'profiles_other', role: 'COMPANY', userId: 'users_other' }
const ADMIN = { _id: 'profiles_admin', role: 'ADMIN', userId: 'users_admin', isActive: true }

function asOwner() {
  mockRequireAuth.mockResolvedValue({
    identity: { subject: 'workos_owner' },
    user: { _id: OWNER.userId, email: 'fixture-befbb74d@example.com' },
    profile: OWNER,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>)
}

function notification(id: string, userId: string, isRead: boolean): Row {
  return {
    _id: id,
    _creationTime: 1,
    userId,
    type: 'system',
    title: id,
    message: 'cuerpo',
    isRead,
  }
}

describe('notifications.markAsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('marks the caller own unread notice and collapses a missing id to 403', async () => {
    const ctx = createConvexCtx({
      notifications: [
        notification('notice_own', OWNER._id, false),
        notification('notice_other', OTHER._id, false),
      ],
    })

    await expect(runHandler(markAsRead, ctx, { notificationId: 'notice_missing' })).rejects.toThrow(
      /propias notificaciones/
    )
    await expect(runHandler(markAsRead, ctx, { notificationId: 'notice_other' })).rejects.toThrow(
      /propias notificaciones/
    )

    const ok = await runHandler(markAsRead, ctx, { notificationId: 'notice_own' })
    expect(ok).toBe(true)
    expect(ctx.tables.notifications.find((row) => row._id === 'notice_own')?.isRead).toBe(true)
    expect(ctx.tables.notifications.find((row) => row._id === 'notice_other')?.isRead).toBe(false)
  })
})

describe('notifications.markAllAsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('marks only the caller unread notices', async () => {
    const ctx = createConvexCtx({
      notifications: [
        notification('own_unread', OWNER._id, false),
        notification('own_read', OWNER._id, true),
        notification('other_unread', OTHER._id, false),
      ],
    })

    const count = await runHandler<Record<string, never>, number>(markAllAsRead, ctx, {})

    expect(count).toBe(1)
    expect(ctx.tables.notifications.find((row) => row._id === 'own_unread')?.isRead).toBe(true)
    expect(ctx.tables.notifications.find((row) => row._id === 'other_unread')?.isRead).toBe(false)
  })
})

describe('notifications.deleteNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('deletes the caller notice and hides a missing id behind the same 403', async () => {
    const ctx = createConvexCtx({
      notifications: [
        notification('notice_own', OWNER._id, false),
        notification('notice_other', OTHER._id, false),
      ],
    })

    await expect(
      runHandler(deleteNotification, ctx, { notificationId: 'notice_missing' })
    ).rejects.toThrow(/permiso/)
    await expect(
      runHandler(deleteNotification, ctx, { notificationId: 'notice_other' })
    ).rejects.toThrow(/permiso/)

    const ok = await runHandler(deleteNotification, ctx, { notificationId: 'notice_own' })
    expect(ok).toBe(true)
    expect(ctx.tables.notifications.map((row) => row._id)).toEqual(['notice_other'])
  })
})

describe('notifications.getPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('returns defaults when the caller has never saved, and the stored row otherwise', async () => {
    const empty = createConvexCtx({ notificationPreferences: [] })
    const stored = createConvexCtx({
      notificationPreferences: [
        {
          _id: 'prefs_owner',
          userId: OWNER._id,
          emailWeeklyDigest: true,
          pushEnabled: false,
        },
      ],
    })

    const defaults = await runHandler(getPreferences, empty, { userId: OWNER._id })
    const saved = await runHandler(getPreferences, stored, { userId: OWNER._id })

    expect(defaults).toEqual({
      emailNewConnection: true,
      emailNewMessage: true,
      emailRoomUpdates: true,
      emailWeeklyDigest: false,
      emailAnalysisComplete: true,
      pushEnabled: true,
    })
    expect(saved).toMatchObject({ emailWeeklyDigest: true, pushEnabled: false })
    await expect(runHandler(getPreferences, empty, { userId: OTHER._id })).rejects.toThrow(
      /permiso/
    )
  })
})

describe('notifications.updatePreferences consolidates duplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asOwner()
  })

  it('patches the newest row and deletes the older ones', async () => {
    const ctx = createConvexCtx({
      notificationPreferences: [
        {
          _id: 'prefs_old',
          _creationTime: 1,
          userId: OWNER._id,
          emailWeeklyDigest: true,
          pushEnabled: false,
        },
        {
          _id: 'prefs_new',
          _creationTime: 2,
          userId: OWNER._id,
          emailNewMessage: false,
        },
      ],
    })

    const id = await runHandler(updatePreferences, ctx, {
      userId: OWNER._id,
      pushEnabled: true,
    })

    expect(id).toBe('prefs_new')
    expect(ctx.tables.notificationPreferences).toHaveLength(1)
    expect(ctx.tables.notificationPreferences[0]).toMatchObject({
      _id: 'prefs_new',
      emailWeeklyDigest: true,
      emailNewMessage: false,
      pushEnabled: true,
    })
  })

  it('patches the single existing row', async () => {
    const ctx = createConvexCtx({
      notificationPreferences: [
        { _id: 'prefs_one', _creationTime: 1, userId: OWNER._id, pushEnabled: true },
      ],
    })

    const id = await runHandler(updatePreferences, ctx, {
      userId: OWNER._id,
      emailWeeklyDigest: true,
    })

    expect(id).toBe('prefs_one')
    expect(ctx.tables.notificationPreferences[0]).toMatchObject({
      emailWeeklyDigest: true,
      pushEnabled: true,
    })
  })
})

function teamSeed() {
  return {
    profiles: [
      { _id: ADMIN._id, userId: ADMIN.userId, role: 'ADMIN', isActive: true },
      { _id: OWNER._id, userId: OWNER.userId, role: 'COMPANY', isActive: true },
    ],
    users: [
      { _id: ADMIN.userId, email: 'fixture-14e4636f@example.com' },
      { _id: OWNER.userId, email: 'fixture-befbb74d@example.com' },
    ],
    companies: [{ _id: 'company_sampleenergy', ownerId: OWNER._id, name: 'Sample Hydro' }],
    intakeSessions: [
      {
        _id: 'intake_1',
        identityEvidence: { name: 'Sample Hydro' },
      },
    ],
    notifications: [],
    teamAlerts: [],
    activityLogs: [],
    serverErrorAlerts: [],
  }
}

describe('notifications team-alert wrappers', () => {
  it('opens a VDR batch, then a workspace batch, and dispatches one email', async () => {
    const ctx = createConvexCtx(teamSeed())

    await runHandler(_recordVdrUpload, ctx, {
      companyId: 'company_sampleenergy',
      fileName: 'estados.pdf',
      folder: 'Financieros',
    })
    await runHandler(_recordCompanyWorkspaceCreated, ctx, { companyId: 'company_sampleenergy' })

    expect(new Set(ctx.tables.teamAlerts.map((row) => row.batchKey))).toEqual(
      new Set(['vdr:company_sampleenergy', 'workspace:company_sampleenergy'])
    )
    expect(ctx.tables.notifications.length).toBeGreaterThan(0)

    const vdrAlert = ctx.tables.teamAlerts.find((row) => row.batchKey === 'vdr:company_sampleenergy')
    await runHandler(_dispatchTeamAlertEmail, ctx, { alertId: vdrAlert?._id })
    expect(vdrAlert?.emailDispatchedAt).toEqual(expect.any(Number))
  })

  it('records an intake upload and re-points the alert after the claim', async () => {
    const ctx = createConvexCtx(teamSeed())

    await runHandler(_recordIntakeUpload, ctx, {
      intakeSessionId: 'intake_1',
      fileName: 'teaser.pdf',
    })
    await runHandler(_attachCompanyToIntakeAlert, ctx, {
      intakeSessionId: 'intake_1',
      companyId: 'company_sampleenergy',
    })

    const alert = ctx.tables.teamAlerts.find((row) => row.batchKey === 'intake:intake_1')
    expect(alert).toMatchObject({
      companyId: 'company_sampleenergy',
      link: '/admin/companies/company_sampleenergy/documents',
    })
  })
})

describe('notifications observability wrappers', () => {
  it('turns a 5xx into a campanita for every live admin', async () => {
    const ctx = createConvexCtx(teamSeed())

    await runHandler(_recordServerError, ctx, {
      route: '/es/my-company/documents',
      errorName: 'TypeError',
      status: 500,
      message: 'Cannot read properties of undefined',
      requestId: 'req_1',
      method: 'GET',
    })

    expect(ctx.tables.notifications.some((row) => row.entityType === 'server_error_alert')).toBe(
      true
    )
  })

  it('turns a bounce into a campanita and ignores a delivered event', async () => {
    const ctx = createConvexCtx(teamSeed())
    const emailId = 'kd5884e258037523a2b5fcd529d4f00f' as EmailId
    const bounce = {
      type: 'email.bounced',
      created_at: '2026-09-02T20:13:23.000Z',
      data: {
        created_at: '2026-09-02T20:13:19.000Z',
        email_id: '01a063c1-3a43-77ef-bcbc-bb8b2bc89da0',
        from: 'Sherlock <fixture-0e5eb7f8@example.com>',
        to: ['fixture-cffeaf6c@example.com'],
        subject: 'Documentos nuevos',
        bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' },
      },
    } as EmailEvent
    const delivered = {
      ...bounce,
      type: 'email.delivered',
    } as EmailEvent

    await runHandler(_recordEmailFailure, ctx, { id: emailId, event: bounce })
    await runHandler(_recordEmailFailure, ctx, { id: emailId, event: delivered })

    const titles = ctx.tables.notifications.map((row) => row.title)
    expect(titles.some((title) => String(title).includes('Rebotó'))).toBe(true)
  })
})
