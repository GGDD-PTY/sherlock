// ============================================================================
// DEV AUTH - BARREL EXPORT
// ============================================================================
// Export centralizado del sistema de auth para desarrollo.
//
// ===== EL ÚNICO LUGAR QUE VE LOS DOS =====
// `config.ts` no importa `types.ts` ni al revés — cada uno resuelve su propia
// mitad del sistema de bypass. Este barrel es el único módulo que ya tiene los
// dos en la mano al mismo tiempo, así que es donde se puede nombrar la
// combinación imposible: el bypass prendido sin un solo usuario configurado.
// Sin esto, esa combinación no lanza nada — `useDevAuthImpl` simplemente
// nunca encuentra un usuario y el login de desarrollo se queda mudo, sin
// pista de por qué.
// ============================================================================

import { Effect } from 'effect'

import { DEV_AUTH_ENABLED } from './config'
import { DEV_USERS } from './types'

export { DEV_USERS } from './types'

// ===== CONFIG =====
export { DEV_AUTH_ENABLED } from './config'

// ===== CONTEXT =====
export { useDevAuth } from './context'

Effect.runSync(
  Effect.sync(() => {
    if (DEV_AUTH_ENABLED && DEV_USERS.length === 0) {
      throw new Error('dev-auth: DEV_AUTH_ENABLED está prendido pero DEV_USERS está vacío')
    }
  }).pipe(Effect.withSpan('DevAuth.assertConfigured'))
)
