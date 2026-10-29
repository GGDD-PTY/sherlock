// ============================================================================
// SETTINGS PAGE
// ============================================================================
// Pagina de configuracion de la cuenta
// Permite cambiar contrasena, 2FA, gestionar privacidad y eliminar cuenta
//
// Arquitectura:
// - Server Component: layout, email display, cards frame, auth
// - Client Components: SecurityActions, DeleteAccountDialog
//   (extraidos para manejar interactividad con la sesión y server actions)
// ============================================================================

import type { Metadata } from 'next'
import { Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { requireAuth } from '@/lib/auth/session'
import { AdminStepUpBanner } from '@/components/settings/AdminStepUpBanner'
import { SecurityActions } from '@/components/settings/SecurityActions'
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'
import { Button } from '@/components/ui/button'
import { ChevronRight } from 'lucide-react'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'settings' })

  return {
    title: t('title'),
    description: t('subtitle'),
  }
}

// El único `?error=` que esta pantalla sabe leer. Llega por la URL y hoy lo
// escribe `requireRole` cuando falta el step-up de admin
// (`ADMIN_MFA_REQUIRED_PATH` en `lib/auth/session.ts`). El vocabulario queda
// nombrado aquí: cualquier otro valor no enciende el aviso, en vez de
// compararse contra un literal suelto en medio del render.
const SettingsErrorSchema = Schema.Literals(['admin-mfa-required'])
const isSettingsError = Schema.is(SettingsErrorSchema)

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams?: Promise<{ error?: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const resolvedSearchParams = await searchParams
  // ===== VERIFICAR AUTENTICACION =====
  const user = await requireAuth('/settings', locale)
  const t = await getTranslations({ locale, namespace: 'settings' })

  const email = user.email || ''
  const adminStepUpRequired = isSettingsError(resolvedSearchParams?.error)

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <header>
        <h1>{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-base">{t('subtitle')}</p>
      </header>

      {adminStepUpRequired ? (
        <div className="mt-6">
          <AdminStepUpBanner locale={locale} />
        </div>
      ) : null}

      {/* Filas con hairline, sin tarjetas: cada bloque es una sección con su
          subtítulo en la cara de texto (docs/design-system.md, «Screens and canvas»). */}
      <section aria-labelledby="settings-security" className="mt-8">
        <h2 id="settings-security" className="font-sans text-base leading-tight font-semibold">
          {t('security')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('securityDescription')}</p>
        <dl className="divide-border-hairline border-border-hairline mt-3 divide-y border-y">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-sm">{t('accountEmail')}</dt>
            <dd className="flex min-w-0 items-center gap-3 text-sm">
              <span className="min-w-0 break-all">{email}</span>
              <span className="text-success shrink-0 text-xs font-medium">{t('verified')}</span>
            </dd>
          </div>
        </dl>
        <div className="mt-3">
          <SecurityActions />
        </div>
      </section>

      <section aria-labelledby="settings-privacy" className="mt-8">
        <h2 id="settings-privacy" className="font-sans text-base leading-tight font-semibold">
          {t('privacyData')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('privacyDataDescription')}</p>
        <div className="divide-border-hairline border-border-hairline mt-3 divide-y border-y">
          <Link
            href="/settings/privacy"
            className="hover:bg-muted/40 flex items-center justify-between gap-4 py-2.5"
          >
            <span>
              <span className="block text-sm font-medium">{t('privacySettings')}</span>
              <span className="text-muted-foreground block text-sm">
                {t('privacySettingsDescription')}
              </span>
            </span>
            <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
          </Link>
        </div>
      </section>

      {/* Dos acciones DISTINTAS, y la diferencia tiene que verse. Pausar es
          reversible y no borra nada (soft-delete: isActive=false). Eliminar es
          la supresión real y vive en Privacidad, porque necesita el flujo de
          solicitud, el plazo legal y el aviso de retención. */}
      <section aria-labelledby="settings-danger" className="mt-8">
        <h2 id="settings-danger" className="font-sans text-base leading-tight font-semibold">
          {t('dangerZone')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('dangerZoneDescription')}</p>
        <div className="divide-border-hairline border-border-hairline mt-3 divide-y border-y">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div>
              <p className="text-sm font-medium">{t('pauseAccount')}</p>
              <p className="text-muted-foreground text-sm">{t('pauseAccountDescription')}</p>
            </div>
            <DeleteAccountDialog />
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div>
              <p className="text-sm font-medium">{t('deleteAccount')}</p>
              <p className="text-muted-foreground text-sm">{t('deleteAccountDescription')}</p>
            </div>
            <Button variant="destructive" asChild>
              <Link href="/settings/privacy">{t('deleteAccountButton')}</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
