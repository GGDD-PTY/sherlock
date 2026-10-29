import { describe, expect, it } from 'vitest'

import { getSecurityEventsCounts, resolveSecurityEvent } from '../../../convex/security'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-14e4636f@example.com',
}

function adminTables(events: Row[] = []): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-14e4636f@example.com',
      },
    ],
    profiles: [{ _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true }],
    securityEvents: events,
    adminAuditLogs: [],
  }
}

function adminCtx(tables: Tables) {
  return createConvexCtx(tables, { identity: ADMIN_IDENTITY })
}

function event(id: string, overrides: Partial<Row> = {}): Row {
  return {
    _id: id,
    _creationTime: Date.now() - 1_000,
    type: 'FAILED_LOGIN',
    severity: 'WARNING',
    resolved: false,
    userEmail: 'fixture-784a9103@example.com',
    ipAddress: '203.0.113.10',
    ...overrides,
  }
}

describe('security.resolveSecurityEvent', () => {
  it('marks the event resolved and writes an admin audit row', async () => {
    const tables = adminTables([event('event_open')])
    const ctx = adminCtx(tables)

    await runHandler(resolveSecurityEvent, ctx, {
      eventId: 'event_open',
      notes: 'Falso positivo del rate limit',
    })

    expect(tables.securityEvents[0]).toMatchObject({
      resolved: true,
      resolvedByProfileId: 'profile_admin',
      resolutionNotes: 'Falso positivo del rate limit',
    })
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'SECURITY_EVENT_RESOLVE',
        targetType: 'SECURITY_EVENT',
        targetId: 'event_open',
        newValue: { resolved: true },
        notes: 'Falso positivo del rate limit',
      }),
    ])
  })

  it('rejects a missing event', async () => {
    const ctx = adminCtx(adminTables())

    await expect(
      runHandler(resolveSecurityEvent, ctx, { eventId: 'event_missing' })
    ).rejects.toThrow(/no encontrado/)
  })
})

describe('security.getSecurityEventsCounts', () => {
  it('counts only unresolved events by severity', async () => {
    const ctx = adminCtx(
      adminTables([
        event('c1', { severity: 'CRITICAL' }),
        event('c2', { severity: 'CRITICAL' }),
        event('a1', { severity: 'ALERT' }),
        event('w1', { severity: 'WARNING' }),
        event('i1', { severity: 'INFO' }),
        event('resolved', { severity: 'CRITICAL', resolved: true }),
      ])
    )

    const counts = await runHandler<Record<string, never>, Record<string, number>>(
      getSecurityEventsCounts,
      ctx,
      {}
    )

    expect(counts).toEqual({ total: 5, critical: 2, alert: 1, warning: 1, info: 1 })
  })
})
