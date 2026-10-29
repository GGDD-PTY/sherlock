import { Effect, Schema } from 'effect'

import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { invalidState } from '../_helpers/errors'
import { resolveIntakeServerBoundaryConfig } from './proofFormat'

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function intakeSecret(): string {
  const config = resolveIntakeServerBoundaryConfig({
    secret: process.env.INTAKE_SERVER_SECRET,
    audience: process.env.INTAKE_SERVER_AUDIENCE,
  })
  if (!config) {
    throw invalidState(
      'La configuración segura del acceso temporal no está disponible.',
      'INTAKE_SECURITY_NOT_CONFIGURED'
    )
  }
  return config.secret
}

/**
 * El secreto ausente sale por el canal de error y las dos llamadas a
 * `crypto.subtle` pasan por la costura del aislado. El borde sigue siendo la
 * promesa que esperan `sessions.ts` y `claim.ts`.
 */
const hashIntakeSessionTokenEffect = Effect.fn('IntakeCrypto.hashSessionToken')(function* (
  token: string
) {
  const secret = yield* convexSync(() => intakeSecret())
  const key = yield* convexPromise(() =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
  )
  const digest = yield* convexPromise(() =>
    crypto.subtle.sign('HMAC', key, encoder.encode(`intake-session:v1:${token}`))
  )
  return bytesToHex(new Uint8Array(digest))
})

export function hashIntakeSessionToken(token: string): Promise<string> {
  return runConvex(hashIntakeSessionTokenEffect(token))
}

const sha256HexEffect = Effect.fn('IntakeCrypto.sha256Hex')(function* (value: string) {
  const digest = yield* convexPromise(() => crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return bytesToHex(new Uint8Array(digest))
})

export function sha256Hex(value: string): Promise<string> {
  return runConvex(sha256HexEffect(value))
}

// El token opaco tiene una sola definición de forma: la que lo acuña y la que
// lo valida al volver del navegador.
const OpaqueIntakeToken = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const isOpaqueIntakeToken = Schema.is(OpaqueIntakeToken)

export function createOpaqueIntakeToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export function isValidOpaqueIntakeToken(value: string): boolean {
  return isOpaqueIntakeToken(value)
}
