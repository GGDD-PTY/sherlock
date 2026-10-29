import { Schema } from 'effect'

const STORAGE_KEY = 'sherlock.roadmap.device-token'

// Mirrors the Convex-side validator: anything else is rejected server-side.
// Lo que `localStorage` devuelve es entrada externa, así que se valida con la
// misma regla con la que el servidor lo va a juzgar.
const DeviceTokenSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9-]{16,64}$/))
)
const isDeviceToken = Schema.is(DeviceTokenSchema)

let ephemeralToken: string | null = null

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return randomHex(16)
}

export function getRoadmapDeviceToken(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isDeviceToken(stored)) {
      return stored
    }

    const token = createToken()
    window.localStorage.setItem(STORAGE_KEY, token)
    return token
  } catch {
    ephemeralToken ??= createToken()
    return ephemeralToken
  }
}
