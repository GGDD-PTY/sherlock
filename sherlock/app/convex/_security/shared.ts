// ============================================================================
// VOCABULARIO DE SEGURIDAD — MÓDULO PURO
// ============================================================================
// Los once tipos de evento, las cuatro severidades y sus dos guardas viven
// acá y no en `convex/security.ts` porque los lee también el navegador
// (`src/components/admin/AdminSecurityClient.tsx`). `convex/security.ts`
// registra funciones: importa `./_generated/server`, y ese módulo avisa
// «Convex functions should not be imported in the browser» en cuanto entra al
// bundle del cliente. La pantalla `/es/admin/security` abría con el overlay de
// Next por eso (tarjeta OB-RES-3).
//
// Bajo `convex/_security/` a propósito: Convex ignora las carpetas que empiezan
// con guion bajo, así que este archivo nunca registra una función y se puede
// importar desde los dos lados. `convex/security.ts` reexporta lo de acá para
// que sus consumidores de siempre no cambien de ruta.
// ============================================================================

import { Schema } from 'effect'

export const SECURITY_EVENT_TYPES = [
  'FAILED_LOGIN',
  'RATE_LIMIT_EXCEEDED',
  'DATA_ROOM_BULK_DOWNLOAD',
  'DATA_ROOM_BULK_ACCESS',
  'NDA_ACCESS_DENIED',
  'PASSWORD_RESET_ABUSE',
  'ACCOUNT_ENUMERATION',
  'REAUTH_LOCKOUT',
  'UNAUTHORIZED_API_ACCESS',
  'SUSPICIOUS_PROFILE_CHANGE',
  'ACCOUNT_SELF_DEACTIVATION',
] as const

export const SECURITY_SEVERITIES = ['INFO', 'WARNING', 'ALERT', 'CRITICAL'] as const

export const SecurityEventTypeSchema = Schema.Literals(SECURITY_EVENT_TYPES)
export const SecuritySeveritySchema = Schema.Literals(SECURITY_SEVERITIES)

export type SecurityEventType = typeof SecurityEventTypeSchema.Type
export type SecuritySeverity = typeof SecuritySeveritySchema.Type

const SECURITY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SecurityEventTypeSchema.literals)
const SECURITY_SEVERITY_SET: ReadonlySet<string> = new Set(SecuritySeveritySchema.literals)

export function isSecurityEventType(value: string): value is SecurityEventType {
  return SECURITY_EVENT_TYPE_SET.has(value)
}

export function isSecuritySeverity(value: string): value is SecuritySeverity {
  return SECURITY_SEVERITY_SET.has(value)
}
