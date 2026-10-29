'use client'

import { useEffect } from 'react'
import { Effect } from 'effect'
import {
  RouteErrorBoundary,
  type RouteErrorBoundaryProps,
} from '@/components/errors/RouteErrorBoundary'
import { runClientFork } from '@/lib/effect/client-runtime'

// Esta es la última pantalla que le queda al visitante de este segmento, así
// que reportar no puede tumbarla: el programa se corre con `runFork`, que
// aísla el fallo en su propia fibra en vez de lanzarlo dentro del efecto de
// React. Corre en el borde —dentro del `useEffect`— y nunca en el cuerpo del
// módulo, donde correría al evaluar el chunk.
const reportMyCompanyError = Effect.fn('MyCompanyError.report')(function* (
  error: RouteErrorBoundaryProps['error']
) {
  yield* Effect.logError('[MY-COMPANY ERROR]', error)
})

export default function MyCompanyError({ error, reset }: RouteErrorBoundaryProps) {
  useEffect(() => {
    runClientFork(reportMyCompanyError(error))
  }, [error])

  return <RouteErrorBoundary error={error} reset={reset} />
}
