import { Effect, Schema } from 'effect'

import { convexPromise, runConvex } from '../_helpers/effect'
import { unauthorized } from '../_helpers/errors'
import {
  buildVdrReadServerProofPayload,
  isValidVdrReadServerAudience,
  isValidVdrReadServerSecret,
  VDR_READ_SERVER_PROOF_MAX_AGE_MS,
  type VdrReadServerOperation,
} from './serverProofFormat'

const encoder = new TextEncoder()

const Base64UrlSignature = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const isBase64UrlSignature = Schema.is(Base64UrlSignature)

function decodeProof(value: string): Uint8Array<ArrayBuffer> | null {
  if (!isBase64UrlSignature(value)) return null
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=')
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

const denied = () => unauthorized('Solicitud de servidor no autorizada.')

const requireVdrReadServerProofEffect = Effect.fn('VdrReadServerProof.require')(function* (args: {
  operation: VdrReadServerOperation
  issuedAt: number
  proof: string
  bindingParts: readonly string[]
  now?: number
  secret?: string
  audience?: string
}) {
  const now = args.now ?? Date.now()
  const secret = args.secret ?? process.env.VDR_MCP_SERVER_SECRET ?? ''
  const audience = args.audience ?? process.env.VDR_MCP_SERVER_AUDIENCE ?? ''
  const payload = buildVdrReadServerProofPayload({
    operation: args.operation,
    issuedAt: args.issuedAt,
    audience,
    bindingParts: args.bindingParts,
  })
  const signature = decodeProof(args.proof)

  if (
    !isValidVdrReadServerSecret(secret) ||
    !isValidVdrReadServerAudience(audience) ||
    !payload ||
    !signature ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    Math.abs(now - args.issuedAt) > VDR_READ_SERVER_PROOF_MAX_AGE_MS
  ) {
    yield* Effect.annotateCurrentSpan('denied', 'PROOF_UNUSABLE')
    yield* Effect.fail(denied())
    return
  }

  const key = yield* convexPromise(() =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
  )
  const verified = yield* convexPromise(() =>
    crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload))
  )
  if (!verified) {
    yield* Effect.annotateCurrentSpan('denied', 'SIGNATURE_MISMATCH')
    yield* Effect.fail(denied())
  }
})

export function requireVdrReadServerProof(args: {
  operation: VdrReadServerOperation
  issuedAt: number
  proof: string
  bindingParts: readonly string[]
  now?: number
  secret?: string
  audience?: string
}): Promise<void> {
  return runConvex(requireVdrReadServerProofEffect(args))
}
