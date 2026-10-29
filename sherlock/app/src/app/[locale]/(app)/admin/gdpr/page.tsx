// ============================================================================
// ADMIN GDPR PAGE — cola de solicitudes de eliminación (Art. 17)
// ============================================================================
// Superficie de la mitad de escritura que existía sin caller: sin esta página,
// toda solicitud de eliminación quedaba PENDING para siempre.
// ============================================================================

import type { Metadata } from 'next'
import { Effect } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'
// Import directo a propósito: el cliente es liviano (sin charts/PDF) y el
// presupuesto de imports client-only del fitness north-star está lleno.
import { AdminGdprClient } from '@/components/admin/AdminGdprClient'

import { adminRoute, loadAdminTranslations } from '../_shared'

const ADMIN_ROUTE = adminRoute('/admin/gdpr')

const loadGdprMeta = Effect.fn('AdminGdpr.loadMeta')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.gdpr.metadata')
})

const loadGdprCopy = Effect.fn('AdminGdpr.loadCopy')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.gdpr')
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadGdprMeta(locale))
  return { title: t('title'), description: t('description') }
}

export default async function AdminGdprPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  setRequestLocale(locale)
  await requireRole(['ADMIN'], ADMIN_ROUTE, locale)
  const t = await runServerEffect(loadGdprCopy(locale))

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-4">
        <h1>{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('subtitle')}</p>
      </header>

      <AdminGdprClient />
    </div>
  )
}
