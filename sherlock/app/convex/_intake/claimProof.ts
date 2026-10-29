import { Schema } from 'effect'

import { isValidIntakeServerAudience } from './proofFormat'

const INTAKE_CLAIM_PROOF_VERSION = 'intake-claim.v1' as const
const INTAKE_CLAIM_NONCE_VERSION = 'intake-claim-nonce.v1' as const

// Los tres formatos que el navegador puede mandar, cada uno con una definición.
const OpaqueToken = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const ClaimSubject = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_:@./-]{1,256}$/))
)

const isOpaqueToken = Schema.is(OpaqueToken)
const isClaimNonce = Schema.is(OpaqueToken)
const isClaimSubject = Schema.is(ClaimSubject)

export function isValidIntakeClaimSubject(value: string): boolean {
  return isClaimSubject(value)
}

function frame(value: string): string {
  return `${value.length}:${value}`
}

export function buildIntakeClaimNoncePayload(args: {
  audience: string
  sessionToken: string
  workosSubject: string
}): string | null {
  if (
    !isValidIntakeServerAudience(args.audience) ||
    !isOpaqueToken(args.sessionToken) ||
    !isClaimSubject(args.workosSubject)
  ) {
    return null
  }
  return `${INTAKE_CLAIM_NONCE_VERSION}\n${frame(args.audience)}\n${frame(args.sessionToken)}\n${frame(args.workosSubject)}`
}

export function buildIntakeClaimProofPayload(args: {
  audience: string
  sessionToken: string
  workosSubject: string
  claimNonce: string
}): string | null {
  if (!isClaimNonce(args.claimNonce)) return null
  const nonceBinding = buildIntakeClaimNoncePayload(args)
  if (!nonceBinding) return null
  return `${INTAKE_CLAIM_PROOF_VERSION}\n${nonceBinding}\n${frame(args.claimNonce)}`
}
