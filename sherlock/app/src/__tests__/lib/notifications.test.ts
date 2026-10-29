// ============================================================================
// NOTIFICATIONS TYPES UNIT TESTS
// ============================================================================
// Tests for notification types
// Covers: NotificationType, Notification, NotificationPreferences
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

import { describe, it, expect } from 'vitest'
import {
  NotificationTypeSchema,
  type NotificationType,
  type Notification,
  type NotificationPreferences,
} from '@/lib/notifications'

describe('lib/notifications.ts', () => {
  // ============================================================================
  // TYPE VALIDATION TESTS
  // ============================================================================
  describe('Type validation', () => {
    // ===== TEST: NOTIFICATION TYPE UNION =====
    it('NotificationType covers all expected types', () => {
      const validTypes: NotificationType[] = [
        'nda_signed',
        'document_shared',
        'analysis_complete',
        'council_completed',
        'screening_complete',
        'news_alert_triggered',
        'system',
      ]

      // All should be assignable to NotificationType
      for (const type of validTypes) {
        const t: NotificationType = type
        expect(t).toBe(type)
      }
    })

    // ===== TEST: NOTIFICATION INTERFACE =====
    it('Notification interface has required fields', () => {
      // This is a compile-time check - if it compiles, the interface is correct
      const mockNotification: Notification = {
        id: 'notification_123' as never, // Id type from Convex
        user_id: 'user_123',
        type: 'nda_signed',
        title: 'NDA signed',
        message: 'A guest signed the NDA',
        is_read: false,
        created_at: new Date().toISOString(),
      }

      expect(mockNotification.id).toBeDefined()
      expect(mockNotification.user_id).toBeDefined()
      expect(mockNotification.type).toBe('nda_signed')
      expect(mockNotification.title).toBe('NDA signed')
      expect(mockNotification.is_read).toBe(false)
    })

    // ===== TEST: NOTIFICATION OPTIONAL FIELDS =====
    it('Notification can have optional fields', () => {
      const mockNotification: Notification = {
        id: 'notification_123' as never,
        user_id: 'user_123',
        type: 'document_shared',
        title: 'Document shared',
        message: 'A data-room document is ready',
        is_read: false,
        created_at: new Date().toISOString(),
        link: '/my-company/documents',
        metadata: {
          documentId: 'document_123',
        },
      }

      expect(mockNotification.link).toBe('/my-company/documents')
      expect(mockNotification.metadata).toBeDefined()
      expect(mockNotification.metadata?.documentId).toBe('document_123')
    })
  })

  // ============================================================================
  // PREFERENCE STRUCTURE TESTS
  // ============================================================================
  describe('NotificationPreferences structure', () => {
    // ===== TEST: CAN CREATE CUSTOM PREFERENCES =====
    it('can create custom preferences object', () => {
      const customPrefs: NotificationPreferences = {
        emailNewConnection: false,
        emailNewMessage: true,
        emailRoomUpdates: false,
        emailWeeklyDigest: false,
        emailAnalysisComplete: true,
        pushEnabled: false,
      }

      expect(customPrefs.emailNewConnection).toBe(false)
      expect(customPrefs.emailNewMessage).toBe(true)
      expect(customPrefs.pushEnabled).toBe(false)
    })
  })
})

// ============================================================================
// EL GEMELO DE CONVEX
// ============================================================================
// `convex/schema.ts` valida `notifications.type` contra su propia union de
// `v.literal`, escrita a mano. Las dos listas coincidian por costumbre: un tipo
// que exista solo de este lado hace que la mutation rechace la notificacion y
// se pierda; uno que exista solo del lado de Convex llega a la campanita sin
// icono ni etiqueta, porque `TYPE_ICONS` es un `Record<NotificationType, ...>`.
// Esto las ata hasta que la union de Convex se derive del schema.
// ============================================================================
describe('contrato con convex/schema.ts', () => {
  function convexNotificationTypes(): string[] {
    const schemaPath = path.resolve(import.meta.dirname, '..', '..', '..', 'convex', 'schema.ts')
    const source = fs.readFileSync(schemaPath, 'utf8')

    const table = source.slice(source.indexOf('notifications: defineTable({'))
    const union = table.slice(table.indexOf('type: v.union('))
    const body = union.slice(0, union.indexOf('),\n\n'))

    return [...body.matchAll(/v\.literal\('([^']+)'\)/g)].map((match) => match[1])
  }

  it('declara exactamente los mismos tipos que acepta la tabla', () => {
    expect(convexNotificationTypes()).toEqual([...NotificationTypeSchema.literals])
  })
})
