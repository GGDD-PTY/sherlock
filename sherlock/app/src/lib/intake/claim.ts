import { createHmac } from 'node:crypto'

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { Duration, Effect, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import {
  buildIntakeClaimNoncePayload,
  buildIntakeClaimProofPayload,
  isValidIntakeClaimSubject,
} from '@/../convex/_intake/claimProof'
import { resolveIntakeServerBoundaryConfig } from '@/../convex/_intake/proofFormat'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect, throwEffectError } from '@/lib/effect/runtime'

type IntakeClaimResult =
  | {
      status: 'PROCESSING'
      claimDigest: string
      companyId: string
    }
  | {
      status: 'FAILED'
      claimDigest: string
      companyId: string
      code: 'CLAIM_RECONCILIATION_REQUIRED'
      completedAt: number
    }
  | {
      status: 'SUCCEEDED'
      claimDigest: string
      companyId: string
      documentIds: string[]
      claimedDocumentCount: number
      skippedDocumentCount: number
      completedAt: number
      // El nombre declarado en la landing. Llega aunque la sala no se haya
      // renombrado (`convex/_intake/claim.ts`, `intakeOwnsCompanyName`).
      declaredName?: string
    }

type IntakeClaimSucceeded = Extract<IntakeClaimResult, { status: 'SUCCEEDED' }>

/**
 * Los siete fallos esperados del claim autenticado. Eran siete `throw new
 * Error` que ningún caller veía en el tipo; ahora el código está en el tipo y
 * el mensaje lo repite, porque ese mensaje ya es el contrato que leen la ruta
 * de claim, el callback y sus tests.
 */
const IntakeClaimErrorCodeSchema = Schema.Literals([
  'INTAKE_CLAIM_BOUNDARY_UNAVAILABLE',
  'INTAKE_CLAIM_BINDING_INVALID',
  'INTAKE_CLAIM_COMPANY_UNAVAILABLE',
  'INTAKE_CLAIM_RECONCILIATION_REQUIRED',
  'INTAKE_CLAIM_INCOMPLETE',
  'INTAKE_CLAIM_SUBJECT_MISMATCH',
  'INTAKE_CLAIM_BACKEND_UNAVAILABLE',
])

type IntakeClaimErrorCode = typeof IntakeClaimErrorCodeSchema.Type

class IntakeClaimError extends Schema.TaggedError<IntakeClaimError>()('IntakeClaimError', {
  code: IntakeClaimErrorCodeSchema,
  message: Schema.String,
}) {}

function claimError(code: IntakeClaimErrorCode): IntakeClaimError {
  return new IntakeClaimError({ code, message: code })
}

/**
 * Un intento que llegó a Convex pero todavía no dejó el claim en SUCCEEDED. No
 * es un fallo de transporte: es el estado durable del claim, y es la única
 * condición de reintento (antes, un `for` de cuatro vueltas).
 */
class IntakeClaimPending extends Schema.TaggedError<IntakeClaimPending>()('IntakeClaimPending', {
  status: Schema.Literals(['PROCESSING', 'FAILED']),
  message: Schema.String,
}) {}

const CLAIM_RETRY_TIMES = 3

type ClaimClient = Pick<ConvexHttpClient, 'mutation'>

const ensureCompanyWorkspaceRef = makeFunctionReference<
  'mutation',
  Record<string, never>,
  {
    created: boolean
    role: 'COMPANY' | 'ADMIN'
    company: { _id: Id<'companies'>; onboardingCompletedAt?: number } | null
  }
>('companies:ensureCompanyWorkspace')

const claimIntakeRef = makeFunctionReference<
  'mutation',
  {
    sessionToken: string
    workosSubject: string
    claimNonce: string
    claimProof: string
  },
  IntakeClaimResult
>('intake:claimToAuthenticatedCompany')

// El secreto se lee en cada llamada y no desde `@/lib/env`: `env` es un
// snapshot del arranque y las suites del intake lo inyectan con `vi.stubEnv`.
const claimBoundaryConfig = Effect.fn('IntakeClaim.boundaryConfig')(function* (
  secret?: string,
  audience?: string
) {
  const config = resolveIntakeServerBoundaryConfig({
    secret: secret ?? process.env.INTAKE_SERVER_SECRET,
    audience: audience ?? process.env.INTAKE_SERVER_AUDIENCE,
  })
  if (!config) return yield* claimError('INTAKE_CLAIM_BOUNDARY_UNAVAILABLE')
  return config
})

const createIntakeClaimProofEffect = Effect.fn('IntakeClaim.createProof')(function* (args: {
  sessionToken: string
  workosSubject: string
  secret?: string
  audience?: string
}) {
  const config = yield* claimBoundaryConfig(args.secret, args.audience)
  const noncePayload = buildIntakeClaimNoncePayload({
    audience: config.audience,
    sessionToken: args.sessionToken,
    workosSubject: args.workosSubject,
  })
  if (!noncePayload) return yield* claimError('INTAKE_CLAIM_BINDING_INVALID')
  const claimNonce = createHmac('sha256', config.secret).update(noncePayload).digest('base64url')
  const proofPayload = buildIntakeClaimProofPayload({
    audience: config.audience,
    sessionToken: args.sessionToken,
    workosSubject: args.workosSubject,
    claimNonce,
  })
  if (!proofPayload) return yield* claimError('INTAKE_CLAIM_BINDING_INVALID')
  return {
    claimNonce,
    claimProof: createHmac('sha256', config.secret).update(proofPayload).digest('base64url'),
  }
})

