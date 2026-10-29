// ============================================================================
// NOTIFICATIONS TYPES
// ============================================================================
// Tipos para el sistema de notificaciones.
// La implementación real está en convex/notifications.ts
// Este archivo solo exporta tipos para compatibilidad con componentes legacy.
//
// LOS DIECISÉIS TIPOS TIENEN GEMELO. `convex/schema.ts` valida la columna
// `notifications.type` contra su propia unión de `v.literal`, escrita a mano.
// Las dos listas coinciden hoy porque alguien las escribió iguales, no porque
// algo lo obligue: un tipo que exista solo acá se rechaza en la mutation, con
// la notificación perdida, y uno que exista solo allá llega a la campanita sin
// ícono ni etiqueta. `notifications.test.ts` ata las dos listas.
// ============================================================================

import { Schema } from 'effect'

import { Id } from '../../convex/_generated/dataModel'

// ===== TIPOS DE NOTIFICACIÓN =====
export const NotificationTypeSchema = Schema.Literals([
  'new_message', // Nuevo mensaje
  'nda_signed', // NDA firmado
  'document_shared', // Documento compartido
  'analysis_complete', // Análisis completado
  'subscription_update', // Actualización de acceso (literal histórico congelado)
  'council_completed', // Comité / council terminado
  'screening_complete', // Screening terminado
  'news_alert_triggered', // Alerta de noticias
  'portfolio_alert', // Alerta de portafolio
  'system', // Notificación del sistema
])

export type NotificationType = typeof NotificationTypeSchema.Type

// ===== INTERFAZ DE NOTIFICACIÓN =====
export interface Notification {
  id: Id<'notifications'>
  user_id: string
  type: NotificationType
  title: string
  message: string
  link?: string // URL para navegar al hacer click
  is_read: boolean
  created_at: string
  metadata?: Record<string, unknown> // Datos adicionales (ej: sender_id, company_id)
}

// ===== PREFERENCIAS DE NOTIFICACIÓN (camelCase para match con Convex) =====
export interface NotificationPreferences {
  emailNewConnection: boolean
  emailNewMessage: boolean
  emailRoomUpdates: boolean
  emailWeeklyDigest: boolean
  emailAnalysisComplete: boolean
  pushEnabled: boolean
}
