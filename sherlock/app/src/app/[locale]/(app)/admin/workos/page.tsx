import type { Metadata } from 'next'
import { Schema } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { WorkOSAdminPortalClient } from '@/components/admin/WorkOSAdminPortalClient'
import { requireRole } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { adminRoute, loadAdminTranslations } from '../_shared'

const ADMIN_ROUTE = adminRoute('/admin/workos')

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadAdminTranslations(locale, 'admin.workos.metadata'))
  return { title: t('title'), description: t('description') }
}

// El panel lee cinco variables de entorno y solo pregunta si están puestas.
// `process.env` es `Record<string, string | undefined>`: el valor entra sin
// forma garantizada, así que la pregunta se hace con un esquema —texto no
// vacío una vez recortado— en vez de un `Boolean(...)` que también diría que
// sí para cosas que no son texto.
const ConfiguredValueSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))

const isConfigured = Schema.is(ConfiguredValueSchema)

export default async function AdminWorkOSPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  setRequestLocale(locale)
  const [, t] = await Promise.all([
    requireRole(['ADMIN'], ADMIN_ROUTE, locale),
    runServerEffect(loadAdminTranslations(locale, 'admin.workos')),
  ])

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-4">
        <h1>{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('subtitle')}</p>
      </header>

      <WorkOSAdminPortalClient
        envStatus={{
          apiKey: isConfigured(process.env.WORKOS_API_KEY),
          clientId: isConfigured(process.env.WORKOS_CLIENT_ID),
          cookiePassword: isConfigured(process.env.WORKOS_COOKIE_PASSWORD),
          webhookSecret: isConfigured(process.env.WORKOS_WEBHOOK_SECRET),
          redirectUri: isConfigured(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI),
        }}
      />
    </div>
  )
}
