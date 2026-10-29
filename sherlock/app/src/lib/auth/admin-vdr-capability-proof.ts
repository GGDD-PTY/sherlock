import { createHash, createHmac, randomBytes } from 'node:crypto'

import { Effect, Schema } from 'effect'

import {
  ADMIN_VDR_CAPABILITY_TTL_MS,
  buildAdminVdrCapabilityProofPayload,
  canonicalizeAdminVdrInput,
  resolveAdminVdrCapabilityBoundaryConfig,
  type AdminVdrAction,
} from '@/../convex/_adminVdr/capabilityFormat'

/**
 * La capability no se emite: falta la frontera (secreto/audiencia/input
 * canónico) o el binding no encuadra. El mensaje es el código estable que la
 * ruta ya convierte en 403/500 — nunca viaja tal cual al cliente.
 */
class AdminVdrCapabilityProofError extends Schema.TaggedError<AdminVdrCapabilityProofError>()(
  'AdminVdrCapabilityProofError',
  {
    action: Schema.String,
    message: Schema.String,
  }
) {}

type AdminVdrCapabilityProofArgs = {
  subject: string
  sessionId: string
  companyId: string
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
  issuedAt?: number
  secret?: string
  audience?: string
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const createAdminVdrCapabilityProofEffect = Effect.fn('AdminVdrCapabilityProof.create')(function* (
  args: AdminVdrCapabilityProofArgs
) {
  const issuedAt = args.issuedAt ?? Date.now()
  const expiresAt = issuedAt + ADMIN_VDR_CAPABILITY_TTL_MS
  const canonicalInput = canonicalizeAdminVdrInput(args.input)
  const config = resolveAdminVdrCapabilityBoundaryConfig({
    secret: args.secret ?? process.env.ADMIN_VDR_CAPABILITY_SECRET,
    audience: args.audience ?? process.env.WORKOS_CLIENT_ID,
  })
  if (!canonicalInput || !config) {
    return yield* new AdminVdrCapabilityProofError({
      action: args.action,
      message: 'ADMIN_VDR_CAPABILITY_BOUNDARY_UNAVAILABLE',
    })
  }

  const capability = `avc_${randomBytes(32).toString('base64url')}`
  const tokenHash = sha256Hex(capability)
  const inputDigest = sha256Hex(canonicalInput)
  const payload = buildAdminVdrCapabilityProofPayload({
    audience: config.audience,
    tokenHash,
    subject: args.subject,
    sessionId: args.sessionId,
    companyId: args.companyId,
    action: args.action,
    target: args.target,
    inputDigest,
    issuedAt,
    expiresAt,
  })
  if (!payload) {
    return yield* new AdminVdrCapabilityProofError({
      action: args.action,
      message: 'ADMIN_VDR_CAPABILITY_BINDING_INVALID',
    })
  }

  return {
    capability,
    issuance: {
      tokenHash,
      companyId: args.companyId,
      action: args.action,
      target: args.target,
      inputDigest,
      issuedAt,
      expiresAt,
      proof: createHmac('sha256', config.secret).update(payload).digest('base64url'),
    },
  }
})

// Puente síncrono para el emisor de servidor y los tests de frontera.
export function createAdminVdrCapabilityProof(args: AdminVdrCapabilityProofArgs) {
  return Effect.runSync(createAdminVdrCapabilityProofEffect(args))
}
