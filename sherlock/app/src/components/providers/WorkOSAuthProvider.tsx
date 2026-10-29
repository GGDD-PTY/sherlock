// ============================================================================
// WORKOS AUTHKIT PROVIDER
// ============================================================================
// Provider wrapper for the WorkOS AuthKit migration.
// ============================================================================

import { AuthKitProvider } from '@workos-inc/authkit-nextjs/components'
import { withAuth } from '@workos-inc/authkit-nextjs'
import type { ReactNode } from 'react'
import { Schema } from 'effect'

interface WorkOSAuthProviderProps {
  children: ReactNode
}

const AccessTokenLeakSchema = Schema.Struct({ accessToken: Schema.Unknown })
const leaksAccessToken = Schema.is(AccessTokenLeakSchema)

// Lista negra a propósito, no se toca: un campo nuevo que WorkOS agregue a
// `UserInfo` llega al cliente por defecto salvo que se nombre aquí. El schema
// pregunta si el token viene en lo que devolvió `withAuth()`, que es la
// frontera; si viene, se borra una sola vez. El segundo `delete` que había
// detrás de esta guarda no podía correr nunca: el spread copia propiedades
// propias, así que después del primero `accessToken` no queda ni propia ni
// heredada, y la guarda ya daba falso.
function sanitizeInitialAuth(auth: Awaited<ReturnType<typeof withAuth>>) {
  const initialAuth = { ...auth }
  if (leaksAccessToken(initialAuth)) delete initialAuth.accessToken
  return initialAuth
}

export async function WorkOSAuthProvider({ children }: WorkOSAuthProviderProps) {
  // La compuerta de sesión se queda aquí, fuera de todo programa Effect:
  // envolverla en Effect.exit/either/result se traga el redirect de WorkOS y
  // la página renderiza como si el visitante estuviera autorizado.
  const auth = await withAuth()
  const initialAuth = sanitizeInitialAuth(auth)

  return <AuthKitProvider initialAuth={initialAuth}>{children}</AuthKitProvider>
}
