import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { Effect, Schema } from 'effect'

import { BoundaryDecodeError } from '@/lib/effect/errors'
import { decodeBoundary } from '@/lib/effect/external'

export const ADMIN_STEP_UP_COOKIE_NAME = 'sherlock_admin_step_up'
// [F] 2026-09-02: una entrada fuerte por sesión de trabajo, no cada 10 minutos.
// La cookie sigue atada al `sid` de WorkOS (ver `digestBindingValue` abajo), así
// que cerrar sesión la invalida igual. Revertir = cambiar esta línea.
export const ADMIN_STEP_UP_MAX_AGE_SECONDS = 12 * 60 * 60
// Adonde va el ADMIN sin marcador vigente. Lo escriben `requireRole` (página)
// y el proxy (antes del shell); `settings/page.tsx` es quien lo lee.
export const ADMIN_MFA_REQUIRED_PATH = '/settings?error=admin-mfa-required'

const DEFAULT_ADMIN_STEP_UP_METHODS = ['SSO', 'Passkey']
const ADMIN_STEP_UP_COOKIE_VERSION = 'v2'

export interface AdminStepUpSessionBinding {
  subject: string
  sessionId: string
}

// El sujeto y la sesión los emite WorkOS, pero llegan como texto: se acotan
// antes de digerirlos para que la cookie no cargue un valor sin límite.
const bindingValueSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512))
)

const base64UrlSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)))

// La cookie es entrada del atacante: su forma se decodifica, no se asume.
const adminStepUpCookieSchema = Schema.Struct({
  version: Schema.Literal(ADMIN_STEP_UP_COOKIE_VERSION),
  issuedAtRaw: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{1,15}$/))),
  encodedMethod: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  subjectDigest: base64UrlSchema,
  sessionDigest: base64UrlSchema,
  signature: base64UrlSchema,
})

function getAdminStepUpSecret(): string | null {
  return (
    process.env.WORKOS_ADMIN_STEP_UP_COOKIE_SECRET ?? process.env.WORKOS_COOKIE_PASSWORD ?? null
  )
}

function getAllowedAdminStepUpMethods(): Set<string> {
  const configuredMethods = process.env.WORKOS_ADMIN_STEP_UP_METHODS?.split(',')
    .map((method) => method.trim())
    .filter(Boolean)

  const methods =
    configuredMethods && configuredMethods.length > 0
      ? configuredMethods
      : DEFAULT_ADMIN_STEP_UP_METHODS

  return new Set(methods.map((method) => method.toLowerCase()))
}

function signAdminStepUpPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const digestBindingValueEffect = Effect.fn('AdminStepUp.digestBinding')(function* (value: string) {
  return yield* decodeBoundary('adminStepUp.binding', bindingValueSchema, value).pipe(
    Effect.map((accepted) => createHash('sha256').update(accepted).digest('base64url')),
    Effect.orElseSucceed(() => null)
  )
})

const parseAdminStepUpCookieEffect = Effect.fn('AdminStepUp.parseCookie')(function* (
  value: string
) {
  const parts = value.split('.')
  if (parts.length !== 6) return null

  return yield* decodeBoundary('adminStepUp.cookie', adminStepUpCookieSchema, {
    version: parts[0],
    issuedAtRaw: parts[1],
    encodedMethod: parts[2],
    subjectDigest: parts[3],
    sessionDigest: parts[4],
    signature: parts[5],
  }).pipe(Effect.orElseSucceed(() => null))
})

function isAdminStepUpAuthenticationMethod(method: string | undefined): method is string {
  return (
    typeof method === 'string' && getAllowedAdminStepUpMethods().has(method.trim().toLowerCase())
  )
}

const createAdminStepUpCookieValueEffect = Effect.fn('AdminStepUp.createCookie')(function* (
  method: string | undefined,
  binding: AdminStepUpSessionBinding,
  issuedAtMs: number
) {
  if (!isAdminStepUpAuthenticationMethod(method)) {
    return null
  }

  const secret = getAdminStepUpSecret()
  if (!secret) {
    return null
  }

  const trimmedMethod = method.trim()
  const subjectDigest = yield* digestBindingValueEffect(binding.subject)
  const sessionDigest = yield* digestBindingValueEffect(binding.sessionId)
  if (!subjectDigest || !sessionDigest) return null
  const payload = `${ADMIN_STEP_UP_COOKIE_VERSION}:${issuedAtMs}:${trimmedMethod}:${subjectDigest}:${sessionDigest}`
  const signature = signAdminStepUpPayload(payload, secret)

  return `${ADMIN_STEP_UP_COOKIE_VERSION}.${issuedAtMs}.${encodeURIComponent(trimmedMethod)}.${subjectDigest}.${sessionDigest}.${signature}`
})

export function createAdminStepUpCookieValue(
  method: string | undefined,
  binding: AdminStepUpSessionBinding,
  issuedAtMs = Date.now()
): string | null {
  return Effect.runSync(createAdminStepUpCookieValueEffect(method, binding, issuedAtMs))
}

const isRecentAdminStepUpCookieEffect = Effect.fn('AdminStepUp.verifyCookie')(function* (
  value: string | undefined,
  binding: AdminStepUpSessionBinding,
  nowMs: number
) {
  if (!value) {
    return false
  }

  const cookie = yield* parseAdminStepUpCookieEffect(value)
  if (!cookie) {
    return false
  }

  const issuedAtMs = Number(cookie.issuedAtRaw)
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) {
    return false
  }

  const ageMs = nowMs - issuedAtMs
  if (ageMs < 0 || ageMs > ADMIN_STEP_UP_MAX_AGE_SECONDS * 1000) {
    return false
  }

  const method = yield* Effect.try({
    try: () => decodeURIComponent(cookie.encodedMethod),
    catch: (cause) =>
      new BoundaryDecodeError({
        boundary: 'adminStepUp.method',
        message: 'El método viene con percent-encoding inválido.',
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => null))

  if (!isAdminStepUpAuthenticationMethod(method ?? undefined)) {
    return false
  }

  const secret = getAdminStepUpSecret()
  if (!secret) {
    return false
  }

  const expectedSubjectDigest = yield* digestBindingValueEffect(binding.subject)
  const expectedSessionDigest = yield* digestBindingValueEffect(binding.sessionId)
  if (
    !expectedSubjectDigest ||
    !expectedSessionDigest ||
    !safeCompare(cookie.subjectDigest, expectedSubjectDigest) ||
    !safeCompare(cookie.sessionDigest, expectedSessionDigest)
  ) {
    return false
  }

  const expectedSignature = signAdminStepUpPayload(
    `${ADMIN_STEP_UP_COOKIE_VERSION}:${issuedAtMs}:${method}:${cookie.subjectDigest}:${cookie.sessionDigest}`,
    secret
  )
  return safeCompare(cookie.signature, expectedSignature)
})

export function isRecentAdminStepUpCookie(
  value: string | undefined,
  binding: AdminStepUpSessionBinding,
  nowMs = Date.now()
): boolean {
  return Effect.runSync(isRecentAdminStepUpCookieEffect(value, binding, nowMs))
}
