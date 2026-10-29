'use client'

import { useEffect } from 'react'
import { Effect } from 'effect'
import {
  RouteErrorBoundary,
  type RouteErrorBoundaryProps,
} from '@/components/errors/RouteErrorBoundary'
import { captureClientException } from '@/lib/observability/capture-client-exception'
import { runClientFork } from '@/lib/effect/client-runtime'

// Reportar no puede tumbar la pantalla de error: es lo último que le queda al
// visitante. `runFork` hace estructural el aislamiento que hoy depende de que
// `captureClientException` nunca lance — si algún día lanza, el fallo muere en
// su fibra y la tarjeta sigue en pie. Corre en el borde, dentro del
// `useEffect`, nunca en el cuerpo del módulo.
const reportRouteError = Effect.fn('RouteError.report')(function* (
  error: RouteErrorBoundaryProps['error']
) {
  yield* Effect.sync(() => captureClientException(error, error.digest))
  yield* Effect.logError('Error capturado:', error)
})

export default function ErrorPage({ error, reset }: RouteErrorBoundaryProps) {
  useEffect(() => {
    runClientFork(reportRouteError(error))
  }, [error])

  return <RouteErrorBoundary error={error} reset={reset} />
}
