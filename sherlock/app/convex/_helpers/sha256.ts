import { Option, Schema } from 'effect'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Las dos formas que puede traer un digest, cada una como schema. Antes la
// primera era un regex suelto y la segunda un `atob` dentro de un `try/catch`
// que se tragaba cualquier fallo sin distinguir "no es base64" de un bug.
const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)))

const isSha256Hex = Schema.is(Sha256Hex)
const decodeBase64Bytes = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)

/** base64url y base64 sin padding llegan del mismo campo de Convex Storage. */
function toPaddedBase64(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
}

/**
 * Convex Storage expone `_storage.sha256` en base64 (la doc dice base16 y
 * miente: verificado contra brainy-emu-822 el 2026-08-26). Todo el código de
 * la app declara y persiste hex minúscula, así que cada lectura de un digest
 * de blob pasa por aquí antes de comparar o guardar.
 */
export function normalizeSha256Hex(value: string): string | null {
  const trimmed = value.trim()
  if (isSha256Hex(trimmed)) return trimmed.toLowerCase()

  const bytes = Option.getOrNull(decodeBase64Bytes(toPaddedBase64(trimmed)))
  if (!bytes || bytes.length !== 32) return null

  return bytesToHex(bytes)
}
