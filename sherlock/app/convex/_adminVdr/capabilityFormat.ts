// ============================================================================
// FORMATO DE LA CAPACIDAD ADMIN DEL VDR — la forma es el contrato
// ============================================================================
// Esta hoja la lee un agente externo por MCP: cada campo de la prueba tiene una
// cota, y hasta ahora esas cotas vivían en una condición booleana de doce
// cláusulas dentro de `buildAdminVdrCapabilityProofPayload`. Un `null` de ahí no
// decía cuál de las doce falló, y agregar un campo al payload sin agregar su
// cota no rompía nada visible.
//
// Ahora cada cota es un `Schema.check` colgado de SU campo y el payload se
// arma con `makeOption`: el contrato es la estructura. El `null` de la firma
// pública se conserva byte por byte — quien llama sigue viendo «no se pudo
// construir la prueba» y nunca el detalle, que en una frontera de autorización
// es lo correcto.
// ============================================================================

import { Option, Schema } from 'effect'

const ADMIN_VDR_CAPABILITY_VERSION = 'admin-vdr-capability.v1' as const
export const ADMIN_VDR_CAPABILITY_TTL_MS = 60_000
export const ADMIN_VDR_CAPABILITY_MAX_CLOCK_SKEW_MS = 10_000
const ADMIN_VDR_CAPABILITY_MAX_INPUT_BYTES = 16_384
const ADMIN_VDR_CAPABILITY_SECRET_MIN_LENGTH = 32
const ADMIN_VDR_CAPABILITY_SECRET_MAX_LENGTH = 4_096

const AdminVdrActionSchema = Schema.Literals([
  'DOCUMENT_CREATE',
  'DOCUMENT_UPLOAD_INTENT',
  'DOCUMENT_UPDATE',
  'DOCUMENT_ARCHIVE',
  'DOCUMENT_PURGE',
  'DOCUMENT_BULK_UPDATE',
  'DOCUMENT_VERSION_RESTORE',
  'DOCUMENT_LEGAL_HOLD_PLACE',
  'DOCUMENT_LEGAL_HOLD_RELEASE',
  'DOCUMENT_REDACTION_CREATE',
  'DOCUMENT_REDACTION_SUBMIT',
  'DOCUMENT_REDACTION_READY',
  'DOCUMENT_REDACTION_REJECT',
  'DOCUMENT_REDACTION_CANCEL',
  'DOCUMENT_REDACTION_APPLY',
  'DD_CHECKLIST_INITIALIZE',
  'DD_CHECKLIST_UPDATE',
  'DD_CHECKLIST_REVIEW',
  'DOCUMENT_REQUEST_FULFILL',
  'DOCUMENT_REQUEST_CREATE_COMPANY',
  'DOCUMENT_REQUEST_ASSIGN_COMPANY',
  'DOCUMENT_REQUEST_CANCEL',
  'DOCUMENT_REQUEST_EXPIRE',
  'ROOM_ACCESS_GRANT',
  'ROOM_ACCESS_REVOKE',
  'GUEST_INVITE',
  'GUEST_EXTEND',
  'GUEST_REVOKE',
  'GUEST_GROUP_CREATE',
  'GUEST_GROUP_MEMBER_ADD',
  'GUEST_GROUP_REVOKE',
  'DASHBOARD_SAVE_DRAFT',
  'DASHBOARD_PUBLISH',
  'DASHBOARD_RESTORE',
  'VDR_QUESTION_ANSWER',
  'VDR_QUESTION_APPROVE',
  'VDR_QUESTION_REJECT',
  'VDR_QUESTION_CLOSE',
  'VDR_AUDIT_EXPORT_PREPARE',
  'VDR_AUDIT_EXPORT_RECORD',
  'WORKFLOW_SAVE_DRAFT',
  'WORKFLOW_PUBLISH',
  'WORKFLOW_RESTORE',
  'WORKFLOW_RUN_START',
  'WORKFLOW_RUN_CANCEL',
  'WORKFLOW_STEP_CLAIM',
  'WORKFLOW_STEP_REASSIGN',
  'WORKFLOW_STEP_ESCALATE',
  'WORKFLOW_STEP_SUBMIT',
  'WORKFLOW_STEP_REVIEW',
])

export type AdminVdrAction = typeof AdminVdrActionSchema.Type

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

/** Un identificador de amarre: no vacío, acotado y sin caracteres libres. */
function BindingIdentifier(maximum: number) {
  return Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(maximum),
      Schema.isPattern(IDENTIFIER_PATTERN)
    )
  )
}

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(SHA256_PATTERN)))

/** Un instante en milisegundos que JavaScript todavía representa sin perder bits. */
const SafeEpochMs = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  )
)

const isAdminVdrActionValue = Schema.is(AdminVdrActionSchema)

export function isAdminVdrAction(value: unknown): value is AdminVdrAction {
  return isAdminVdrActionValue(value)
}

const AdminVdrCapabilitySecretSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(ADMIN_VDR_CAPABILITY_SECRET_MIN_LENGTH),
    Schema.isMaxLength(ADMIN_VDR_CAPABILITY_SECRET_MAX_LENGTH)
  )
)

