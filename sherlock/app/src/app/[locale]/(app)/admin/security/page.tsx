import type { Metadata } from 'next'
import { Effect } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { AuditLogsClient } from '@/components/admin/AuditLogsClient'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LazyAdminSecurity } from '@/components/lazy'
import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { adminRoute, loadAdminTranslations } from '../_shared'

const ADMIN_ROUTE = adminRoute('/admin/security')

const loadSecurityMeta = Effect.fn('AdminSecurity.loadMeta')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.security.metadata')
})

const loadSecurityCopy = Effect.fn('AdminSecurity.loadCopy')(function* (locale: string) {
  return yield* loadAdminTranslations(locale, 'admin.security')
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadSecurityMeta(locale))
  return { title: t('title'), description: t('description') }
}

export default async function AdminSecurityPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const [, t] = await Promise.all([
    requireRole(['ADMIN'], ADMIN_ROUTE, locale),
    runServerEffect(loadSecurityCopy(locale)),
  ])

  // El h1 y su línea viven arriba, sobre las pestañas: la barra de pestañas
  // sola sobre el título se leía como navegación de otra pantalla ([F] 2026-09-11).
  // Los dos paneles ya no pintan encabezado propio, así que la página tiene un
  // solo h1 en las dos pestañas.
  return (
    <div className="mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:h-[calc(100dvh-7.5rem)] lg:px-8">
      <header className="mb-4">
        <h1>{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('subtitle')}</p>
      </header>

      {/* La pestaña activa toma el alto que queda y su lista scrollea por
          dentro: la pantalla medía 1340 px ([F] 2026-09-11, tarjeta O1-05). */}
      <Tabs defaultValue="events" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mb-4 shrink-0 self-start">
          <TabsTrigger value="events">{t('tabs.events')}</TabsTrigger>
          <TabsTrigger value="audit">{t('tabs.audit')}</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="mt-0 flex min-h-0 flex-1 flex-col">
          <LazyAdminSecurity />
        </TabsContent>

        <TabsContent value="audit" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <AuditLogsClient />
        </TabsContent>
      </Tabs>
    </div>
  )
}
