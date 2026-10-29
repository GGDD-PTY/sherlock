import { Option, Schema } from 'effect'

const VDR_GUEST_SERVER_PROOF_VERSION = 'vdr-guest-server.v1' as const
export const VDR_GUEST_SERVER_PROOF_MAX_AGE_MS = 30_000
const VDR_GUEST_SERVER_PROOF_MAX_PARTS = 4
const VDR_GUEST_SERVER_PROOF_MAX_PART_LENGTH = 512
export const VDR_GUEST_SERVER_AUDIENCE_MAX_LENGTH = 128
const VDR_GUEST_SERVER_SECRET_MIN_LENGTH = 32
export const VDR_GUEST_SERVER_SECRET_MAX_LENGTH = 4_096

const VdrGuestServerOperationSchema = Schema.Literals([
  'REQUEST_OTP',
  'VERIFY_OTP',
  'RESOLVE_SESSION',
  'PROJECT_ROOM',
  'READ_NDA',
  'ACCEPT_NDA',
  'VIEW_DOCUMENT',
  'ROTATE_SESSION',
  'REVOKE_SESSION',
])

export type VdrGuestServerOperation = typeof VdrGuestServerOperationSchema.Type

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type VdrGuestServerReplayPolicy = 'IDEMPOTENT' | 'ONE_TIME' | 'RATE_LIMITED'

/**
 * The proof itself has a bounded 30-second replay window because there is no
 * nonce ledger yet. These downstream operation semantics keep an identical
 * replay from widening authority: reads re-evaluate authorization, one-time
 * transitions consume/rotate state, and OTP requests enforce rate limits.
 *
 * This table is a claim about the HANDLERS, not about `requireVdrGuestServerProof`,
 * which never reads it. RATE_LIMITED is satisfied by the per-session budget in
 * `sessions.ts` (`loadSessionByRawToken` -> `enforceRateLimit`); `company-guest-access`
 * pins that for VIEW_DOCUMENT so the claim stays executed instead of asserted.
 */
export const VDR_GUEST_SERVER_OPERATION_REPLAY_POLICY = {
  REQUEST_OTP: 'RATE_LIMITED',
  VERIFY_OTP: 'ONE_TIME',
  RESOLVE_SESSION: 'IDEMPOTENT',
  PROJECT_ROOM: 'IDEMPOTENT',
  READ_NDA: 'IDEMPOTENT',
  ACCEPT_NDA: 'IDEMPOTENT',
  VIEW_DOCUMENT: 'RATE_LIMITED',
  ROTATE_SESSION: 'ONE_TIME',
  REVOKE_SESSION: 'IDEMPOTENT',
} as const satisfies Record<VdrGuestServerOperation, VdrGuestServerReplayPolicy>

const VdrGuestServerAudience = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(1, VDR_GUEST_SERVER_AUDIENCE_MAX_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  )
)

const VdrGuestServerSecret = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(VDR_GUEST_SERVER_SECRET_MIN_LENGTH, VDR_GUEST_SERVER_SECRET_MAX_LENGTH)
  )
)

const VdrGuestServerBoundaryConfig = Schema.Struct({
  secret: VdrGuestServerSecret,
  audience: VdrGuestServerAudience,
})

/**
 * La forma exacta que el payload firmado exige. Antes cada regla vivía en un
 * `if` distinto de `buildVdrGuestServerProofPayload` y la lista de operaciones
 * válidas se leía de las llaves de la tabla de replay —una segunda fuente de
 * verdad—; ahora la operación se valida contra el mismo literal que da el tipo.
 */
const VdrGuestServerProofInput = Schema.Struct({
  operation: VdrGuestServerOperationSchema,
  issuedAt: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
  ),
  audience: VdrGuestServerAudience,
  bindingParts: Schema.Array(
    Schema.String.pipe(
      Schema.check(Schema.isLengthBetween(1, VDR_GUEST_SERVER_PROOF_MAX_PART_LENGTH))
    )
  ).pipe(Schema.check(Schema.isLengthBetween(1, VDR_GUEST_SERVER_PROOF_MAX_PARTS))),
})

const isValidAudience = Schema.is(VdrGuestServerAudience)
const isValidSecret = Schema.is(VdrGuestServerSecret)
const decodeBoundaryConfig = Schema.decodeUnknownOption(VdrGuestServerBoundaryConfig)
const decodeProofInput = Schema.decodeUnknownOption(VdrGuestServerProofInput)

export function isValidVdrGuestServerAudience(audience: string): boolean {
  return isValidAudience(audience)
}

export function isValidVdrGuestServerSecret(secret: string): boolean {
  return isValidSecret(secret)
}

export function resolveVdrGuestServerBoundaryConfig(input: {
  secret: string | undefined
  audience: string | undefined
}): { secret: string; audience: string } | null {
  return Option.getOrNull(decodeBoundaryConfig(input))
}

export function buildVdrGuestServerProofPayload(args: {
  operation: VdrGuestServerOperation
  issuedAt: number
  audience: string
  bindingParts: readonly string[]
}): string | null {
  return Option.match(decodeProofInput(args), {
    onNone: () => null,
    onSome: (proof) => {
      const framedParts = proof.bindingParts.map((part) => `${part.length}:${part}`).join('\n')
      return `${VDR_GUEST_SERVER_PROOF_VERSION}\n${proof.audience.length}:${proof.audience}\n${proof.operation}\n${proof.issuedAt}\n${framedParts}`
    },
  })
}