const isAdminVdrCapabilitySecret = Schema.is(AdminVdrCapabilitySecretSchema)

export function isValidAdminVdrCapabilitySecret(secret: string): boolean {
  return isAdminVdrCapabilitySecret(secret)
}

// El guarda se construye una vez por cota. `Schema.is` compila el AST cada vez
// que se llama, y esto corre en la frontera de autorización de cada acción admin
// del VDR: sin la caché, cada comprobación pagaría esa compilación.
const identifierGuards = new Map<number, (value: string) => boolean>()

function identifierGuard(maximum: number): (value: string) => boolean {
  const cached = identifierGuards.get(maximum)
  if (cached) return cached
  const guard = Schema.is(BindingIdentifier(maximum))
  identifierGuards.set(maximum, guard)
  return guard
}

export function isValidAdminVdrBindingIdentifier(value: string, maximum = 512): boolean {
  return identifierGuard(maximum)(value)
}

export function resolveAdminVdrCapabilityBoundaryConfig(input: {
  secret: string | undefined
  audience: string | undefined
}): { secret: string; audience: string } | null {
  if (
    !input.secret ||
    !isValidAdminVdrCapabilitySecret(input.secret) ||
    !input.audience ||
    !isValidAdminVdrBindingIdentifier(input.audience, 256)
  ) {
    return null
  }
  return { secret: input.secret, audience: input.audience }
}

function canonicalValue(value: unknown, depth: number): string | null {
  if (depth > 20) return null
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null

  if (Array.isArray(value)) {
    const items: string[] = []
    for (const item of value) {
      const canonical = canonicalValue(item, depth + 1)
      if (canonical === null) return null
      items.push(canonical)
    }
    return `[${items.join(',')}]`
  }

  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const entries: string[] = []
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue
    const canonical = canonicalValue(record[key], depth + 1)
    if (canonical === null) return null
    entries.push(`${JSON.stringify(key)}:${canonical}`)
  }
  return `{${entries.join(',')}}`
}

export function canonicalizeAdminVdrInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const canonical = canonicalValue(input, 0)
  if (
    !canonical ||
    new TextEncoder().encode(canonical).byteLength > ADMIN_VDR_CAPABILITY_MAX_INPUT_BYTES
  ) {
    return null
  }
  return canonical
}

function frame(value: string): string {
  return `${value.length}:${value}`
}

// ============================================================================
// LOS AMARRES DE LA PRUEBA, CADA UNO EN SU CAMPO
// ============================================================================
// La cota de cada campo va colgada del campo, y la única regla que cruza dos
// campos —la ventana es EXACTAMENTE el TTL, ni un milisegundo más ni menos— va
// colgada de la estructura. Antes las doce vivían juntas en un `if` y nada
// obligaba a que un campo nuevo trajera la suya.
const AdminVdrCapabilityProofBindingSchema = Schema.Struct({
  audience: BindingIdentifier(256),
  tokenHash: Sha256Hex,
  subject: BindingIdentifier(512),
  sessionId: BindingIdentifier(512),
  companyId: BindingIdentifier(512),
  action: AdminVdrActionSchema,
  target: BindingIdentifier(1_024),
  inputDigest: Sha256Hex,
  issuedAt: SafeEpochMs,
  expiresAt: SafeEpochMs,
}).pipe(
  Schema.check(
    Schema.makeFilter<{ readonly issuedAt: number; readonly expiresAt: number }>(
      (binding) => binding.expiresAt - binding.issuedAt === ADMIN_VDR_CAPABILITY_TTL_MS
    )
  )
)

export function buildAdminVdrCapabilityProofPayload(args: {
  audience: string
  tokenHash: string
  subject: string
  sessionId: string
  companyId: string
  action: AdminVdrAction
  target: string
  inputDigest: string
  issuedAt: number
  expiresAt: number
}): string | null {
  // Los campos se nombran uno por uno a propósito: quien llama pasa un objeto
  // más ancho (trae el secreto, el `now` y la prueba), y lo que se amarra tiene
  // que ser exactamente lo que la firma cubre.
  const binding = AdminVdrCapabilityProofBindingSchema.makeOption({
    audience: args.audience,
    tokenHash: args.tokenHash,
    subject: args.subject,
    sessionId: args.sessionId,
    companyId: args.companyId,
    action: args.action,
    target: args.target,
    inputDigest: args.inputDigest,
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
  })

  if (Option.isNone(binding)) return null
  const bound = binding.value

  return [
    ADMIN_VDR_CAPABILITY_VERSION,
    frame(bound.audience),
    frame(bound.tokenHash),
    frame(bound.subject),
    frame(bound.sessionId),
    frame(bound.companyId),
    bound.action,
    frame(bound.target),
    bound.inputDigest,
    `${bound.issuedAt}`,
    `${bound.expiresAt}`,
  ].join('\n')
}

export function adminVdrTarget(kind: string, id: string): string {
  return `${kind}:${id}`
}
