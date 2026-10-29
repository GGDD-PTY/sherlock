'use client'

// Next pinta el `error.tsx` más cercano al segmento que falló. Las cinco
// secciones traen el suyo dentro de su layout, así que este límite solo aparece
// cuando falla algo del grupo, por encima del cromo de la app. Para que la
// pantalla no salga desnuda lleva la barra pública, que es cliente y no
// consulta sesión (tarjeta O2-06, decisión de la estación 2026-09-12). El
// footer no baja acá: `SiteFooter` y `ProductFooter` son componentes de
// servidor y un límite de error es cliente por contrato de Next.

import { useEffect } from 'react'
import { Effect } from 'effect'

import {
  RouteErrorBoundary,
  type RouteErrorBoundaryProps,
} from '@/components/errors/RouteErrorBoundary'
import { PublicNavbar } from '@/components/layout/PublicNavbar'
import { MAIN_CONTENT_ID, SkipToContent } from '@/components/providers/SkipToContent'
import { captureClientException } from '@/lib/observability/capture-client-exception'
import { runClientFork } from '@/lib/effect/client-runtime'
import { useTranslations } from 'next-intl'

// Reportar no puede tumbar la pantalla de error: el programa corre con
// `runFork` dentro del `useEffect`, igual que en `[locale]/error.tsx`.
const reportAppRouteError = Effect.fn('AppRouteError.report')(function* (
  error: RouteErrorBoundaryProps['error']
) {
  yield* Effect.sync(() => captureClientException(error, error.digest))
  yield* Effect.logError('Error capturado:', error)
})

export default function AppRouteError({ error, reset }: RouteErrorBoundaryProps) {
  const tAria = useTranslations('common.navbar.aria')

  useEffect(() => {
    runClientFork(reportAppRouteError(error))
  }, [error])

  return (
    <>
      <SkipToContent label={tAria('skipToContent')} />
      <PublicNavbar />
      <main id={MAIN_CONTENT_ID}>
        <RouteErrorBoundary error={error} reset={reset} />
      </main>
    </>
  )
}
