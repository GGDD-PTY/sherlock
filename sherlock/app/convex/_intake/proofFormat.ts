import { Option, Schema } from 'effect'

const INTAKE_SERVER_PROOF_VERSION = 'intake-server.v1' as const
export const INTAKE_SERVER_PROOF_MAX_AGE_MS = 30_000
const INTAKE_SERVER_PROOF_MAX_PARTS = 8
const INTAKE_SERVER_PROOF_MAX_PART_LENGTH = 512
const INTAKE_SERVER_AUDIENCE_MAX_LENGTH = 128
const INTAKE_SERVER_SECRET_MIN_LENGTH = 32
const INTAKE_SERVER_SECRET_MAX_LENGTH = 4_096

// Una sola lista de operaciones: antes el tipo unión y el `Set` de validación
// se escribían por separado y nada obligaba a que coincidieran.
const IntakeServerOperationSchema = Schema.Literals([
  'CREATE_SESSION',
  'RESOLVE_SESSION',
  'PROJECT_WORKSPACE',
  'ROTATE_SESSION',
  'REVOKE_SESSION',
  'ISSUE_UPLOAD',
  'REGISTER_UPLOAD',
  'SUPPORT_READ',
  'SUPPORT_SEND',
  'DELETE_DATA',
])

export type IntakeServerOperation = typeof IntakeServerOperationSchema.Type

const IntakeServerAudience = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(1, INTAKE_SERVER_AUDIENCE_MAX_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  )
)

const IntakeServerSecret = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(INTAKE_SERVER_SECRET_MIN_LENGTH, INTAKE_SERVER_SECRET_MAX_LENGTH)
  )
)

const IntakeServerBoundaryConfig = Schema.Struct({
  secret: IntakeServerSecret,
  audience: IntakeServerAudience,
})

const IntakeProofNonce = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(24, 128), Schema.isPattern(/^[A-Za-z0-9_-]+$/))
)

/** La forma completa del payload firmado, en una sola definición. */
const IntakeServerProofInput = Schema.Struct({
  operation: IntakeServerOperationSchema,
  issuedAt: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
  ),
  nonce: IntakeProofNonce,
  audience: IntakeServerAudience,
  bindingParts: Schema.Array(
    Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, INTAKE_SERVER_PROOF_MAX_PART_LENGTH)))
  ).pipe(Schema.check(Schema.isLengthBetween(1, INTAKE_SERVER_PROOF_MAX_PARTS))),
})

const isValidAudience = Schema.is(IntakeServerAudience)
const isValidSecret = Schema.is(IntakeServerSecret)
const decodeBoundaryConfig = Schema.decodeUnknownOption(IntakeServerBoundaryConfig)
const decodeProofInput = Schema.decodeUnknownOption(IntakeServerProofInput)

export function isIntakeDemoModeEnabled(value = process.env.INTAKE_DEMO_MODE): boolean {
  return value === 'true'
}

export function isValidIntakeServerAudience(audience: string): boolean {
  return isValidAudience(audience)
}

export function isValidIntakeServerSecret(secret: string): boolean {
  return isValidSecret(secret)
}

export function resolveIntakeServerBoundaryConfig(input: {
  secret: string | undefined
  audience: string | undefined
}): { secret: string; audience: string } | null {
  return Option.getOrNull(decodeBoundaryConfig(input))
}

export function buildIntakeServerProofPayload(args: {
  operation: IntakeServerOperation
  issuedAt: number
  nonce: string
  audience: string
  bindingParts: readonly string[]
}): string | null {
  return Option.match(decodeProofInput(args), {
    onNone: () => null,
    onSome: (proof) => {
      const framedParts = proof.bindingParts.map((part) => `${part.length}:${part}`).join('\n')
      return `${INTAKE_SERVER_PROOF_VERSION}\n${proof.audience.length}:${proof.audience}\n${proof.operation}\n${proof.issuedAt}\n${proof.nonce.length}:${proof.nonce}\n${framedParts}`
    },
  })
}
