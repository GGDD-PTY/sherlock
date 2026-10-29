// ============================================================================
// HANDOFF CLAIM — quién puede reclamar el sobre de la landing y qué parte
// ============================================================================
// IndexedDB pertenece al navegador, no a la sesión ni a la pestaña. La llave
// del sobre es un nonce aleatorio: se guarda con el sobre y viaja dentro del
// `returnTo` del alta, así que la sala que lo lee en su URL es, por
// construcción, la visita que lo parqueó. Un cliente nuevo y un cliente con
// sala previa reciben sus archivos; otro usuario que entre por otra pestaña o
// directo a la sala no hereda nada.
//
// Los bytes se reclaman con el nonce. El nombre solo bautiza un alta nueva:
// una sala que ya existía no se renombra desde la landing.

import { Schema } from 'effect'

export const HANDOFF_QUERY_PARAM = 'handoff'

// `_creationTime` es reloj del servidor y `stashedAt` reloj del navegador. Un
// navegador adelantado unos minutos no puede convertir un alta legítima en
// "sala previa": el alta cuenta como nueva si nació hasta este margen ANTES de
// la hora local del parqueo.
export const HANDOFF_RENAME_CLOCK_SKEW_MS = 10 * 60 * 1000

/**
 * La forma del nonce, escrita una sola vez. El sobre vive en IndexedDB y la
 * llave viaja en la URL: las dos orillas son entrada del navegador, así que el
 * schema se exporta para que ninguna de las dos vuelva a escribir el patrón.
 */
const HandoffNonceSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
)

const isHandoffNonce = Schema.is(HandoffNonceSchema)

export function createHandoffNonce(): string {
  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  // Safari < 15.4 trae getRandomValues sin randomUUID: se arma un v4 a mano.
  const bytes = new Uint8Array(16)
  webCrypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** La URL es entrada ajena: solo un nonce con forma de UUID cuenta. */
export function readHandoffNonce(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const nonce = value.trim().toLowerCase()
  return isHandoffNonce(nonce) ? nonce : null
}

const PLACEHOLDER_ORIGIN = 'https://handoff.invalid'

/**
 * Mete el nonce dentro del `returnTo` de la continuación (`/sign-up?returnTo=`),
 * que es lo que WorkOS y /dev-login devuelven intacto. Sin `returnTo` no hay
 * sala a la que llegar, y el href se deja como está.
 */
export function appendHandoffNonce(secureHref: string, nonce: string): string {
  const url = new URL(secureHref, PLACEHOLDER_ORIGIN)
  const returnTo = url.searchParams.get('returnTo')
  if (!returnTo) return secureHref
  const target = new URL(returnTo, PLACEHOLDER_ORIGIN)
  target.searchParams.set(HANDOFF_QUERY_PARAM, nonce)
  url.searchParams.set('returnTo', `${target.pathname}${target.search}${target.hash}`)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Devuelve la query (sin `?`) con el nonce quitado y el resto del estado intacto. */
export function stripHandoffNonce(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(HANDOFF_QUERY_PARAM)
  return params.toString()
}

export function handoffBelongsToVisit({
  urlNonce,
  envelopeNonce,
}: {
  urlNonce: string | null
  envelopeNonce: string | null
}): boolean {
  return urlNonce !== null && envelopeNonce !== null && urlNonce === envelopeNonce
}

export function companyBornFromHandoff({
  companyCreatedAt,
  stashedAt,
}: {
  companyCreatedAt: number | null | undefined
  stashedAt: number | null
}): boolean {
  if (typeof companyCreatedAt !== 'number' || !Number.isFinite(companyCreatedAt)) return false
  if (typeof stashedAt !== 'number' || !Number.isFinite(stashedAt)) return false
  return companyCreatedAt >= stashedAt - HANDOFF_RENAME_CLOCK_SKEW_MS
}
