// ============================================================================
// LA PRUEBA DE SERVIDOR DE UNA CAPACIDAD ADMIN DEL VDR
// ============================================================================
// Un solo camino de éxito y un solo `AppError` de salida: o la prueba amarra
// (audiencia, secreto, payload, reloj, vencimiento y HMAC) o la solicitud no
// está autorizada. El detalle de CUÁL amarre falló no sale nunca — decirlo es
// decirle a quien prueba cómo acercarse.
//
// El orden importa y por eso el programa es una secuencia y no una conjunción:
// el HMAC es lo caro y va de último, después de que las cotas baratas ya
// descartaron lo que no puede firmar.
// ============================================================================

import { Effect } from 'effect'

import { convexPromise, runConvex } from '../_helpers/effect'
import { unauthorized } from '../_helpers/errors'
import {
  ADMIN_VDR_CAPABILITY_MAX_CLOCK_SKEW_MS,
  buildAdminVdrCapabilityProofPayload,
  resolveAdminVdrCapabilityBoundaryConfig,
  type AdminVdrAction,
} from './capabilityFormat'

const encoder = new TextEncoder()
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Una sola salida de rechazo: nunca se dice CUÁL de los amarres falló. */
function denied() {
  return unauthorized('Solicitud de servidor no autorizada.')
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!PROOF_PATTERN.test(value)) return null
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

const verifyHmac = Effect.fn('AdminVdrCapability.verifyHmac')(function* (
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

type AdminVdrCapabilityServerProofArgs = {
  tokenHash: string
  subject: string
  sessionId: string
  companyId: string
  action: AdminVdrAction
  target: string
  inputDigest: string
  issuedAt: number
  expiresAt: number
  proof: string
  now?: number
  secret?: string
  audience?: string
}

const requireServerProof = Effect.fn('AdminVdrCapability.requireServerProof')(function* (
  args: AdminVdrCapabilityServerProofArgs
) {
  const now = args.now ?? Date.now()

  const config = resolveAdminVdrCapabilityBoundaryConfig({
    secret: args.secret ?? process.env.ADMIN_VDR_CAPABILITY_SECRET,
    audience: args.audience ?? process.env.WORKOS_CLIENT_ID,
  })
  if (!config) return yield* Effect.fail(denied())

  const payload = buildAdminVdrCapabilityProofPayload({ ...args, audience: config.audience })
  if (!payload) return yield* Effect.fail(denied())

  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    Math.abs(now - args.issuedAt) > ADMIN_VDR_CAPABILITY_MAX_CLOCK_SKEW_MS ||
    args.expiresAt <= now
  ) {
    return yield* Effect.fail(denied())
  }

  const verified = yield* verifyHmac(config.secret, payload, args.proof)
  if (!verified) return yield* Effect.fail(denied())
})

export function requireAdminVdrCapabilityServerProof(
  args: AdminVdrCapabilityServerProofArgs
): Promise<void> {
  return runConvex(requireServerProof(args))
}
