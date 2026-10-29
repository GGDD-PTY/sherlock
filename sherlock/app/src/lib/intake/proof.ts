import { createHmac, randomBytes } from 'node:crypto'

import { Effect, Schema } from 'effect'

import {
  buildIntakeServerProofPayload,
  resolveIntakeServerBoundaryConfig,
  type IntakeServerOperation,
} from '@/../convex/_intake/proofFormat'
import { throwEffectError } from '@/lib/effect/runtime'

/**
 * El único fallo esperado de esta frontera: sin secreto o audiencia válidos, o
 * con un binding que el formato compartido rechaza. Antes era un `throw new
 * Error` que ningún caller veía en el tipo; ahora vive en el canal de error del
 * Effect. El mensaje sigue siendo `INTAKE_SERVER_BOUNDARY_UNAVAILABLE` para el
 * puente síncrono que usan las rutas y los tests de Convex.
 */
class IntakeProofError extends Schema.TaggedError<IntakeProofError>()('IntakeProofError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

function boundaryUnavailable(operation: string): IntakeProofError {
  return new IntakeProofError({ operation, message: 'INTAKE_SERVER_BOUNDARY_UNAVAILABLE' })
}

// Estos secretos se leen en cada llamada y no desde `@/lib/env`: `env` es un
// snapshot del arranque y las suites del intake los inyectan por test con
// `vi.stubEnv`.
function intakeBoundaryConfig(secret: string | undefined, audience: string | undefined) {
  return resolveIntakeServerBoundaryConfig({
    secret: secret ?? process.env.INTAKE_SERVER_SECRET,
    audience: audience ?? process.env.INTAKE_SERVER_AUDIENCE,
  })
}

function runIntakeProofSync<A>(effect: Effect.Effect<A, IntakeProofError>): A {
  const outcome = Effect.runSync(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (!outcome.ok) throwEffectError(outcome.error)
  return outcome.value
}

const createIntakeServerProofEffect = Effect.fn('IntakeProof.createServerProof')(function* (args: {
  operation: IntakeServerOperation
  bindingParts: readonly string[]
  issuedAt?: number
  nonce?: string
  secret?: string
  audience?: string
}) {
  const serverIssuedAt = args.issuedAt ?? Date.now()
  const proofNonce = args.nonce ?? randomBytes(24).toString('base64url')
  const config = intakeBoundaryConfig(args.secret, args.audience)
  const payload = buildIntakeServerProofPayload({
    operation: args.operation,
    issuedAt: serverIssuedAt,
    nonce: proofNonce,
    audience: config?.audience ?? '',
    bindingParts: args.bindingParts,
  })
  if (!config || !payload) return yield* boundaryUnavailable(args.operation)
  return {
    serverIssuedAt,
    proofNonce,
    serverProof: createHmac('sha256', config.secret).update(payload).digest('base64url'),
  }
})

/** Puente síncrono para las rutas y los tests de Convex que ya lo llamaban así. */
export function createIntakeServerProof(args: {
  operation: IntakeServerOperation
  bindingParts: readonly string[]
  issuedAt?: number
  nonce?: string
  secret?: string
  audience?: string
}): { serverIssuedAt: number; proofNonce: string; serverProof: string } {
  return runIntakeProofSync(createIntakeServerProofEffect(args))
}

const createIntakeAnonymousKeyEffect = Effect.fn('IntakeProof.createAnonymousKey')(function* (
  value: string,
  secret?: string
) {
  const config = intakeBoundaryConfig(secret, undefined)
  if (!config) return yield* boundaryUnavailable('ANONYMOUS_KEY')
  return createHmac('sha256', config.secret)
    .update(`intake-anonymous-origin:v1:${value}`)
    .digest('hex')
})

/** Puente síncrono para `/api/intake/session`. */
export function createIntakeAnonymousKey(value: string, secret?: string): string {
  return runIntakeProofSync(createIntakeAnonymousKeyEffect(value, secret))
}
