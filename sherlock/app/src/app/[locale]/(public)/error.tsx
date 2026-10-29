'use client'

// Next pinta el `error.tsx` más cercano al segmento que falló. Sin este límite
// en el grupo, un error de la landing o de las páginas legales subía hasta
// `[locale]/error.tsx`, que cuelga del documento pelado, y salía sin la barra ni
// el footer que `PublicShell` monta en `(public)/layout.tsx` (tarjeta O2-06).

import { useEffect } from 'react'
import { Effect } from 'effect'
import {
  RouteErrorBoundary,
  type RouteErrorBoundaryProps,
} from '@/components/errors/RouteErrorBoundary'
import { captureClientException } from '@/lib/observability/capture-client-exception'
import { runClientFork } from '@/lib/effect/client-runtime'

// Reportar no puede tumbar la pantalla de error: el programa corre con
// `runFork` dentro del `useEffect`, igual que en `[locale]/error.tsx`.
const reportPublicRouteError = Effect.fn('PublicRouteError.report')(function* (
  error: RouteErrorBoundaryProps['error']
) {
  yield* Effect.sync(() => captureClientException(error, error.digest))
  yield* Effect.logError('Error capturado:', error)
})

export default function PublicRouteError({ error, reset }: RouteErrorBoundaryProps) {
  useEffect(() => {
    runClientFork(reportPublicRouteError(error))
  }, [error])

  return <RouteErrorBoundary error={error} reset={reset} />
}
