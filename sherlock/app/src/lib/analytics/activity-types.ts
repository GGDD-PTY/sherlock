// ============================================================================
// VOCABULARIO DEL FILTRO DE ACTIVIDAD ADMIN
// ============================================================================
// Esta lista es lo único que valida el parámetro `activityType` de
// `/api/admin/activity` antes de que Convex lo use como llave del índice
// `by_action` de `activityLogs`. La columna es `v.string()` en el schema, así
// que del lado del backend no hay una segunda lista que la contradiga: no hay
// gesamplefoods del que derivarla.
//
// ATENCIÓN: la lista NO coincide con lo que Convex escribe hoy en `action`.
// Está reportado y no se toca acá porque cambiarla cambia qué acepta la API.
// ============================================================================

import { Schema } from 'effect'

const ActivityTypeSchema = Schema.Literals([
  'auth.login',
  'auth.logout',
  'auth.signup',
  'auth.password_reset',
  'connection.request',
  'connection.accept',
  'connection.reject',
  'connection.remove',
  'message.send',
  'message.read',
  'document.upload',
  'document.download',
  'document.delete',
  'document.view',
  'nda.sign',
  'nda.request',
  'analysis.debt.create',
  'analysis.debt.view',
  'analysis.debt.export',
  'analysis.equity.create',
  'analysis.equity.view',
  'analysis.equity.export',
  'analysis.ratios.calculate',
  'subscription.create',
  'subscription.upgrade',
  'subscription.downgrade',
  'subscription.cancel',
  'profile.view',
  'profile.update',
  'settings.update',
  'notifications.update',
  'admin.user.suspend',
])

export type ActivityType = typeof ActivityTypeSchema.Type

// El `Set` paralelo se fue: el vocabulario y su validador son el mismo objeto.
const isActivityTypeValue = Schema.is(ActivityTypeSchema)

export function isActivityType(value: string): value is ActivityType {
  return isActivityTypeValue(value)
}
