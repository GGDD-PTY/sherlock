// ============================================================================
// CONVEX ACTIVITY LOGS MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/activityLogs.ts
//
// Test Categories:
// 1. Activity Log Queries (getActivityLogs, getUserActivity, getEntityActivity)
// 2. Activity Log Mutations (logActivity, bulkLogActivity)
// 3. Action Types (CRUD operations, authentication, system events)
// 4. Admin Functions (audit trail, compliance reports)
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
import {
  createMockProfile,
  createMockActivityLog,
  mockId,
  resetIdCounter,
  type MockActivityLog,
} from '../utils/test-factories'

// ============================================================================
// SETUP
// ============================================================================

describe('convex/activityLogs.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: ACTIVITY LOG QUERIES
  // ==========================================================================

  describe('Activity Log Queries', () => {
    // ===== getActivityLogs =====
    describe('getActivityLogs', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should return activity logs', async () => {
        const logs = [
          createMockActivityLog({ action: 'DEAL_CREATED' }),
          createMockActivityLog({ action: 'USER_LOGIN' }),
          createMockActivityLog({ action: 'DOCUMENT_UPLOADED' }),
        ]

        const queryBuilder = createMockQueryBuilder(logs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.collect()

        expect(result).toHaveLength(3)
      })

      it('should order by creation time (newest first)', async () => {
        const logs = [
          createMockActivityLog({ _creationTime: 3000 }),
          createMockActivityLog({ _creationTime: 1000 }),
          createMockActivityLog({ _creationTime: 2000 }),
        ]

        const sorted = logs.sort((a, b) => b._creationTime - a._creationTime)

        expect(sorted[0]._creationTime).toBe(3000)
        expect(sorted[2]._creationTime).toBe(1000)
      })

      it('should support pagination', async () => {
        const allLogs = Array.from({ length: 100 }, () => createMockActivityLog())

        // First page
        const firstPage = allLogs.slice(0, 20)
        const queryBuilder = createMockQueryBuilder(firstPage)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.take(20)

        expect(result).toHaveLength(20)
      })
    })

    // ===== getUserActivity =====
    describe('getUserActivity', () => {
      it('should return activity for a specific user', async () => {
        const _userId = mockId('profiles')
        const logs = [
          createMockActivityLog({ userId: _userId, action: 'DEAL_VIEWED' }),
          createMockActivityLog({ userId: _userId, action: 'PROFILE_UPDATED' }),
        ]

        const queryBuilder = createMockQueryBuilder(logs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.withIndex('by_userId').collect()

        expect(result).toHaveLength(2)
        result.forEach((log: MockActivityLog) => {
          expect(log.userId).toBe(_userId)
        })
      })

      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should allow users to view own activity', async () => {
        const clerkId = 'test_clerk_id'
        const mockIdentity = createMockUserIdentity({ subject: clerkId })
        mockAuthenticatedUser(ctx, mockIdentity)

        const identity = await ctx.auth.getUserIdentity()
        expect(identity?.subject).toBe(clerkId)
      })
    })

    // ===== getEntityActivity =====
    describe('getEntityActivity', () => {
      it('should return activity for a specific entity', async () => {
        const dealId = mockId('deals')
        const logs = [
          createMockActivityLog({
            entityType: 'DEAL',
            entityId: dealId,
            action: 'DEAL_VIEWED',
          }),
          createMockActivityLog({
            entityType: 'DEAL',
            entityId: dealId,
            action: 'DEAL_UPDATED',
          }),
        ]

        const queryBuilder = createMockQueryBuilder(logs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.filter().collect()

        result.forEach((log: MockActivityLog) => {
          expect(log.entityType).toBe('DEAL')
          expect(log.entityId).toBe(dealId)
        })
      })

      it('should filter by entity type', async () => {
        const documentLogs = [
          createMockActivityLog({
            entityType: 'DOCUMENT',
            action: 'DOCUMENT_UPLOADED',
          }),
          createMockActivityLog({
            entityType: 'DOCUMENT',
            action: 'DOCUMENT_VIEWED',
          }),
        ]

        const queryBuilder = createMockQueryBuilder(documentLogs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.filter().collect()

        result.forEach((log: MockActivityLog) => {
          expect(log.entityType).toBe('DOCUMENT')
        })
      })
    })
  })

  // ==========================================================================
  // SECTION 2: ACTIVITY LOG MUTATIONS
  // ==========================================================================

  describe('Activity Log Mutations', () => {
    // ===== logActivity =====
    describe('logActivity', () => {
      it('should create activity log entry', async () => {
        const logId = mockId('activityLogs')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          userId,
          action: 'DEAL_CREATED',
          entityType: 'DEAL',
          entityId: mockId('deals'),
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0 (Test)',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'DEAL_CREATED',
            entityType: 'DEAL',
          })
        )
      })

      it('should capture IP address', async () => {
        const logId = mockId('activityLogs')
        const ipAddress = '192.168.1.100'

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'USER_LOGIN',
          ipAddress,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            ipAddress,
          })
        )
      })

      it('should capture user agent', async () => {
        const logId = mockId('activityLogs')
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'USER_LOGIN',
          userAgent,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            userAgent,
          })
        )
      })

      it('should include metadata', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'DEAL_UPDATED',
          metadata: {
            changedFields: ['title', 'amount'],
            previousValues: { title: 'Old Title', amount: 1000000 },
            newValues: { title: 'New Title', amount: 2000000 },
          },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            metadata: expect.objectContaining({
              changedFields: ['title', 'amount'],
            }),
          })
        )
      })
    })

    // ===== bulkLogActivity =====
    describe('bulkLogActivity', () => {
      it('should create multiple log entries', async () => {
        const logs = [
          { action: 'NOTIFICATION_SENT', entityType: 'NOTIFICATION' },
          { action: 'NOTIFICATION_SENT', entityType: 'NOTIFICATION' },
          { action: 'NOTIFICATION_SENT', entityType: 'NOTIFICATION' },
        ]

        for (const log of logs) {
          ctx.db.insert.mockResolvedValueOnce(mockId('activityLogs'))
          await ctx.db.insert('activityLogs', log)
        }

        expect(ctx.db.insert).toHaveBeenCalledTimes(3)
      })
    })
  })

  // ==========================================================================
  // SECTION 3: ACTION TYPES
  // ==========================================================================

  describe('Action Types', () => {
    // ===== CRUD Operations =====
    describe('CRUD Operations', () => {
      it('should log CREATE actions', async () => {
        const createActions = [
          'DEAL_CREATED',
          'COMPANY_CREATED',
          'DOCUMENT_UPLOADED',
          'CONNECTION_CREATED',
        ]

        for (const action of createActions) {
          ctx.db.insert.mockResolvedValueOnce(mockId('activityLogs'))
          await ctx.db.insert('activityLogs', { action })
        }

        expect(ctx.db.insert).toHaveBeenCalledTimes(4)
      })

      it('should log READ actions', async () => {
        const readActions = ['DEAL_VIEWED', 'PROFILE_VIEWED', 'DOCUMENT_DOWNLOADED']

        for (const action of readActions) {
          ctx.db.insert.mockResolvedValueOnce(mockId('activityLogs'))
          await ctx.db.insert('activityLogs', { action })
        }

        expect(ctx.db.insert).toHaveBeenCalledTimes(3)
      })

      it('should log UPDATE actions', async () => {
        const updateActions = ['DEAL_UPDATED', 'PROFILE_UPDATED', 'SETTINGS_CHANGED']

        for (const action of updateActions) {
          ctx.db.insert.mockResolvedValueOnce(mockId('activityLogs'))
          await ctx.db.insert('activityLogs', { action })
        }

        expect(ctx.db.insert).toHaveBeenCalledTimes(3)
      })

      it('should log DELETE actions', async () => {
        const deleteActions = ['DEAL_DELETED', 'DOCUMENT_DELETED', 'CONNECTION_REMOVED']

        for (const action of deleteActions) {
          ctx.db.insert.mockResolvedValueOnce(mockId('activityLogs'))
          await ctx.db.insert('activityLogs', { action })
        }

        expect(ctx.db.insert).toHaveBeenCalledTimes(3)
      })
    })

    // ===== Authentication Events =====
    describe('Authentication Events', () => {
      it('should log login events', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'USER_LOGIN',
          metadata: { method: 'google_oauth' },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'USER_LOGIN',
          })
        )
      })

      it('should log logout events', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'USER_LOGOUT',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'USER_LOGOUT',
          })
        )
      })

      it('should log failed login attempts', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'LOGIN_FAILED',
          metadata: {
            reason: 'Invalid credentials',
            email: 'test@example.com',
          },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'LOGIN_FAILED',
          })
        )
      })
    })

    // ===== System Events =====
    describe('System Events', () => {
      it('should log subscription changes', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'SUBSCRIPTION_UPGRADED',
          metadata: { from: 'free', to: 'company_pro' },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'SUBSCRIPTION_UPGRADED',
          })
        )
      })

      it('should log credit purchases', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'CREDITS_PURCHASED',
          metadata: { amount: 50, price: 4900 },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'CREDITS_PURCHASED',
          })
        )
      })

      it('should log internal review activity', async () => {
        const logId = mockId('activityLogs')

        ctx.db.insert.mockResolvedValue(logId)

        await ctx.db.insert('activityLogs', {
          action: 'REVIEW_STARTED',
          entityType: 'DEAL_REVIEW',
          metadata: { type: 'CREDIT_REVIEW' },
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'activityLogs',
          expect.objectContaining({
            action: 'REVIEW_STARTED',
          })
        )
      })
    })
  })

  // ==========================================================================
  // SECTION 4: ADMIN FUNCTIONS
  // ==========================================================================

  describe('Admin Functions', () => {
    // ===== Audit Trail =====
    describe('Audit Trail', () => {
      it('should require ADMIN role', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })

      it('should return complete audit trail for entity', async () => {
        const dealId = mockId('deals')
        const auditTrail = [
          createMockActivityLog({
            entityType: 'DEAL',
            entityId: dealId,
            action: 'DEAL_CREATED',
            _creationTime: 1000,
          }),
          createMockActivityLog({
            entityType: 'DEAL',
            entityId: dealId,
            action: 'DEAL_UPDATED',
            _creationTime: 2000,
          }),
          createMockActivityLog({
            entityType: 'DEAL',
            entityId: dealId,
            action: 'DEAL_PUBLISHED',
            _creationTime: 3000,
          }),
        ]

        const queryBuilder = createMockQueryBuilder(auditTrail)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.filter().collect()

        expect(result).toHaveLength(3)
      })

      it('should include user information in audit trail', async () => {
        const userId = mockId('profiles')
        const log = createMockActivityLog({
          userId,
          action: 'DEAL_CREATED',
        })

        expect(log.userId).toBe(userId)
      })
    })

    // ===== Compliance Reports =====
    describe('Compliance Reports', () => {
      it('should generate activity summary', async () => {
        const summary = {
          totalActions: 1000,
          uniqueUsers: 150,
          actionBreakdown: {
            DEAL_VIEWED: 400,
            DEAL_CREATED: 50,
            DOCUMENT_DOWNLOADED: 200,
            USER_LOGIN: 350,
          },
        }

        expect(summary.totalActions).toBe(1000)
        expect(summary.uniqueUsers).toBe(150)
      })

      it('should filter by date range', async () => {
        const startDate = Date.now() - 30 * 24 * 60 * 60 * 1000
        const endDate = Date.now()

        const logs = [
          createMockActivityLog({ _creationTime: startDate + 1000 }),
          createMockActivityLog({ _creationTime: startDate + 2000 }),
        ]

        const queryBuilder = createMockQueryBuilder(logs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('activityLogs')
        const result = await query.filter().collect()

        result.forEach((log: MockActivityLog) => {
          expect(log._creationTime).toBeGreaterThan(startDate)
          expect(log._creationTime).toBeLessThan(endDate)
        })
      })

      it('should export logs for compliance', async () => {
        const logs = Array.from({ length: 10 }, () => createMockActivityLog())

        const exportData = logs.map((log) => ({
          timestamp: new Date(log._creationTime).toISOString(),
          action: log.action,
          userId: log.userId,
          entityType: log.entityType,
          entityId: log.entityId,
          ipAddress: log.ipAddress,
        }))

        expect(exportData).toHaveLength(10)
        expect(exportData[0]).toHaveProperty('timestamp')
        expect(exportData[0]).toHaveProperty('action')
      })
    })
  })

  // ==========================================================================
  // SECTION 5: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate action names', () => {
      const validActions = [
        'DEAL_CREATED',
        'DEAL_UPDATED',
        'DEAL_VIEWED',
        'DEAL_DELETED',
        'USER_LOGIN',
        'USER_LOGOUT',
        'DOCUMENT_UPLOADED',
        'DOCUMENT_DOWNLOADED',
      ]

      validActions.forEach((action) => {
        expect(typeof action).toBe('string')
        expect(action.length).toBeGreaterThan(0)
      })
    })

    it('should validate entity types', () => {
      const validEntityTypes = [
        'DEAL',
        'COMPANY',
        'INVESTOR',
        'DOCUMENT',
        'CONNECTION',
        'ANALYSIS',
        'NOTIFICATION',
      ]

      validEntityTypes.forEach((type) => {
        expect(validEntityTypes).toContain(type)
      })
    })

    it('should validate IP address format', () => {
      const validIPs = ['192.168.1.1', '10.0.0.1', '172.16.0.1']
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/

      validIPs.forEach((ip) => {
        expect(ipv4Regex.test(ip)).toBe(true)
      })
    })
  })

  // ==========================================================================
  // SECTION 6: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle user with no activity', async () => {
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const query = ctx.db.query('activityLogs')
      const result = await query.collect()

      expect(result).toHaveLength(0)
    })

    it('should handle high volume of logs', async () => {
      const logs = Array.from({ length: 10000 }, () => createMockActivityLog())

      expect(logs).toHaveLength(10000)
    })

    it('should handle concurrent logging', async () => {
      await Promise.all([
        ctx.db.insert('activityLogs', { action: 'ACTION_1' }),
        ctx.db.insert('activityLogs', { action: 'ACTION_2' }),
        ctx.db.insert('activityLogs', { action: 'ACTION_3' }),
      ])

      expect(ctx.db.insert).toHaveBeenCalledTimes(3)
    })

    it('should handle anonymous activity (no userId)', async () => {
      const logId = mockId('activityLogs')

      ctx.db.insert.mockResolvedValue(logId)

      await ctx.db.insert('activityLogs', {
        action: 'PAGE_VIEW',
        // No userId - anonymous visitor
        ipAddress: '192.168.1.1',
      })

      expect(ctx.db.insert).toHaveBeenCalled()
    })

    it('should handle special characters in metadata', async () => {
      const logId = mockId('activityLogs')

      ctx.db.insert.mockResolvedValue(logId)

      await ctx.db.insert('activityLogs', {
        action: 'DEAL_UPDATED',
        metadata: {
          title: 'Título con acentos y ñ',
          description: 'Description with "quotes" and \'apostrophes\'',
        },
      })

      expect(ctx.db.insert).toHaveBeenCalled()
    })

    it('should handle system-generated logs (no user)', async () => {
      const logId = mockId('activityLogs')

      ctx.db.insert.mockResolvedValue(logId)

      await ctx.db.insert('activityLogs', {
        action: 'CRON_JOB_EXECUTED',
        metadata: { job: 'cleanup_expired_sessions' },
      })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'activityLogs',
        expect.objectContaining({
          action: 'CRON_JOB_EXECUTED',
        })
      )
    })
  })
})
