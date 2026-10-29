// ============================================================================
// HANDOFF NAVIGATION — la llave del sobre cruza el alta y nada más
// ============================================================================
// El servidor elige el destino; aquí solo se le cuelga el nonce del intake.
//
// Una URL sin nonce reclamable no es un error para quien navega: el destino
// sale limpio. El motivo viaja tipado en `HandoffNonceUnavailable`, y los dos
// bordes síncronos lo colapsan en el destino sin llave o en `null`, como antes.
// Así los callers (`session.ts`, dos rutas de servidor y un callback de
// cliente) no cambian.
// ============================================================================

import { Effect, Schema } from 'effect'

import { HANDOFF_QUERY_PARAM, readHandoffNonce } from '@/lib/mycroft/handoff-claim'

type HandoffDestination =
  | '/onboarding'
  | '/onboarding?error=needs-profile'
  | '/onboarding/provision'
  | '/my-company/documents'

class HandoffNonceUnavailable extends Schema.TaggedError<HandoffNonceUnavailable>()(
  'HandoffNonceUnavailable',
  { reason: Schema.Literals(['missing', 'malformed', 'ambiguous', 'not-documents']) }
) {}

const claimableNonce = Effect.fn('HandoffNavigation.claimableNonce')(function* (
  value: string | null | undefined
) {
  if (value === null || value === undefined) {
    return yield* new HandoffNonceUnavailable({ reason: 'missing' })
  }
  const nonce = readHandoffNonce(value)
  if (nonce === null) return yield* new HandoffNonceUnavailable({ reason: 'malformed' })
  return nonce
})

const destinationWithNonce = Effect.fn('HandoffNavigation.withNonce')(function* (
  destination: HandoffDestination,
  value: string | null | undefined
) {
  const nonce = yield* claimableNonce(value)
  return `${destination}${destination.includes('?') ? '&' : '?'}${HANDOFF_QUERY_PARAM}=${nonce}`
})

// `split('?')` a propósito: lo que venga después de un segundo `?` no es parte
// de la query que se lee.
const documentsNonce = Effect.fn('HandoffNavigation.documentsNonce')(function* (
  path: string | undefined
) {
  if (!path) return yield* new HandoffNonceUnavailable({ reason: 'missing' })
  const [pathname, search] = path.split('?')
  if (pathname !== '/my-company/documents') {
    return yield* new HandoffNonceUnavailable({ reason: 'not-documents' })
  }
  const values = new URLSearchParams(search).getAll(HANDOFF_QUERY_PARAM)
  if (values.length > 1) return yield* new HandoffNonceUnavailable({ reason: 'ambiguous' })
  return yield* claimableNonce(values[0])
})

/** Bootstrap carries only the intake nonce, never an arbitrary return destination. */
export function withHandoffNonce(destination: HandoffDestination, value?: string | null): string {
  return Effect.runSync(
    destinationWithNonce(destination, value).pipe(
      Effect.catchTag('HandoffNonceUnavailable', () => Effect.succeed(destination))
    )
  )
}

export function documentsHandoffNonce(path?: string): string | null {
  return Effect.runSync(
    documentsNonce(path).pipe(
      Effect.catchTag('HandoffNonceUnavailable', () => Effect.succeed(null))
    )
  )
}
