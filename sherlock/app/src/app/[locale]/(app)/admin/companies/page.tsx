import type { Metadata } from 'next'
import { Effect } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { LazyAdminCompanies } from '@/components/lazy'
import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { adminRoute, loadAdminTranslations } from '../_shared'

const ADMIN_ROUTE = adminRoute('/admin/companies')

const loadCompaniesCopy = Effect.fn('AdminCompanies.loadCopy')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.companies')
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadCompaniesCopy(locale))

  return {
    title: t('metadata.title'),
    description: t('metadata.description'),
  }
}

export default async function AdminCompaniesPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const [, t] = await Promise.all([
    requireRole(['ADMIN'], ADMIN_ROUTE, locale),
    runServerEffect(loadCompaniesCopy(locale)),
  ])

  // La pantalla mide el viewport y la tabla scrollea por dentro: con veinte
  // empresas la página medía 1654 px ([F] 2026-09-11, tarjeta O1-05). El alto
  // fijo entra en `lg`, donde ya no está la barra de menú del panel.
  return (
    <div className="mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:h-[calc(100dvh-7.5rem)] lg:px-8">
      <header className="mb-4">
        <h1>{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('subtitle')}</p>
      </header>

      <LazyAdminCompanies />
    </div>
  )
}
