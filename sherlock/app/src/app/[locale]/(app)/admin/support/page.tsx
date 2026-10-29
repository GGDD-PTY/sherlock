import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import type { Id } from '@/../convex/_generated/dataModel'
import { AdminIntakeQueue } from '@/components/admin/AdminIntakeQueue'
import { AdminPreparationWorkspace } from '@/components/admin/AdminPreparationWorkspace'
import { AdminSupportInbox } from '@/components/admin/AdminSupportInbox'
import { redirect } from '@/i18n/navigation'
import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { adminRoute, boundedSelection } from '../_shared'

const ADMIN_ROUTE = adminRoute('/admin/support')

class AdminSupportCopyError extends Schema.TaggedError<AdminSupportCopyError>()(
  'AdminSupportCopyError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadSupportCopy = Effect.fn('AdminSupport.loadCopy')(function* (locale: string) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'support' }),
    catch: (cause) => new AdminSupportCopyError({ cause }),
  })
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadSupportCopy(locale))
  return {
    title: t('admin.metadata.title'),
    description: t('admin.metadata.description'),
  }
}

export default async function AdminSupportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{
    thread?: string | string[]
    company?: string | string[]
    intake?: string | string[]
  }>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  setRequestLocale(locale)
  const [user, t] = await Promise.all([
    requireRole(['ADMIN'], ADMIN_ROUTE, locale),
    runServerEffect(loadSupportCopy(locale)),
  ])
  if (user.isViewingAs) {
    redirect({ href: '/admin', locale })
    return
  }
  const selectedThreadId = boundedSelection(query.thread)
  const selectedCompanyId = selectedThreadId ? undefined : boundedSelection(query.company)
  const selectedIntakeId =
    selectedThreadId || selectedCompanyId ? undefined : boundedSelection(query.intake)

  const inbox = (
    <AdminSupportInbox
      selectedThreadId={selectedThreadId}
      selectedCompanyId={selectedCompanyId}
      selectedIntakeId={selectedIntakeId}
    />
  )

  // Sin intake la pantalla mide el viewport en `lg` y el inbox scrollea por
  // dentro: con quince hilos la lista empujaba la página ([F] 2026-09-12,
  // tarjeta OB-RES-2). Con intake el taller no tiene tope y la página crece
  // con él; el inbox toma `lg:h-[36rem]` para conservar su scroll interno
  // (CodeRabbit #626). La cola de salas ya scrollea con `max-h-64`; no se toca.
  return (
    <div
      className={
        selectedIntakeId
          ? 'mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8'
          : 'mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:h-[calc(100dvh-7.5rem)] lg:px-8'
      }
    >
      <header className="mb-4 shrink-0">
        <h1>{t('admin.pageTitle')}</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">{t('admin.pageDescription')}</p>
      </header>

      {selectedIntakeId ? (
        <div className="mb-4 shrink-0">
          <AdminPreparationWorkspace intakeSessionId={selectedIntakeId as Id<'intakeSessions'>} />
        </div>
      ) : null}
      <div className="mb-4 shrink-0">
        <AdminIntakeQueue selectedIntakeId={selectedIntakeId} />
      </div>
      {selectedIntakeId ? <div className="flex min-h-0 flex-col lg:h-[36rem]">{inbox}</div> : inbox}
    </div>
  )
}
