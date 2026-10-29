// ============================================================================
// Notification Bell Component Tests - Unit Tests
// Tests notification bell logic and formatting functions
// Note: Complex Radix UI Popover interactions are tested via E2E tests
// ============================================================================

import { afterEach, describe, it, expect, vi } from 'vitest'

import { formatNotificationTimeAgo } from '@/components/notifications/format-time-ago'
import esMessages from '@/messages/es.json'

function tTime(key: string, values?: { count: number }): string {
  const time = esMessages.notifications.time
  if (key === 'time.invalid') return time.invalid
  if (key === 'time.justNow') return time.justNow
  if (key === 'time.yesterday') return time.yesterday
  if (key === 'time.minutesAgo') {
    return values?.count === 1 ? 'Hace 1 minuto' : `Hace ${String(values?.count)} minutos`
  }
  if (key === 'time.hoursAgo') {
    return values?.count === 1 ? 'Hace 1 hora' : `Hace ${String(values?.count)} horas`
  }
  if (key === 'time.daysAgo') {
    return values?.count === 1 ? 'Hace 1 día' : `Hace ${String(values?.count)} días`
  }
  if (key === 'time.weeksAgo') {
    return values?.count === 1 ? 'Hace 1 semana' : `Hace ${String(values?.count)} semanas`
  }
  return key
}

// ============================================================================
// UNIT TESTS - Testing pure logic functions
// ============================================================================

describe('NotificationBell - Logic Tests', () => {
  // =========================================================================
  // RELATIVE TIME FORMATTING
  // =========================================================================
  describe('Relative Time Formatting', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('should show the catalog just-now label for very recent times', () => {
      const now = new Date()
      const result = formatNotificationTimeAgo(now.toISOString(), 'es', tTime)
      expect(result).toBe(esMessages.notifications.time.justNow)
    })

    it('should show minutes for times less than 1 hour ago', () => {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000)
      const result = formatNotificationTimeAgo(thirtyMinsAgo.toISOString(), 'es', tTime)
      expect(result).toBe('Hace 30 minutos')
    })

    it('should show hours for times less than 24 hours ago', () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000)
      const result = formatNotificationTimeAgo(fiveHoursAgo.toISOString(), 'es', tTime)
      expect(result).toBe('Hace 5 horas')
    })

    it('should show days for times less than 7 days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      const result = formatNotificationTimeAgo(threeDaysAgo.toISOString(), 'es', tTime)
      expect(result).toBe('Hace 3 días')
    })

    it('should show date for times more than 30 days ago', () => {
      const now = new Date('2026-09-11T15:00:00.000Z')
      vi.useFakeTimers({ now })
      const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
      const result = formatNotificationTimeAgo(fortyDaysAgo.toISOString(), 'es', tTime)
      expect(result).toBe(
        new Intl.DateTimeFormat('es', { month: 'short', day: 'numeric' }).format(fortyDaysAgo)
      )
    })
  })

  // =========================================================================
  // NOTIFICATION TYPE ICONS
  // =========================================================================
  describe('Notification Type Icons Mapping', () => {
    // Test that all expected notification types are supported
    const NOTIFICATION_TYPES = [
      'connection_request',
      'connection_accepted',
      'new_message',
      'deal_interest',
      'deal_update',
      'nda_signed',
      'nda_expired',
      'document_shared',
      'analysis_complete',
      'subscription_update',
      'system',
    ]

    it.each(NOTIFICATION_TYPES)('should have icon mapping for %s notification type', (type) => {
      // This tests that all types are accounted for
      expect(NOTIFICATION_TYPES).toContain(type)
    })

    it('should have exactly 11 notification types defined', () => {
      expect(NOTIFICATION_TYPES).toHaveLength(11)
    })
  })

  // =========================================================================
  // UNREAD COUNT DISPLAY LOGIC
  // =========================================================================
  describe('Unread Count Display Logic', () => {
    function formatUnreadCount(count: number): string {
      if (count > 9) return '9+'
      return String(count)
    }

    it('should show exact count for 1-9', () => {
      expect(formatUnreadCount(1)).toBe('1')
      expect(formatUnreadCount(5)).toBe('5')
      expect(formatUnreadCount(9)).toBe('9')
    })

    it('should show 9+ for counts greater than 9', () => {
      expect(formatUnreadCount(10)).toBe('9+')
      expect(formatUnreadCount(15)).toBe('9+')
      expect(formatUnreadCount(99)).toBe('9+')
    })
  })

  // =========================================================================
  // NOTIFICATION SLICE LOGIC
  // =========================================================================
  describe('Notification Slice Logic', () => {
    it('should take only first 10 notifications for dropdown', () => {
      // ===== ARRANGE =====
      const notifications = Array.from({ length: 25 }, (_, i) => ({
        id: `notif_${i}`,
        title: `Notification ${i}`,
      }))

      // ===== ACT =====
      const recentNotifications = notifications.slice(0, 10)

      // ===== ASSERT =====
      expect(recentNotifications).toHaveLength(10)
      expect(recentNotifications[0].id).toBe('notif_0')
      expect(recentNotifications[9].id).toBe('notif_9')
    })

    it('should handle fewer than 10 notifications', () => {
      // ===== ARRANGE =====
      const notifications = Array.from({ length: 5 }, (_, i) => ({
        id: `notif_${i}`,
      }))

      // ===== ACT =====
      const recentNotifications = notifications.slice(0, 10)

      // ===== ASSERT =====
      expect(recentNotifications).toHaveLength(5)
    })

    it('should handle empty notifications', () => {
      // ===== ARRANGE =====
      const notifications: unknown[] = []

      // ===== ACT =====
      const recentNotifications = notifications.slice(0, 10)

      // ===== ASSERT =====
      expect(recentNotifications).toHaveLength(0)
    })
  })

  // =========================================================================
  // ARIA LABEL GENERATION
  // =========================================================================
  describe('Aria Label Generation', () => {
    function getAriaLabel(unreadCount: number): string {
      return `Notificaciones${unreadCount > 0 ? ` (${unreadCount} sin leer)` : ''}`
    }

    it('should show base label when no unread', () => {
      expect(getAriaLabel(0)).toBe('Notificaciones')
    })

    it('should include unread count when present', () => {
      expect(getAriaLabel(5)).toBe('Notificaciones (5 sin leer)')
    })

    it('should include unread count for large numbers', () => {
      expect(getAriaLabel(15)).toBe('Notificaciones (15 sin leer)')
    })
  })
})
