// ============================================================================
// VDR READ — server-proof wire format
// ============================================================================
// Shared by the Next.js route (which signs) and Convex (which verifies). The
// VDR read surface carries its OWN secret and audience: a Model Runs proof can
// never redeem a VDR read entry point and vice versa, because the version
// string, the operation vocabulary and the HMAC key all differ.
// ============================================================================

import { Option, Schema } from 'effect'

const VDR_READ_SERVER_PROOF_VERSION = 'vdr-read-server.v1' as const
export const VDR_READ_SERVER_PROOF_MAX_AGE_MS = 30_000
const VDR_READ_SERVER_SECRET_MIN_LENGTH = 32
const VDR_READ_SERVER_SECRET_MAX_LENGTH = 4_096
const VDR_READ_SERVER_AUDIENCE_MAX_LENGTH = 128
const MAX_BINDING_PARTS = 12
const MAX_BINDING_PART_LENGTH = 300_000

const VdrReadServerOperationSchema = Schema.Literals([
  'RESOLVE_BINDING',
  'READ_VERSION_BYTES',
  'READ_TEXT_INDEX',
  'WRITE_TEXT_INDEX',
  'AUDIT_TOOL',
  'ISSUE_UPLOAD_INTENT',
  'REGISTER_UPLOAD',
])

export type VdrReadServerOperation = typeof VdrReadServerOperationSchema.Type

const VdrReadServerAudience = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(1, VDR_READ_SERVER_AUDIENCE_MAX_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  )
)

const VdrReadServerSecret = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(VDR_READ_SERVER_SECRET_MIN_LENGTH, VDR_READ_SERVER_SECRET_MAX_LENGTH)
  )
)

// Un `bindingPart` de esta superficie sí puede venir vacío —el índice de texto
// manda cuerpos que a veces no traen nada—, así que el mínimo es 0 y no 1.
const VdrReadServerProofInput = Schema.Struct({
  operation: VdrReadServerOperationSchema,
  issuedAt: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
  ),
  audience: VdrReadServerAudience,
  bindingParts: Schema.Array(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_BINDING_PART_LENGTH)))
  ).pipe(Schema.check(Schema.isLengthBetween(1, MAX_BINDING_PARTS))),
})

const isValidAudience = Schema.is(VdrReadServerAudience)
const isValidSecret = Schema.is(VdrReadServerSecret)
const decodeProofInput = Schema.decodeUnknownOption(VdrReadServerProofInput)

export function isValidVdrReadServerAudience(audience: string): boolean {
  return isValidAudience(audience)
}

export function isValidVdrReadServerSecret(secret: string): boolean {
  return isValidSecret(secret)
}

export function buildVdrReadServerProofPayload(args: {
  operation: VdrReadServerOperation
  issuedAt: number
  audience: string
  bindingParts: readonly string[]
}): string | null {
  return Option.match(decodeProofInput(args), {
    onNone: () => null,
    onSome: (proof) => {
      const framed = proof.bindingParts.map((part) => `${part.length}:${part}`).join('\n')
      return `${VDR_READ_SERVER_PROOF_VERSION}\n${proof.audience.length}:${proof.audience}\n${proof.operation}\n${proof.issuedAt}\n${framed}`
    },
  })
}
