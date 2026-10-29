import { Effect, Schema } from 'effect'

import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { invalidState, unauthorized } from '../_helpers/errors'
import { sha256Hex } from './crypto'
import {
  buildIntakeServerProofPayload,
  INTAKE_SERVER_PROOF_MAX_AGE_MS,
  isIntakeDemoModeEnabled,
  resolveIntakeServerBoundaryConfig,
  type IntakeServerOperation,
} from './proofFormat'

const encoder = new TextEncoder()

const Base64UrlSignature = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const isBase64UrlSignature = Schema.is(Base64UrlSignature)

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!isBase64UrlSignature(value)) return null
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes.buffer
  } catch {
    return null
  }
}

const verifyHmacEffect = Effect.fn('IntakeServerProof.verifyHmac')(function* (
  secret: string,
  payload: string,
  proof: string
) {
  const signature = decodeBase64Url(proof)
  if (!signature) return false
  const key = yield* convexPromise(() =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
  )
  return yield* convexPromise(() =>
    crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload))
  )
})

export type IntakeServerProofInput = {
  serverIssuedAt: number
  proofNonce: string
  serverProof: string
}

const denied = () => unauthorized('Solicitud de servidor no autorizada.')

/**
 * A diferencia del proof de invitados, éste sí tiene libro de nonces: la firma
 * se consume una sola vez. Cada rechazo lleva nombre en la traza y todos le
 * dicen lo mismo al cliente.
 */
const consumeIntakeServerProofEffect = Effect.fn('IntakeServerProof.consume')(function* (args: {
  ctx: MutationCtx
  operation: IntakeServerOperation
  bindingParts: readonly string[]
  proof: IntakeServerProofInput
  intakeSessionId?: Id<'intakeSessions'>
  now?: number
}) {
  if (!isIntakeDemoModeEnabled()) {
    return yield* Effect.fail(
      invalidState('El acceso temporal no está disponible.', 'INTAKE_MODE_DISABLED')
    )
  }

  const now = args.now ?? Date.now()
  const config = resolveIntakeServerBoundaryConfig({
    secret: process.env.INTAKE_SERVER_SECRET,
    audience: process.env.INTAKE_SERVER_AUDIENCE,
  })
  const payload = buildIntakeServerProofPayload({
    operation: args.operation,
    issuedAt: args.proof.serverIssuedAt,
    nonce: args.proof.proofNonce,
    audience: config?.audience ?? '',
    bindingParts: args.bindingParts,
  })

  if (!config) {
    yield* Effect.annotateCurrentSpan('denied', 'BOUNDARY_NOT_CONFIGURED')
    return yield* Effect.fail(denied())
  }
  if (!payload) {
    yield* Effect.annotateCurrentSpan('denied', 'PAYLOAD_MALFORMED')
    return yield* Effect.fail(denied())
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    yield* Effect.annotateCurrentSpan('denied', 'CLOCK_UNUSABLE')
    return yield* Effect.fail(denied())
  }
  if (Math.abs(now - args.proof.serverIssuedAt) > INTAKE_SERVER_PROOF_MAX_AGE_MS) {
    yield* Effect.annotateCurrentSpan('denied', 'PROOF_EXPIRED')
    return yield* Effect.fail(denied())
  }
  if (!(yield* verifyHmacEffect(config.secret, payload, args.proof.serverProof))) {
    yield* Effect.annotateCurrentSpan('denied', 'SIGNATURE_MISMATCH')
    return yield* Effect.fail(denied())
  }

  const proofDigest = yield* convexPromise(() =>
    sha256Hex(`${config.audience}:${args.proof.proofNonce}:${args.proof.serverProof}`)
  )
  const consumed = yield* convexPromise(() =>
    args.ctx.db
      .query('intakeProofNonces')
      .withIndex('by_digest', (q) => q.eq('proofDigest', proofDigest))
      .unique()
  )
  if (consumed) {
    yield* Effect.annotateCurrentSpan('denied', 'PROOF_REPLAYED')
    return yield* Effect.fail(denied())
  }

  yield* convexPromise(() =>
    args.ctx.db.insert('intakeProofNonces', {
      proofDigest,
      operation: args.operation,
      intakeSessionId: args.intakeSessionId,
      consumedAt: now,
      expiresAt: now + INTAKE_SERVER_PROOF_MAX_AGE_MS * 2,
    })
  )
})

export async function consumeIntakeServerProof(args: {
  ctx: MutationCtx
  operation: IntakeServerOperation
  bindingParts: readonly string[]
  proof: IntakeServerProofInput
  intakeSessionId?: Id<'intakeSessions'>
  now?: number
}): Promise<void> {
  await runConvex(consumeIntakeServerProofEffect(args))
}
