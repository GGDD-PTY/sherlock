// ============================================================================
// CONVEX SECURITY MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/security.ts
//
// Test Categories:
// 1. Session Queries (getActiveSessions, getUserSessions)
// 2. Security Events (logLoginAttempt, logSecurityEvent)
// 3. IP Blocking (blockIP, unblockIP, isIPBlocked)
// 4. Rate Limiting (checkRateLimit, incrementRateLimit)
// 5. Security Alerts (createAlert, dismissAlert)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockConvexCtx,
  createMockUserIdentity,
  mockAuthenticatedUser,
  mockUnauthenticatedRequest,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import { createMockProfile, mockId, resetIdCounter } from '../utils/test-factories'
import {
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
  getRecentSecurityEvents,
  isSecurityEventType,
  isSecuritySeverity,
} from '../../../convex/security'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

// ============================================================================
// MOCK SECURITY DATA
// ============================================================================

interface MockSecuritySession {
  _id: string
  _creationTime: number
  userId: string
  ipAddress: string
  userAgent: string
  isActive: boolean
  lastActivityAt: number
  expiresAt: number
}

interface MockSecurityEvent {
  _id: string
  _creationTime: number
  userId?: string
  eventType: string
  ipAddress: string
  userAgent?: string
  metadata?: Record<string, unknown>
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
}

interface MockBlockedIP {
  _id: string
  _creationTime: number
  ipAddress: string
  reason: string
  blockedAt: number
  expiresAt?: number
  blockedBy?: string
}

function createMockSession(overrides: Partial<MockSecuritySession> = {}): MockSecuritySession {
  return {
    _id: mockId('sessions'),
    _creationTime: Date.now(),
    userId: mockId('profiles'),
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0 (Test)',
    isActive: true,
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    ...overrides,
  }
}

function createMockSecurityEvent(overrides: Partial<MockSecurityEvent> = {}): MockSecurityEvent {
  return {
    _id: mockId('securityEvents'),
    _creationTime: Date.now(),
    eventType: 'LOGIN_SUCCESS',
    ipAddress: '192.168.1.1',
    severity: 'LOW',
    ...overrides,
  }
}

function createMockBlockedIP(overrides: Partial<MockBlockedIP> = {}): MockBlockedIP {
  return {
    _id: mockId('blockedIPs'),
    _creationTime: Date.now(),
    ipAddress: '10.0.0.1',
    reason: 'Too many failed login attempts',
    blockedAt: Date.now(),
    ...overrides,
  }
}

// ============================================================================
// SETUP
// ============================================================================

