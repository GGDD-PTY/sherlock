import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Effect, Schema } from 'effect'
import type { NextRequest, NextResponse } from 'next/server'

import { resolveIntakeServerBoundaryConfig } from '@/../convex/_intake/proofFormat'
import { validateOrigin } from '@/lib/api/csrf'
import { throwEffectError } from '@/lib/effect/runtime'
import { INTAKE_CSRF_HEADER } from './config'
import type { IntakeCookieWriter } from './session'

export { INTAKE_CSRF_HEADER } from './config'
export const INTAKE_CSRF_BOOTSTRAP_BINDING = 'BOOTSTRAP'
const INTAKE_CSRF_BOOTSTRAP_TTL_MS = 10 * 60 * 1000
const INTAKE_CSRF_SESSION_TTL_MS = 65 * 60 * 1000
const INTAKE_CSRF_MAX_CLOCK_SKEW_MS = 30_000
const TOKEN_PATTERN = /^ics_([a-z0-9]{8,11})_([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/

/**
 * Los dos fallos esperados de la emisión del token: la frontera sin secreto o
 * audiencia válidos, y un binding fuera de formato. Eran dos `throw new Error`
 * que `validateIntakeCsrfToken` tenía que atrapar con un `catch` ciego; ahora
 * son un fallo tipado que la validación recupera por tag.
 */
class IntakeCsrfError extends Schema.TaggedError<IntakeCsrfError>()('IntakeCsrfError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export function getIntakeCsrfCookieName(
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  return nodeEnv === 'production' ? '__Host-sherlock-intake-csrf' : 'sherlock-intake-csrf-dev'
}

function csrfCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return {
    httpOnly: false,
    secure: nodeEnv === 'production',
    sameSite: 'strict' as const,
    path: '/',
  }
}

// El secreto se lee en cada llamada y no desde `@/lib/env`: `env` es un
// snapshot del arranque y las suites del intake lo inyectan con `vi.stubEnv`.
const csrfConfigEffect = Effect.fn('IntakeCsrf.config')(function* (
  secret?: string,
  audience?: string
) {
  const config = resolveIntakeServerBoundaryConfig({
    secret: secret ?? process.env.INTAKE_SERVER_SECRET,
    audience: audience ?? process.env.INTAKE_SERVER_AUDIENCE,
  })
  if (!config) {
    return yield* new IntakeCsrfError({
      operation: 'config',
      message: 'INTAKE_CSRF_BOUNDARY_UNAVAILABLE',
    })
  }
  return config
})

function csrfPayload(binding: string, nonce: string, audience: string, issuedAt: number): string {
  return `intake-csrf.v1\n${audience.length}:${audience}\n${binding.length}:${binding}\n${issuedAt}\n${nonce}`
}

const createIntakeCsrfTokenEffect = Effect.fn('IntakeCsrf.createToken')(function* (args: {
  binding: string
  nonce?: string
  issuedAt?: number
  secret?: string
  audience?: string
}) {
  const config = yield* csrfConfigEffect(args.secret, args.audience)
  const nonce = args.nonce ?? randomBytes(24).toString('base64url')
  const issuedAt = args.issuedAt ?? Date.now()
  if (
    !/^[A-Za-z0-9_-]{32}$/.test(nonce) ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    args.binding.length === 0 ||
    args.binding.length > 256
  ) {
    return yield* new IntakeCsrfError({
      operation: 'createToken',
      message: 'INTAKE_CSRF_BINDING_INVALID',
    })
  }
  const signature = createHmac('sha256', config.secret)
    .update(csrfPayload(args.binding, nonce, config.audience, issuedAt))
    .digest('base64url')
  return `ics_${issuedAt.toString(36)}_${nonce}.${signature}`
})

/** Puente síncrono para `/api/intake/session`, que emite el token en la respuesta. */
export function createIntakeCsrfToken(args: {
  binding: string
  nonce?: string
  issuedAt?: number
  secret?: string
  audience?: string
}): string {
  const outcome = Effect.runSync(
    createIntakeCsrfTokenEffect(args).pipe(
      Effect.match({
        onSuccess: (token) => ({ ok: true as const, token }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (!outcome.ok) throwEffectError(outcome.error)
  return outcome.token
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

const validateIntakeCsrfTokenEffect = Effect.fn('IntakeCsrf.validateToken')(function* (
  token: string,
  binding: string,
  now = Date.now()
) {
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return false
  const issuedAt = Number.parseInt(match[1], 36)
  const maxAge =
    binding === INTAKE_CSRF_BOOTSTRAP_BINDING
      ? INTAKE_CSRF_BOOTSTRAP_TTL_MS
      : INTAKE_CSRF_SESSION_TTL_MS
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > now + INTAKE_CSRF_MAX_CLOCK_SKEW_MS ||
    now - issuedAt > maxAge
  ) {
    return false
  }
  // Una frontera sin secreto no valida nada: el token es rechazado igual que
  // uno con firma equivocada, sin propagar el fallo al caller. `catchCause`
  // cubre también un defect, que es lo que atrapaba el `catch` anterior.
  return yield* createIntakeCsrfTokenEffect({ binding, issuedAt, nonce: match[2] }).pipe(
    Effect.map((expected) => safeEqual(token, expected)),
    Effect.catchCause(() => Effect.succeed(false))
  )
})

export function validateIntakeCsrfToken(token: string, binding: string, now = Date.now()): boolean {
  return Effect.runSync(validateIntakeCsrfTokenEffect(token, binding, now))
}

export function validateIntakeMutationRequest(request: NextRequest, binding: string): boolean {
  if (!validateOrigin(request)) return false
  const header = request.headers.get(INTAKE_CSRF_HEADER)
  const cookie = request.cookies.get(getIntakeCsrfCookieName())?.value
  return Boolean(
    header && cookie && safeEqual(header, cookie) && validateIntakeCsrfToken(header, binding)
  )
}

export function setIntakeCsrfCookie(
  response: NextResponse,
  csrfToken: string,
  expiresAt?: number,
  now = Date.now()
): void {
  const maxAge = Math.max(
    1,
    Math.min(
      expiresAt ? Math.floor((expiresAt - now) / 1000) : INTAKE_CSRF_BOOTSTRAP_TTL_MS / 1000,
      INTAKE_CSRF_SESSION_TTL_MS / 1000
    )
  )
  response.cookies.set(getIntakeCsrfCookieName(), csrfToken, {
    ...csrfCookieOptions(),
    maxAge,
    expires: new Date(now + maxAge * 1000),
  })
}

export function clearIntakeCsrfCookie(response: NextResponse): void {
  response.cookies.set(getIntakeCsrfCookieName(), '', {
    ...csrfCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  })
}

/** Mismo motivo que `clearIntakeSessionCookieInStore`: el prefijo `__Host-`. */
export function clearIntakeCsrfCookieInStore(cookieStore: IntakeCookieWriter): void {
  cookieStore.set(getIntakeCsrfCookieName(), '', {
    ...csrfCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  })
}
