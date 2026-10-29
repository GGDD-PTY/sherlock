import { Effect, Schema } from 'effect'

import { convexPromise, convexSync, runConvex, type ConvexEffect } from '../_helpers/effect'
import { invalidState, validationFailed } from '../_helpers/errors'

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type GuestSecretName = 'GUEST_IDENTITY_HASH_SECRET' | 'GUEST_OTP_PEPPER'

// Un secreto configurado es un string de al menos 32 caracteres. La misma
// definición decide si el deployment está configurado y qué valor se firma.
const ConfiguredSecret = Schema.String.pipe(Schema.check(Schema.isMinLength(32)))
const isConfiguredSecret = Schema.is(ConfiguredSecret)

function getSecret(name: GuestSecretName): string {
  const configured = process.env[name]?.trim()
  if (configured && isConfiguredSecret(configured)) return configured

  if (process.env.CONVEX_ENV !== 'dev') {
    throw invalidState(
      'La configuración segura de invitados no está disponible.',
      'GUEST_SECURITY_NOT_CONFIGURED'
    )
  }

  // Solo para desarrollo/tests con CONVEX_ENV=dev explícito. Todo otro
  // entorno, incluido uno ausente o mal escrito, falla cerrado arriba.
  return `sherlock-local-dev-only:${name}:not-for-production`
}

export function isGuestSecurityConfigured(): boolean {
  const hasIdentitySecret = isConfiguredSecret(process.env.GUEST_IDENTITY_HASH_SECRET?.trim() ?? '')
  const hasOtpPepper = isConfiguredSecret(process.env.GUEST_OTP_PEPPER?.trim() ?? '')
  if (hasIdentitySecret && hasOtpPepper) return true
  // El fallback local existe únicamente tras una declaración explícita de
  // desarrollo. Env ausente o con typo se trata como deployment protegido.
  return process.env.CONVEX_ENV === 'dev'
}

/**
 * El HMAC, con el secreto ausente en el canal de error y `crypto.subtle` como
 * lo que es: dos promesas del aislado. Nadie de afuera ve el `Effect`; los
 * `hash*` siguen devolviendo la promesa que sus callers esperan.
 */
const hmacHexEffect = Effect.fn('GuestCrypto.hmacHex')(function* (
  name: GuestSecretName,
  value: string
) {
  const secret = yield* convexSync(() => getSecret(name))
  const key = yield* convexPromise(() =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
  )
  const digest = yield* convexPromise(() => crypto.subtle.sign('HMAC', key, encoder.encode(value)))
  return bytesToHex(new Uint8Array(digest))
}) satisfies (name: GuestSecretName, value: string) => ConvexEffect<string>

// El formato de un email aceptable, en una sola definición: largo, ausencia de
// espacio y la forma `fixture-0e4069b7@example.com`.
const GuestEmail = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(3, 254),
    Schema.isPattern(/^[^ ]*$/),
    Schema.isPattern(/^[^@]+@[^@]+\.[^@]+$/)
  )
)
const isGuestEmail = Schema.is(GuestEmail)

export function normalizeGuestEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!isGuestEmail(email)) {
    throw validationFailed('El email no tiene un formato válido.', 'email')
  }
  return email
}

export function maskGuestEmail(email: string): string {
  const [local, domain] = email.split('@')
  const domainParts = domain.split('.')
  const domainName = domainParts.shift() ?? ''
  const suffix = domainParts.length > 0 ? `.${domainParts.join('.')}` : ''
  const maskedLocal =
    local.length <= 1 ? '*' : `${local[0]}${'*'.repeat(Math.min(5, local.length - 1))}`
  const maskedDomain = domainName.length <= 1 ? '*' : `${domainName[0]}***`
  return `${maskedLocal}@${maskedDomain}${suffix}`
}

export function hashGuestEmail(email: string): Promise<string> {
  return runConvex(hmacHexEffect('GUEST_IDENTITY_HASH_SECRET', `guest-email:v1:${email}`))
}

export function hashInvitationHandle(handle: string): Promise<string> {
  return runConvex(hmacHexEffect('GUEST_OTP_PEPPER', `guest-invitation:v1:${handle}`))
}

export function hashChallengeToken(token: string): Promise<string> {
  return runConvex(hmacHexEffect('GUEST_OTP_PEPPER', `guest-challenge:v1:${token}`))
}

export function hashGuestOtp(salt: string, code: string): Promise<string> {
  return runConvex(hmacHexEffect('GUEST_OTP_PEPPER', `guest-otp:v1:${salt}:${code}`))
}

export function hashGuestSessionToken(token: string): Promise<string> {
  return runConvex(hmacHexEffect('GUEST_OTP_PEPPER', `guest-session:v1:${token}`))
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

export function createOpaqueGuestSecret(): string {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`
}

export function createGuestOtp(): string {
  // Rejection sampling evita el pequeño sesgo de `random % 1_000_000`.
  const range = 1_000_000
  const ceiling = Math.floor(0x1_0000_0000 / range) * range
  const sample = new Uint32Array(1)
  do {
    crypto.getRandomValues(sample)
  } while (sample[0] >= ceiling)
  return String(sample[0] % range).padStart(6, '0')
}
