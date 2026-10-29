import { Effect, Schema } from 'effect'

import { convexPromise, runConvex } from '../_helpers/effect'
import { unauthorized } from '../_helpers/errors'
import {
  buildVdrGuestServerProofPayload,
  resolveVdrGuestServerBoundaryConfig,
  VDR_GUEST_SERVER_PROOF_MAX_AGE_MS,
  type VdrGuestServerOperation,
} from './serverProofFormat'

const encoder = new TextEncoder()

// 43 caracteres base64url son los 32 bytes de un HMAC-SHA256 sin relleno.
const Base64UrlSignature = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const isBase64UrlSignature = Schema.is(Base64UrlSignature)

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!isBase64UrlSignature(value)) return null
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='
  try {
    const binary = atob(base64)
    const buffer = new ArrayBuffer(binary.length)
    const bytes = new Uint8Array(buffer)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return buffer
  } catch {
    return null
  }
}

const verifyHmacEffect = Effect.fn('VdrGuestServerProof.verifyHmac')(function* (
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

const denied = () => unauthorized('Solicitud de servidor no autorizada.')

/**
 * Cada motivo de rechazo tiene nombre en la traza y ninguno cambia lo que ve el
 * cliente: el mensaje sigue siendo el mismo para todos, porque decirle a un
 * atacante CUÁL de los cinco falló sería un oráculo.
 *
 * El orden importa y es el mismo de antes: el HMAC solo se calcula cuando la
 * configuración, el reloj y el payload ya pasaron.
 */
const requireVdrGuestServerProofEffect = Effect.fn('VdrGuestServerProof.require')(function* (args: {
  operation: VdrGuestServerOperation
  issuedAt: number
  proof: string
  bindingParts: readonly string[]
  now?: number
  secret?: string
  audience?: string
}) {
  const now = args.now ?? Date.now()
  const config = resolveVdrGuestServerBoundaryConfig({
    secret: args.secret ?? process.env.VDR_GUEST_SERVER_SECRET,
    audience: args.audience ?? process.env.VDR_GUEST_SERVER_AUDIENCE,
  })
  const payload = buildVdrGuestServerProofPayload({
    operation: args.operation,
    issuedAt: args.issuedAt,
    audience: config?.audience ?? '',
    bindingParts: args.bindingParts,
  })

  if (!config) {
    yield* Effect.annotateCurrentSpan('denied', 'BOUNDARY_NOT_CONFIGURED')
    yield* Effect.fail(denied())
    return
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    yield* Effect.annotateCurrentSpan('denied', 'CLOCK_UNUSABLE')
    yield* Effect.fail(denied())
    return
  }
  if (!payload) {
    yield* Effect.annotateCurrentSpan('denied', 'PAYLOAD_MALFORMED')
    yield* Effect.fail(denied())
    return
  }
  if (Math.abs(now - args.issuedAt) > VDR_GUEST_SERVER_PROOF_MAX_AGE_MS) {
    yield* Effect.annotateCurrentSpan('denied', 'PROOF_EXPIRED')
    yield* Effect.fail(denied())
    return
  }
  if (!(yield* verifyHmacEffect(config.secret, payload, args.proof))) {
    yield* Effect.annotateCurrentSpan('denied', 'SIGNATURE_MISMATCH')
    yield* Effect.fail(denied())
  }
})

export function requireVdrGuestServerProof(args: {
  operation: VdrGuestServerOperation
  issuedAt: number
  proof: string
  bindingParts: readonly string[]
  now?: number
  secret?: string
  audience?: string
}): Promise<void> {
  return runConvex(requireVdrGuestServerProofEffect(args))
}