const readWorkosSubjectEffect = Effect.fn('IntakeClaim.readSubject')(function* (
  accessToken: string
) {
  const encoded = accessToken.split('.')[1]
  if (!encoded) return null
  const claims = yield* Effect.try({
    try: () =>
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>,
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onSuccess: (value) => value,
      onFailure: () => null,
    })
  )
  return typeof claims?.sub === 'string' && isValidIntakeClaimSubject(claims.sub)
    ? claims.sub
    : null
})

export function readWorkosSubjectFromAccessToken(accessToken: string): string | null {
  return Effect.runSync(readWorkosSubjectEffect(accessToken))
}

/** Puente síncrono: los tests de Convex firman con esta función, no con otra copia del HMAC. */
export function createIntakeClaimProof(args: {
  sessionToken: string
  workosSubject: string
  secret?: string
  audience?: string
}): { claimNonce: string; claimProof: string } {
  const outcome = Effect.runSync(
    createIntakeClaimProofEffect(args).pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

// Las llamadas a Convex pasan por `externalCall` con reintento cero y sin techo
// de tiempo: el proof es el mismo en las cuatro vueltas y una sala grande no
// puede perder su claim por un reloj de la capa de transporte.
function claimMutation<A>(operation: string, run: () => PromiseLike<A>) {
  return externalCall({
    service: 'Convex',
    operation,
    retries: 0,
    timeout: Duration.infinity,
    run,
  })
}

const attemptIntakeClaim = Effect.fn('IntakeClaim.attempt')(function* (
  client: ClaimClient,
  request: {
    sessionToken: string
    workosSubject: string
    claimNonce: string
    claimProof: string
  }
) {
  const result = yield* claimMutation('intake.claimToAuthenticatedCompany', () =>
    client.mutation(claimIntakeRef, request)
  )
  if (result.status === 'SUCCEEDED') return result
  return yield* new IntakeClaimPending({ status: result.status, message: result.status })
})

const provisionAndClaimIntakeEffect = Effect.fn('IntakeClaim.provisionAndClaim')(function* (args: {
  client: ClaimClient
  sessionToken: string
  workosSubject: string
}) {
  const workspace = yield* claimMutation('companies.ensureCompanyWorkspace', () =>
    args.client.mutation(ensureCompanyWorkspaceRef, {})
  )
  if (workspace.role !== 'COMPANY' || !workspace.company) {
    return yield* claimError('INTAKE_CLAIM_COMPANY_UNAVAILABLE')
  }

  // Un solo proof para las cuatro vueltas: el digest es la llave de
  // idempotencia del claim y rehacerlo abriría un segundo claim.
  const proof = yield* createIntakeClaimProofEffect(args)
  return yield* attemptIntakeClaim(args.client, {
    sessionToken: args.sessionToken,
    workosSubject: args.workosSubject,
    ...proof,
  }).pipe(
    Effect.retry({
      times: CLAIM_RETRY_TIMES,
      while: (error) => error._tag === 'IntakeClaimPending',
    }),
    Effect.catchTag('IntakeClaimPending', (pending) =>
      Effect.fail(
        claimError(
          pending.status === 'FAILED'
            ? 'INTAKE_CLAIM_RECONCILIATION_REQUIRED'
            : 'INTAKE_CLAIM_INCOMPLETE'
        )
      )
    )
  )
})

const claimIntakeAfterAuthenticationEffect = Effect.fn('IntakeClaim.afterAuthentication')(
  function* (args: { accessToken: string; sessionToken: string; workosSubject: string }) {
    const subject = yield* readWorkosSubjectEffect(args.accessToken)
    if (subject !== args.workosSubject) return yield* claimError('INTAKE_CLAIM_SUBJECT_MISMATCH')
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
    if (!convexUrl) return yield* claimError('INTAKE_CLAIM_BACKEND_UNAVAILABLE')
    const client = new ConvexHttpClient(convexUrl)
    client.setAuth(args.accessToken)
    return yield* provisionAndClaimIntakeEffect({
      client,
      sessionToken: args.sessionToken,
      workosSubject: args.workosSubject,
    })
  }
)

/** La única costura a Promise del claim: `/api/intake/claim` y `/callback`. */
async function runIntakeClaimEffect<E>(
  effect: Effect.Effect<IntakeClaimSucceeded, E>
): Promise<IntakeClaimSucceeded> {
  const outcome = await runServerEffect(
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

export function provisionAndClaimIntake(args: {
  client: ClaimClient
  sessionToken: string
  workosSubject: string
}): Promise<IntakeClaimSucceeded> {
  return runIntakeClaimEffect(provisionAndClaimIntakeEffect(args))
}

export function claimIntakeAfterAuthentication(args: {
  accessToken: string
  sessionToken: string
  workosSubject: string
}): Promise<IntakeClaimSucceeded> {
  return runIntakeClaimEffect(claimIntakeAfterAuthenticationEffect(args))
}