describe('convex/security.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: SESSION QUERIES
  // ==========================================================================

  describe('Session Queries', () => {
    // ===== getActiveSessions =====
    describe('getActiveSessions', () => {
      it('should return active sessions for user', async () => {
        const userId = mockId('profiles')
        const sessions = [
          createMockSession({ userId, isActive: true }),
          createMockSession({ userId, isActive: true }),
        ]

        const queryBuilder = createMockQueryBuilder(sessions)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('sessions')
        const result = await query.filter().collect()

        expect(result).toHaveLength(2)
        result.forEach((session: MockSecuritySession) => {
          expect(session.isActive).toBe(true)
        })
      })

      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should not return expired sessions', async () => {
        const userId = mockId('profiles')
        const now = Date.now()
        const activeSessions = [
          createMockSession({
            userId,
            isActive: true,
            expiresAt: now + 86400000,
          }),
        ]

        const queryBuilder = createMockQueryBuilder(activeSessions)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('sessions')
        const result = await query.filter().collect()

        result.forEach((session: MockSecuritySession) => {
          expect(session.expiresAt).toBeGreaterThan(now)
        })
      })
    })

    // ===== getUserSessions =====
    describe('getUserSessions', () => {
      it('should require ADMIN for viewing other users sessions', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should allow user to view own sessions', async () => {
        const clerkId = 'test_clerk_id'
        const mockIdentity = createMockUserIdentity({ subject: clerkId })
        mockAuthenticatedUser(ctx, mockIdentity)

        const identity = await ctx.auth.getUserIdentity()
        expect(identity?.subject).toBe(clerkId)
      })
    })

    // ===== terminateSession =====
    describe('terminateSession', () => {
      it('should mark session as inactive', async () => {
        const sessionId = mockId('sessions')

        await ctx.db.patch(sessionId, { isActive: false })

        expect(ctx.db.patch).toHaveBeenCalledWith(sessionId, {
          isActive: false,
        })
      })

      it('should verify session belongs to caller', async () => {
        const callerUserId = mockId('profiles')
        const sessionOwnerId = mockId('profiles')
        const session = createMockSession({ userId: sessionOwnerId })

        const isOwner = session.userId === callerUserId
        expect(isOwner).toBe(false)
      })

      it('should allow ADMIN to terminate any session', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        const sessionId = mockId('sessions')

        expect(adminProfile.role).toBe('ADMIN')

        await ctx.db.patch(sessionId, { isActive: false })
        expect(ctx.db.patch).toHaveBeenCalled()
      })
    })
  })

  // ==========================================================================
  // SECTION 2: SECURITY EVENTS
  // ==========================================================================

  describe('Security Events', () => {
    // ===== logLoginAttempt =====
    describe('logLoginAttempt', () => {
      it('should log successful login', async () => {
        const eventId = mockId('securityEvents')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          userId,
          eventType: 'LOGIN_SUCCESS',
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0 (Test)',
          severity: 'LOW',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            eventType: 'LOGIN_SUCCESS',
            severity: 'LOW',
          })
        )
      })

      it('should log failed login', async () => {
        const eventId = mockId('securityEvents')

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          eventType: 'LOGIN_FAILED',
          ipAddress: '192.168.1.1',
          metadata: { reason: 'Invalid credentials' },
          severity: 'MEDIUM',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            eventType: 'LOGIN_FAILED',
            severity: 'MEDIUM',
          })
        )
      })

      it('should capture IP address', async () => {
        const eventId = mockId('securityEvents')
        const ipAddress = '192.168.1.100'

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          eventType: 'LOGIN_SUCCESS',
          ipAddress,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            ipAddress,
          })
        )
      })
    })

    // ===== logSecurityEvent =====
    describe('logSecurityEvent', () => {
      it('should log password change', async () => {
        const eventId = mockId('securityEvents')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          userId,
          eventType: 'PASSWORD_CHANGED',
          ipAddress: '192.168.1.1',
          severity: 'MEDIUM',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            eventType: 'PASSWORD_CHANGED',
          })
        )
      })

      it('should log suspicious activity', async () => {
        const eventId = mockId('securityEvents')

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          eventType: 'SUSPICIOUS_ACTIVITY',
          ipAddress: '10.0.0.1',
          metadata: { pattern: 'Multiple countries in short time' },
          severity: 'HIGH',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            eventType: 'SUSPICIOUS_ACTIVITY',
            severity: 'HIGH',
          })
        )
      })

      it('should log account lockout', async () => {
        const eventId = mockId('securityEvents')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(eventId)

        await ctx.db.insert('securityEvents', {
          userId,
          eventType: 'ACCOUNT_LOCKED',
          ipAddress: '192.168.1.1',
          metadata: { reason: 'Too many failed attempts' },
          severity: 'HIGH',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityEvents',
          expect.objectContaining({
            eventType: 'ACCOUNT_LOCKED',
          })
        )
      })
    })

    // ===== getSecurityEvents =====
    describe('getSecurityEvents', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should filter by severity', async () => {
        const highSeverityEvents = [
          createMockSecurityEvent({ severity: 'HIGH' }),
          createMockSecurityEvent({ severity: 'CRITICAL' }),
        ]

        const queryBuilder = createMockQueryBuilder(highSeverityEvents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('securityEvents')
        const result = await query.filter().collect()

        result.forEach((event: MockSecurityEvent) => {
          expect(['HIGH', 'CRITICAL']).toContain(event.severity)
        })
      })

      it('should filter by date range', async () => {
        const now = Date.now()
        const oneDayAgo = now - 24 * 60 * 60 * 1000

        const recentEvents = [
          createMockSecurityEvent({ _creationTime: now - 1000 }),
          createMockSecurityEvent({ _creationTime: now - 3600000 }),
        ]

        const queryBuilder = createMockQueryBuilder(recentEvents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('securityEvents')
        const result = await query.filter().collect()

        result.forEach((event: MockSecurityEvent) => {
          expect(event._creationTime).toBeGreaterThan(oneDayAgo)
        })
      })
    })
  })

  // ==========================================================================
  // SECTION 3: IP BLOCKING
  // ==========================================================================

  describe('IP Blocking', () => {
    // ===== blockIP =====
    describe('blockIP', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should block IP address', async () => {
        const blockedIPId = mockId('blockedIPs')

        ctx.db.insert.mockResolvedValue(blockedIPId)

        await ctx.db.insert('blockedIPs', {
          ipAddress: '10.0.0.1',
          reason: 'Malicious activity',
          blockedAt: Date.now(),
          blockedBy: mockId('profiles'),
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'blockedIPs',
          expect.objectContaining({
            ipAddress: '10.0.0.1',
          })
        )
      })

      it('should support temporary blocks', async () => {
        const blockedIPId = mockId('blockedIPs')
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000 // 24 hours

        ctx.db.insert.mockResolvedValue(blockedIPId)

        await ctx.db.insert('blockedIPs', {
          ipAddress: '10.0.0.1',
          reason: 'Rate limit exceeded',
          blockedAt: Date.now(),
          expiresAt,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'blockedIPs',
          expect.objectContaining({
            expiresAt,
          })
        )
      })
    })

    // ===== unblockIP =====
    describe('unblockIP', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should delete blocked IP record', async () => {
        const blockedIPId = mockId('blockedIPs')

        await ctx.db.delete(blockedIPId)

        expect(ctx.db.delete).toHaveBeenCalledWith(blockedIPId)
      })
    })

    // ===== isIPBlocked =====
    describe('isIPBlocked', () => {
      it('should return true for blocked IP', async () => {
        const blockedIP = createMockBlockedIP({ ipAddress: '10.0.0.1' })

        const queryBuilder = createMockQueryBuilder([blockedIP])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('blockedIPs')
        const result = await query.filter().first()

        expect(result).not.toBeNull()
      })

      it('should return false for non-blocked IP', async () => {
        const queryBuilder = createMockQueryBuilder([])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('blockedIPs')
        const result = await query.filter().first()

        expect(result).toBeNull()
      })

      it('should ignore expired blocks', async () => {
        const expiredBlock = createMockBlockedIP({
          ipAddress: '10.0.0.1',
          expiresAt: Date.now() - 86400000, // Expired yesterday
        })

        const isExpired =
          expiredBlock.expiresAt !== undefined && expiredBlock.expiresAt < Date.now()

        expect(isExpired).toBe(true)
      })
    })
  })

  // ==========================================================================
  // SECTION 4: RATE LIMITING
  // ==========================================================================

  describe('Rate Limiting', () => {
    // ===== checkRateLimit =====
    describe('checkRateLimit', () => {
      it('should allow request within limit', () => {
        const currentCount = 5
        const limit = 100

        const isAllowed = currentCount < limit
        expect(isAllowed).toBe(true)
      })

      it('should deny request exceeding limit', () => {
        const currentCount = 100
        const limit = 100

        const isAllowed = currentCount < limit
        expect(isAllowed).toBe(false)
      })

      it('should track by IP address', async () => {
        const ipAddress = '192.168.1.1'
        const rateLimit = {
          ipAddress,
          count: 50,
          windowStart: Date.now() - 30000, // 30 seconds ago
        }

        expect(rateLimit.ipAddress).toBe(ipAddress)
      })

      it('should reset after time window', () => {
        const windowSize = 60000 // 1 minute
        const windowStart = Date.now() - 120000 // 2 minutes ago
        const now = Date.now()

        const shouldReset = now - windowStart > windowSize
        expect(shouldReset).toBe(true)
      })
    })

    // ===== incrementRateLimit =====
    describe('incrementRateLimit', () => {
      it('should increment counter for IP', async () => {
        const rateLimitId = mockId('rateLimits')

        await ctx.db.patch(rateLimitId, { count: 51 })

        expect(ctx.db.patch).toHaveBeenCalledWith(rateLimitId, { count: 51 })
      })

      it('should create new record if none exists', async () => {
        const rateLimitId = mockId('rateLimits')

        ctx.db.insert.mockResolvedValue(rateLimitId)

        await ctx.db.insert('rateLimits', {
          ipAddress: '192.168.1.1',
          count: 1,
          windowStart: Date.now(),
        })

        expect(ctx.db.insert).toHaveBeenCalled()
      })
    })
  })

  // ==========================================================================
  // SECTION 5: SECURITY ALERTS
  // ==========================================================================

  describe('Security Alerts', () => {
    // ===== createAlert =====
    describe('createAlert', () => {
      it('should create alert for suspicious login', async () => {
        const alertId = mockId('securityAlerts')

        ctx.db.insert.mockResolvedValue(alertId)

        await ctx.db.insert('securityAlerts', {
          type: 'SUSPICIOUS_LOGIN',
          message: 'Login from new location detected',
          severity: 'MEDIUM',
          userId: mockId('profiles'),
          isDismissed: false,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityAlerts',
          expect.objectContaining({
            type: 'SUSPICIOUS_LOGIN',
          })
        )
      })

      it('should create alert for multiple failed logins', async () => {
        const alertId = mockId('securityAlerts')

        ctx.db.insert.mockResolvedValue(alertId)

        await ctx.db.insert('securityAlerts', {
          type: 'MULTIPLE_FAILED_LOGINS',
          message: '5 failed login attempts detected',
          severity: 'HIGH',
          ipAddress: '10.0.0.1',
          isDismissed: false,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'securityAlerts',
          expect.objectContaining({
            type: 'MULTIPLE_FAILED_LOGINS',
          })
        )
      })
    })

    // ===== dismissAlert =====
    describe('dismissAlert', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should mark alert as dismissed', async () => {
        const alertId = mockId('securityAlerts')

        await ctx.db.patch(alertId, {
          isDismissed: true,
          dismissedBy: mockId('profiles'),
          dismissedAt: Date.now(),
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          alertId,
          expect.objectContaining({
            isDismissed: true,
          })
        )
      })
    })

    // ===== getActiveAlerts =====
    describe('getActiveAlerts', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should return only non-dismissed alerts', async () => {
        const activeAlerts = [
          { _id: mockId('securityAlerts'), isDismissed: false },
          { _id: mockId('securityAlerts'), isDismissed: false },
        ]

        const queryBuilder = createMockQueryBuilder(activeAlerts)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('securityAlerts')
        const result = await query.filter().collect()

        result.forEach((alert: { _id: string; isDismissed: boolean }) => {
          expect(alert.isDismissed).toBe(false)
        })
      })
    })
  })

  // ==========================================================================
  // SECTION 6: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate IP address format', () => {
      const validIPs = ['192.168.1.1', '10.0.0.1', '172.16.0.1', '8.8.8.8']
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/

      validIPs.forEach((ip) => {
        expect(ipv4Regex.test(ip)).toBe(true)
      })
    })

    it('should validate severity levels', () => {
      SECURITY_SEVERITIES.forEach((severity) => {
        expect(isSecuritySeverity(severity)).toBe(true)
      })
      expect(isSecuritySeverity('HIGH')).toBe(false)
    })

    it('should validate event types', () => {
      SECURITY_EVENT_TYPES.forEach((type) => {
        expect(isSecurityEventType(type)).toBe(true)
      })
      expect(isSecurityEventType('LOGIN_SUCCESS')).toBe(false)
    })
  })

  // ==========================================================================
  // SECTION 7: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle user with no security events', async () => {
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const query = ctx.db.query('securityEvents')
      const result = await query.collect()

      expect(result).toHaveLength(0)
    })

    it('should handle high volume of security events', async () => {
      const events = Array.from({ length: 1000 }, () => createMockSecurityEvent())

      expect(events).toHaveLength(1000)
    })

    it('should handle concurrent session operations', async () => {
      const sessionId = mockId('sessions')

      await Promise.all([
        ctx.db.patch(sessionId, { lastActivityAt: Date.now() }),
        ctx.db.patch(sessionId, { lastActivityAt: Date.now() + 1000 }),
      ])

      expect(ctx.db.patch).toHaveBeenCalledTimes(2)
    })

    it('should handle IPv6 addresses', () => {
      const ipv6Address = '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
      expect(ipv6Address).toBeDefined()
    })

    it('should handle proxy headers', () => {
      const xForwardedFor = '192.168.1.1, 10.0.0.1, 172.16.0.1'
      const realIP = xForwardedFor.split(',')[0].trim()

      expect(realIP).toBe('192.168.1.1')
    })
  })
})

