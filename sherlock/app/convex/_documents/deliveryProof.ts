// ============================================================================
// PRUEBA HMAC DE ENTREGA DOCUMENTAL
// ============================================================================
// El sobre que firma —y el que se verifica— llega del cliente a través de la
// ruta Next, así que es entrada no confiable con forma: `Schema` la declara una
// sola vez y el guard la rechaza antes de gastar un HMAC. La carga útil
// serializada NO cambia: es la misma tupla posicional que ya firmaron los
// grants vivos, y tocarla invalidaría toda entrega en vuelo.
//
// La tupla posicional es, precisamente, la parte frágil que queda: el orden de
// los cinco campos es el contrato, y nada en el tipo lo sostiene. Cambiarlo es
// un cambio de contrato con los grants ya emitidos y queda fuera de esta ola.
// ============================================================================

import { Schema } from 'effect'

const DOCUMENT_DELIVERY_PROOF_VERSION = 'v1'
export const DOCUMENT_DELIVERY_PROOF_TTL_MS = 60_000
const DOCUMENT_DELIVERY_PROOF_MAX_FUTURE_SKEW_MS = 10_000

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

/** Los cuatro campos que identifican una entrega, y el orden en que se firman. */
const DeliveryProofSubjectSchema = Schema.Struct({
  grantId: NonEmptyString,
  token: NonEmptyString,
  profileId: NonEmptyString,
  issuedAt: Schema.Number.pipe(Schema.check(Schema.isInt())),
})

export type DeliveryProofSubject = typeof DeliveryProofSubjectSchema.Type

const isDeliveryProofSubject = Schema.is(DeliveryProofSubjectSchema)

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function deliveryProofPayload(input: DeliveryProofSubject): string {
  return JSON.stringify([
    DOCUMENT_DELIVERY_PROOF_VERSION,
    input.grantId,
    input.token,
    input.profileId,
    input.issuedAt,
  ])
}

/**
 * HMAC emitted only by the server-side document route.
 *
 * The browser knows the grant id and token, but it never receives this proof or
 * the STORAGE_SECRET. Convex therefore has a verifiable signal that the
 * permanent storage URL is being requested by the protected proxy/watermark
 * route rather than by a direct SDK call from devtools.
 */
export async function createDocumentDeliveryProof(
  secret: string,
  input: DeliveryProofSubject
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(deliveryProofPayload(input))
  )
  return bytesToHex(new Uint8Array(signature))
}

function constantTimeHexEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }

  return difference === 0
}

/** La ventana viva de una prueba: ni del futuro ni más vieja que su TTL. */
function isFreshDeliveryProof(issuedAt: number, now: number): boolean {
  return (
    Number.isSafeInteger(issuedAt) &&
    issuedAt <= now + DOCUMENT_DELIVERY_PROOF_MAX_FUTURE_SKEW_MS &&
    now - issuedAt <= DOCUMENT_DELIVERY_PROOF_TTL_MS
  )
}

export async function verifyDocumentDeliveryProof(
  secret: string,
  input: DeliveryProofSubject & { proof: string },
  now = Date.now()
): Promise<boolean> {
  // Fail closed antes del HMAC: un sobre sin forma no se firma ni se compara.
  if (!isDeliveryProofSubject(input) || !isFreshDeliveryProof(input.issuedAt, now)) {
    return false
  }

  const expected = await createDocumentDeliveryProof(secret, input)
  return constantTimeHexEqual(input.proof, expected)
}
