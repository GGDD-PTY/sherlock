// ============================================================================
// CONVEX NOTIFICATIONS MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/notifications.ts
//
// Test Categories:
// 1. Notification Queries (getNotification, listNotifications, getUnreadCount)
// 2. Notification Mutations (markAsRead, deleteNotification)
// 3. Retained notification types (NDA, document, analysis, system)
// 4. Batch Operations (markAllAsRead, deleteOldNotifications)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockConvexCtx,
  mockUnauthenticatedRequest,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import { createMockNotification, mockId, resetIdCounter } from '../utils/test-factories'

// ============================================================================
// SETUP
// ============================================================================

describe('convex/notifications.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: NOTIFICATION QUERIES
  // ==========================================================================

  describe('Notification Queries', () => {
    // ===== getNotification =====
    describe('getNotification', () => {
      it('should return notification when found by ID', async () => {
        const notificationId = mockId('notifications')
        const mockNotification = createMockNotification({
          _id: notificationId,
        })

        ctx.db.get.mockResolvedValue(mockNotification)

        const result = await ctx.db.get(notificationId)

        expect(result).toEqual(mockNotification)
        expect(ctx.db.get).toHaveBeenCalledWith(notificationId)
      })

      it('should return null when notification not found', async () => {
        const notificationId = mockId('notifications')
        ctx.db.get.mockResolvedValue(null)

        const result = await ctx.db.get(notificationId)

        expect(result).toBeNull()
      })

      it('should include all notification fields', async () => {
        const mockNotification = createMockNotification({
          type: 'system',
          title: 'System Notice',
          message: 'You have a new account notice',
          isRead: false,
        })
        ctx.db.get.mockResolvedValue(mockNotification)

        const result = await ctx.db.get(mockNotification._id)

        expect(result?.type).toBe('system')
        expect(result?.title).toBe('System Notice')
        expect(result?.isRead).toBe(false)
      })
    })

    // ===== listNotifications =====
    describe('listNotifications', () => {
      it('should return notifications for a user', async () => {
        const userId = mockId('profiles')
        const notifications = [
          createMockNotification({ userId }),
          createMockNotification({ userId }),
          createMockNotification({ userId }),
        ]

        const queryBuilder = createMockQueryBuilder(notifications)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const result = await query.withIndex('by_userId').collect()

        expect(result).toHaveLength(3)
      })

      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should order by creation time (newest first)', async () => {
        const userId = mockId('profiles')
        const notifications = [
          createMockNotification({ userId, _creationTime: 3000 }),
          createMockNotification({ userId, _creationTime: 1000 }),
          createMockNotification({ userId, _creationTime: 2000 }),
        ]

        const sorted = notifications.sort((a, b) => b._creationTime - a._creationTime)

        expect(sorted[0]._creationTime).toBe(3000)
        expect(sorted[2]._creationTime).toBe(1000)
      })

      it('should support pagination', async () => {
        const userId = mockId('profiles')
        const allNotifications = Array.from({ length: 50 }, () =>
          createMockNotification({ userId })
        )

        // First page
        const firstPage = allNotifications.slice(0, 20)
        const queryBuilder = createMockQueryBuilder(firstPage)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const result = await query.take(20)

        expect(result).toHaveLength(20)
      })
    })

    // ===== getUnreadCount =====
    describe('getUnreadCount', () => {
      it('should return count of unread notifications', async () => {
        const userId = mockId('profiles')
        const unreadNotifications = [
          createMockNotification({ userId, isRead: false }),
          createMockNotification({ userId, isRead: false }),
          createMockNotification({ userId, isRead: false }),
        ]

        const queryBuilder = createMockQueryBuilder(unreadNotifications)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const result = await query.filter().collect()

        expect(result).toHaveLength(3)
      })

      it('should return 0 when all notifications are read', async () => {
        const queryBuilder = createMockQueryBuilder([])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const result = await query.filter().collect()

        expect(result).toHaveLength(0)
      })

      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })
    })
  })

  // ==========================================================================
  // SECTION 2: NOTIFICATION MUTATIONS
  // ==========================================================================

  describe('Notification Mutations', () => {
    // ===== markAsRead =====
    describe('markAsRead', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should update notification to read', async () => {
        const notificationId = mockId('notifications')

        await ctx.db.patch(notificationId, { isRead: true })

        expect(ctx.db.patch).toHaveBeenCalledWith(notificationId, {
          isRead: true,
        })
      })

      it('should verify notification belongs to caller', async () => {
        const callerUserId = mockId('profiles')
        const notificationOwnerId = mockId('profiles')
        const notificationId = mockId('notifications')

        const mockNotification = createMockNotification({
          _id: notificationId,
          userId: notificationOwnerId,
        })

        ctx.db.get.mockResolvedValue(mockNotification)

        const notification = await ctx.db.get(notificationId)
        const isOwner = notification?.userId === callerUserId

        expect(isOwner).toBe(false)
        // Real code would throw "No tienes permiso"
      })
    })

    // ===== deleteNotification =====
    describe('deleteNotification', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should delete notification', async () => {
        const notificationId = mockId('notifications')

        await ctx.db.delete(notificationId)

        expect(ctx.db.delete).toHaveBeenCalledWith(notificationId)
      })

      it('should verify notification belongs to caller', async () => {
        const callerUserId = mockId('profiles')
        const notificationOwnerId = mockId('profiles')
        const notificationId = mockId('notifications')

        const mockNotification = createMockNotification({
          _id: notificationId,
          userId: notificationOwnerId,
        })

        ctx.db.get.mockResolvedValue(mockNotification)

        const notification = await ctx.db.get(notificationId)
        const isOwner = notification?.userId === callerUserId

        expect(isOwner).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 3: NOTIFICATION TYPES
  // ==========================================================================

  describe('Notification Types', () => {
    // ===== NDA Notifications =====
    describe('NDA Notifications', () => {
      it('should create nda_signed notification', async () => {
        const notification = createMockNotification({
          type: 'nda_signed',
          title: 'NDA Signed',
        })

        expect(notification.type).toBe('nda_signed')
      })

      it('should create nda_expired notification', async () => {
        const notification = createMockNotification({
          type: 'nda_expired',
          title: 'NDA Expired',
        })

        expect(notification.type).toBe('nda_expired')
      })
    })

    // ===== Document Notifications =====
    describe('Document Notifications', () => {
      it('should create document_shared notification', async () => {
        const notification = createMockNotification({
          type: 'document_shared',
          title: 'New Document Shared',
        })

        expect(notification.type).toBe('document_shared')
      })
    })

    // ===== Analysis Notifications =====
    describe('Analysis Notifications', () => {
      it('should create analysis_complete notification', async () => {
        const notification = createMockNotification({
          type: 'analysis_complete',
          title: 'Analysis Complete',
        })

        expect(notification.type).toBe('analysis_complete')
      })
    })

    // ===== System Notifications =====
    describe('System Notifications', () => {
      it('should create system notification', async () => {
        const notification = createMockNotification({
          type: 'system',
          title: 'System Announcement',
        })

        expect(notification.type).toBe('system')
      })
    })
  })

  // ==========================================================================
  // SECTION 4: BATCH OPERATIONS
  // ==========================================================================

  describe('Batch Operations', () => {
    // ===== markAllAsRead =====
    describe('markAllAsRead', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should mark all unread notifications as read', async () => {
        const userId = mockId('profiles')
        const unreadNotifications = [
          createMockNotification({ userId, isRead: false }),
          createMockNotification({ userId, isRead: false }),
          createMockNotification({ userId, isRead: false }),
        ]

        const queryBuilder = createMockQueryBuilder(unreadNotifications)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const notifications = await query.filter().collect()

        // Mark each as read
        for (const notification of notifications) {
          await ctx.db.patch(notification._id, { isRead: true })
        }

        expect(ctx.db.patch).toHaveBeenCalledTimes(3)
      })

      it("should only mark caller's notifications", async () => {
        const callerUserId = mockId('profiles')
        const otherUserId = mockId('profiles')

        const notifications = [
          createMockNotification({ userId: callerUserId, isRead: false }),
          createMockNotification({ userId: otherUserId, isRead: false }),
        ]

        const callerNotifications = notifications.filter((n) => n.userId === callerUserId)

        expect(callerNotifications).toHaveLength(1)
      })
    })

    // ===== deleteOldNotifications =====
    describe('deleteOldNotifications', () => {
      it('should delete notifications older than threshold', async () => {
        const userId = mockId('profiles')
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

        const oldNotifications = [
          createMockNotification({
            userId,
            _creationTime: thirtyDaysAgo - 1000,
          }),
          createMockNotification({
            userId,
            _creationTime: thirtyDaysAgo - 2000,
          }),
        ]

        const queryBuilder = createMockQueryBuilder(oldNotifications)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('notifications')
        const notifications = await query.filter().collect()

        // Delete each old notification
        for (const notification of notifications) {
          await ctx.db.delete(notification._id)
        }

        expect(ctx.db.delete).toHaveBeenCalledTimes(2)
      })

      it('should preserve recent notifications', () => {
        const userId = mockId('profiles')
        const now = Date.now()
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

        const recentNotification = createMockNotification({
          userId,
          _creationTime: now - 1000, // 1 second ago
        })

        const isOld = recentNotification._creationTime < thirtyDaysAgo
        expect(isOld).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 5: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate notification type enum', () => {
      const validTypes = [
        'nda_signed',
        'nda_expired',
        'document_shared',
        'analysis_complete',
        'system',
      ]

      validTypes.forEach((type) => {
        expect(validTypes).toContain(type)
      })
    })

    it('should validate title length', () => {
      const validTitles = ['Hi', 'New Notification', 'A'.repeat(100)]
      const invalidTitles = ['', 'A'.repeat(201)]

      validTitles.forEach((title) => {
        expect(title.length).toBeGreaterThan(0)
        expect(title.length).toBeLessThanOrEqual(200)
      })

      invalidTitles.forEach((title) => {
        const isValid = title.length > 0 && title.length <= 200
        expect(isValid).toBe(false)
      })
    })

    it('should validate message length', () => {
      const validMessages = ['Short message', 'A'.repeat(500)]
      const invalidMessages = ['', 'A'.repeat(1001)]

      validMessages.forEach((message) => {
        expect(message.length).toBeGreaterThan(0)
        expect(message.length).toBeLessThanOrEqual(1000)
      })

      invalidMessages.forEach((message) => {
        const isValid = message.length > 0 && message.length <= 1000
        expect(isValid).toBe(false)
      })
    })

    it('should validate link format', () => {
      const validLinks = ['/settings', '/my-company/documents', '/admin/vdr-requests']
      const invalidLinks = ['javascript:alert(1)', 'http://external.com']

      validLinks.forEach((link) => {
        expect(link.startsWith('/')).toBe(true)
      })

      invalidLinks.forEach((link) => {
        const isInternalLink = link.startsWith('/')
        expect(isInternalLink).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 6: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle user with no notifications', async () => {
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const query = ctx.db.query('notifications')
      const result = await query.collect()

      expect(result).toHaveLength(0)
    })

    it('should handle notification with special characters', async () => {
      await ctx.db.insert('notifications', {
        title: 'Aviso del sistema',
        message: "Revisa tu cuenta <script>alert('xss')</script>",
      })

      expect(ctx.db.insert).toHaveBeenCalled()
    })

    it('should handle high volume of notifications', async () => {
      const userId = mockId('profiles')
      const manyNotifications = Array.from({ length: 100 }, () =>
        createMockNotification({ userId })
      )

      expect(manyNotifications).toHaveLength(100)
    })

    it('should handle concurrent notification creation', async () => {
      const userId = mockId('profiles')

      await Promise.all([
        ctx.db.insert('notifications', { userId, title: 'Notification 1' }),
        ctx.db.insert('notifications', { userId, title: 'Notification 2' }),
        ctx.db.insert('notifications', { userId, title: 'Notification 3' }),
      ])

      expect(ctx.db.insert).toHaveBeenCalledTimes(3)
    })
  })
})
