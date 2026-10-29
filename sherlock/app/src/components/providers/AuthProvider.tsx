import { type ReactNode } from 'react'
import { Schema } from 'effect'

import { WorkOSAuthProvider } from './WorkOSAuthProvider'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { DevAuthProvider } from '@/lib/dev-auth/context'

interface AuthProviderProps {
  children: ReactNode
}

const isDevAuthFlag = Schema.is(Schema.Boolean)

// `DEV_AUTH_ENABLED` ya sale validado de `dev-auth/config.ts`. Un valor que no
// sea un booleano, o un modo que no sea el bypass, cae a prod — nunca al árbol
// de desarrollo.
export function AuthProvider({ children }: AuthProviderProps) {
  const useDevAuth = isDevAuthFlag(DEV_AUTH_ENABLED) && DEV_AUTH_ENABLED
  if (useDevAuth) {
    return <DevAuthProvider>{children}</DevAuthProvider>
  }

  return <WorkOSAuthProvider>{children}</WorkOSAuthProvider>
}