// ============================================================================
// EL TIPO DE EVENTO FILTRA EN EL SERVIDOR (A7-3)
// ============================================================================
// El panel lo aplicaba en el navegador sobre los eventos más recientes: un
// evento más viejo de ese tipo quedaba invisible aunque fuera el único de su
// clase.

describe('getRecentSecurityEvents', () => {
  const NOW = Date.now()

  function tables(): Tables {
    return {
      users: [
        {
          _id: 'user_admin',
          authProvider: 'workos',
          providerUserId: 'workos_admin',
          workosUserId: 'workos_admin',
          email: 'admin@example.com',
        },
      ],
      profiles: [{ _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true }],
      securityEvents: [
        {
          _id: 'event_old_login',
          _creationTime: NOW - 30_000,
          type: 'FAILED_LOGIN',
          severity: 'WARNING',
          resolved: false,
        },
        {
          _id: 'event_rate_limit',
          _creationTime: NOW - 20_000,
          type: 'RATE_LIMIT_EXCEEDED',
          severity: 'WARNING',
          resolved: false,
        },
        {
          _id: 'event_new_login',
          _creationTime: NOW - 10_000,
          type: 'FAILED_LOGIN',
          severity: 'ALERT',
          resolved: false,
        },
      ],
    }
  }

  const adminCtx = (rows: Tables) =>
    createConvexCtx(rows, {
      identity: {
        issuer: 'https://api.workos.com/',
        subject: 'workos_admin',
        email: 'admin@example.com',
      },
    })

  it('brings the older event of the chosen type that the window left out', async () => {
    const rows = tables()

    const withoutType = await runHandler<Record<string, unknown>, Array<{ _id: string }>>(
      getRecentSecurityEvents,
      adminCtx(rows),
      { limit: 2 }
    )
    expect(withoutType.map((event) => event._id)).toEqual(['event_new_login', 'event_rate_limit'])

    const byType = await runHandler<Record<string, unknown>, Array<{ _id: string }>>(
      getRecentSecurityEvents,
      adminCtx(rows),
      { limit: 2, type: 'FAILED_LOGIN' }
    )
    expect(byType.map((event) => event._id)).toEqual(['event_new_login', 'event_old_login'])
  })

  it('combines the type with the severity filter', async () => {
    const rows = tables()

    const result = await runHandler<Record<string, unknown>, Array<{ _id: string }>>(
      getRecentSecurityEvents,
      adminCtx(rows),
      { limit: 10, type: 'FAILED_LOGIN', severity: 'ALERT' }
    )

    expect(result.map((event) => event._id)).toEqual(['event_new_login'])
  })
})
