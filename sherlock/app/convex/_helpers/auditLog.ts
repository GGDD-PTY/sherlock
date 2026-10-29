// ============================================================================
// ADMIN AUDIT LOG HELPER
// ============================================================================
// Helper function to log admin actions for accountability and compliance.
// Use this in all admin mutations to track changes.
// ============================================================================

import { Effect } from 'effect'
import type { MutationCtx } from '../_generated/server'
import type { Id } from '../_generated/dataModel'
import { convexPromise, runConvex } from './effect'

// ===== CATÁLOGOS =====
// Las dos listas se escriben una sola vez, como schemas. El tipo sale de la
// lista, así que no hay forma de agregar una acción al tipo y olvidarla en el
// catálogo que valida lo que se persiste.

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type AdminAction =
  // User management
  | 'USER_CREATE'
  | 'USER_PROFILE_UPDATE'
  | 'USER_ROLE_CHANGE'
  | 'USER_VERIFICATION_CHANGE'
  | 'USER_STATUS_CHANGE'
  | 'USER_DELETE' // KYC
  | 'KYC_APPROVE'
  | 'KYC_REJECT'
  | 'KYC_REQUEST_REVISION'
  | 'KYC_DATA_ACCESS' // NDA management
  // NDA de sala de empresa (`guestNdaTemplates`)
  | 'NDA_TEMPLATE_CREATE'
  // VDR lifecycle
  | 'VDR_ADMIN_CAPABILITY_ISSUE'
  | 'VDR_ADMIN_CAPABILITY_CONSUME'
  | 'DOCUMENT_ARCHIVE'
  // Vuelta del archivado (`operatorRestore:restoreArchivedDocuments`).
  | 'DOCUMENT_RESTORE'
  | 'DOCUMENT_PURGE'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_VERSION_RESTORE'
  | 'DOCUMENT_LEGAL_HOLD_PLACE'
  | 'DOCUMENT_LEGAL_HOLD_RELEASE'
  | 'DOCUMENT_METADATA_UPDATE'
  | 'GUEST_INVITATION_CREATE'
  | 'GUEST_INVITATION_REVOKE'
  | 'GUEST_INVITATION_EXTEND' // Security
  | 'SECURITY_EVENT_RESOLVE' // Company management
  | 'COMPANY_PURGE'
  // Renombre desde el operador (`operatorRestore:setCompanyName`).
  | 'COMPANY_RENAME'
  | 'COMPANY_VERIFY'
  | 'COMPANY_UNVERIFY'
  | 'COMPANY_VISIBILITY_CHANGE' // Impersonation
  | 'IMPERSONATION_LIST_SEARCH'
  | 'IMPERSONATION_USER_ACCESS' // Deliverables (pipeline sell-side)
  | 'DELIVERABLE_REQUEST'
  | 'DELIVERABLE_TRANSITION'
  | 'DELIVERABLE_RENDITION_ATTACH'
  | 'CHECKLIST_ITEM_SET'
  | 'COMPANY_ROOM_ACTIVATION'
  | 'SUPPORT_MESSAGE_SEND'
  | 'SUPPORT_THREAD_READ'
  // Preferencias de aviso de otro perfil (admin) y la limpieza de duplicados
  | 'NOTIFICATION_PREFERENCES_UPDATE'
  | 'NOTIFICATION_PREFERENCES_CLEANUP' // System
  | 'SEED_DATA'
  | 'SEED_DATA_CLEAR'
  | 'SYSTEM_CONFIG_CHANGE'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type TargetType =
  | 'USER'
  | 'PROFILE'
  | 'COMPANY'
  | 'GUEST_INVITATION'
  | 'DOCUMENT'
  | 'DELIVERABLE'
  | 'SUPPORT_THREAD'
  | 'SECURITY_EVENT'
  | 'SYSTEM'

interface LogAdminActionParams {
  ctx: MutationCtx
  adminProfileId: Id<'profiles'>
  adminEmail: string
  action: AdminAction
  targetType: TargetType
  targetId?: string
  previousValue?: unknown
  newValue?: unknown
  notes?: string
  ipAddress?: string
  userAgent?: string
}

const logAdminActionEffect = Effect.fn('AdminAudit.log')(function* (params: LogAdminActionParams) {
  return yield* convexPromise(() =>
    params.ctx.db.insert('adminAuditLogs', {
      adminProfileId: params.adminProfileId,
      adminEmail: params.adminEmail,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      previousValue: params.previousValue,
      newValue: params.newValue,
      notes: params.notes,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    })
  )
})

/**
 * Log an admin action for audit purposes.
 * Call this in every admin mutation after the action is completed.
 *
 * @example
 * ```typescript
 * await logAdminAction({
 *   ctx,
 *   adminProfileId: profile._id,
 *   adminEmail: user.email,
 *   action: "USER_ROLE_CHANGE",
 *   targetType: "PROFILE",
 *   targetId: targetProfile._id,
 *   previousValue: { role: "COMPANY" },
 *   newValue: { role: "COMPANY" },
 *   notes: "Changed per user request",
 * });
 * ```
 */
export function logAdminAction(params: LogAdminActionParams): Promise<Id<'adminAuditLogs'>> {
  return runConvex(logAdminActionEffect(params))
}

/**
 * Helper to create a snapshot of an entity for audit logging.
 * Useful for capturing the "previousValue" before a change.
 *
 * @example
 * ```typescript
 * const previousValue = createSnapshot(profile, ["role", "isVerified"]);
 * // Result: { role: "COMPANY", isVerified: false }
 * ```
 */
export function createSnapshot<T extends Record<string, unknown>>(
  entity: T,
  fields: (keyof T)[]
): Partial<T> {
  const snapshot: Partial<T> = {}
  for (const field of fields) {
    snapshot[field] = entity[field]
  }
  return snapshot
}
