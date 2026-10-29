import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { Settings } from 'lucide-react'
import { setRequestLocale } from 'next-intl/server'

import { Button } from '@/components/ui/button'
import { LazyAdminDashboard } from '@/components/lazy'
import { Link } from '@/i18n/navigation'
import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { adminRoute, loadAdminTranslations } from './_shared'

const ADMIN_ROUTE = adminRoute('/admin')

const AdminSecurityHrefSchema = Schema.Literals(['/admin/security'])
const ADMIN_SECURITY_HREF = Schema.decodeSync(AdminSecurityHrefSchema)('/admin/security')

const loadDashboardCopy = Effect.fn('AdminDashboard.loadCopy')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.operations')
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadDashboardCopy(locale))
  return { title: t('pageTitle'), description: t('pageDescription') }
}

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const [, t] = await Promise.all([
    requireRole(['ADMIN'], ADMIN_ROUTE, locale),
    runServerEffect(loadDashboardCopy(locale)),
  ])

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:h-[calc(100dvh-7.5rem)] lg:px-8">
      {/* El encabezado va al mínimo —título y una línea— para que el tablero
          entero quepa en 1440x900 (tarjeta O1-04). */}
      <header className="mb-4 flex shrink-0 flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h1 className="min-w-0">{t('pageTitle')}</h1>
          <p className="text-muted-foreground mt-1">{t('pageDescription')}</p>
        </div>
        <Button asChild className="w-full sm:w-auto" variant="outline">
          {/* Misma razón que la barra: /admin/security no se prefetchea. */}
          <Link href={ADMIN_SECURITY_HREF} prefetch={false}>
            <Settings aria-hidden="true" className="mr-2 h-4 w-4" />
            {t('securityControls')}
          </Link>
        </Button>
      </header>

      <section
        aria-label={t('pageTitle')}
        tabIndex={0}
        className="focus-visible:ring-ring min-w-0 rounded-sm focus-visible:ring-2 focus-visible:outline-none lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
      >
        <LazyAdminDashboard />
      </section>
    </div>
  )
}
