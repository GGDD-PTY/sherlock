// ============================================================================
// DATA ROOM ACTIVITY PAGE
// ============================================================================
// Quién abrió y quién descargó cada documento del VDR. Superficie de admin:
// solo el equipo llega acá y la query de Convex lo vuelve a verificar. Ruta
// propia y no una pestaña: necesita `?document=<id>` en la URL, corre su propia
// comprobación de authz y aísla una suscripción que se recalcula en cada acceso
// a la sala.
// ============================================================================

import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Effect, Option, Schema } from 'effect'
import { redirect } from '@/i18n/navigation'
import { requireAuth } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { DataRoomActivityClient } from '@/components/company/data-room-activity/DataRoomActivityClient'
import { ActivitySkeleton } from '@/components/company/data-room-activity/ActivitySkeleton'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { ConvexIdSchema } from '@/lib/validations'
import { getTranslations, setRequestLocale } from 'next-intl/server'

const decodeCompanyFilter = Schema.decodeUnknownOption(ConvexIdSchema)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(
    Effect.tryPromise({
      try: () => getTranslations({ locale, namespace: 'vdr.meta.activity' }),
      catch: (cause) => cause,
    })
  )

  return {
    title: t('title'),
    description: t('description'),
  }
}

// ===== CARGA DE LA EMPRESA =====
// Las tres formas de no tener empresa terminan en /admin, pero cada una tiene
// nombre: sin sesión de admin, la query se cayó, o la empresa no existe. Antes
// el `catch` las juntaba en un solo `console.error` sin distinguirlas.
class ActivityCompanyUnavailable extends Schema.TaggedError<ActivityCompanyUnavailable>()(
  'ActivityCompanyUnavailable',
  {
    reason: Schema.Literals(['no-admin-session', 'query-failed', 'not-found']),
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadActivityCompany = Effect.fn('DataRoomActivity.loadCompany')(function* (
  companyId: string
) {
  const convexAuth = yield* Effect.tryPromise({
    try: () => getAuthenticatedConvex(),
    catch: (cause) => new ActivityCompanyUnavailable({ reason: 'no-admin-session', cause }),
  })
  if (!convexAuth?.client || !convexAuth.isAuthenticated) {
    return yield* new ActivityCompanyUnavailable({ reason: 'no-admin-session' })
  }

  const company = yield* Effect.tryPromise({
    try: () =>
      convexAuth.client.query(api.companies.getCompany, {
        companyId: companyId as Id<'companies'>,
      }),
    catch: (cause) => new ActivityCompanyUnavailable({ reason: 'query-failed', cause }),
  })
  if (!company) return yield* new ActivityCompanyUnavailable({ reason: 'not-found' })

  return company
})

export default async function DataRoomActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams?: Promise<{ company?: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const user = await requireAuth('/my-company/documents/activity', locale)

  // La bitácora de accesos es superficie de admin ([F] 2026-09-01). El
  // cliente no la pide ni la necesita: quien le pregunta "quién abrió esto" es
  // el equipo. La empresa que llega por URL vuelve a su sala.
  if (user.effectiveRole !== 'ADMIN') {
    redirect({ href: '/my-company/documents', locale })
    return
  }

  // El modo demo corre contra el store del navegador y no produce filas en
  // `documentAccessLogs`. La entrada a esta pantalla ya se oculta en el data
  // room por esa razón (MyCompanyDocumentsClient), pero la URL seguía viva y
  // llevaba a un esqueleto que nunca resuelve. Una pantalla de evidencia no se
  // rellena con datos inventados: se cierra y se manda a lo que sí es real.
  if (DEV_AUTH_ENABLED) {
    redirect({ href: '/my-company/documents', locale })
    return
  }

  // Un admin no tiene empresa propia: la sala llega por `?company=<id>`.
  // Sin el param no hay nada que mostrar — de vuelta al panel. La autorización
  // real vive en Convex (`getCompany` y `getRoomActivity` re-verifican).
  const { company: companyParam } = (await searchParams) ?? {}
  const companyId = Option.getOrUndefined(decodeCompanyFilter(companyParam))
  if (!companyId) {
    redirect({ href: '/admin', locale })
    return
  }

  // El programa corre aquí, por request. El `redirect()` se queda afuera: su
  // throw viaja con un `digest` que Next es lo único que mira, y envuelto en un
  // `FiberFailure` lo perdería.
  const company = await runServerEffect(
    loadActivityCompany(companyId).pipe(
      Effect.tapError((error) =>
        Effect.logError(
          `[DataRoomActivity] Error fetching company for admin (${error.reason}):`,
          error.cause ?? error
        )
      ),
      Effect.match({
        onSuccess: (loaded) => loaded,
        onFailure: () => null,
      })
    )
  )

  if (!company) {
    redirect({ href: '/admin', locale })
    return
  }

  // El Suspense es lo que habilita `useSearchParams()` en el cliente para el
  // enlace profundo `?document=<id>`.
  const returnHref = `/admin/companies/${encodeURIComponent(company._id)}/documents`

  return (
    <Suspense fallback={<ActivitySkeleton />}>
      <DataRoomActivityClient
        companyId={company._id}
        companyName={company.name ?? 'Data Room'}
        returnHref={returnHref}
      />
    </Suspense>
  )
}
