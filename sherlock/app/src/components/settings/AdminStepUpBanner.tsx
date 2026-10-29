// ============================================================================
// ADMIN STEP-UP BANNER
// ============================================================================
// Lo que ve el equipo cuando `requireRole` lo rebota de /admin/* por step-up
// caducado. El marcador solo lo emite `createAdminStepUpCookieValue` para SSO o
// Passkey, así que "configura un segundo factor" mandaba a la gente a enrolar un
// TOTP que no abre nada. El copy nombra la acción que sí abre el panel y el CTA
// la ejecuta.
// ============================================================================

import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Schema } from 'effect'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { defaultLocale, locales } from '@/i18n/config'

// ===== LA COSTURA CON EFFECT =====
// `locale` no es un idioma: es el segmento crudo de la ruta (`params.locale` en
// `settings/page.tsx` está tipado `string`) y de acá pasa a construir el
// destino del login. Escrito sin comprobar, un segmento que empiece por barra
// deja el destino con dos barras al frente, y eso el navegador lo lee como URL
// absoluta a otro dominio, no como ruta interna. Ahora el segmento se comprueba
// contra la lista canónica de idiomas —la misma que usa el routing, no una
// copia— y lo que no esté en ella cae al idioma por defecto.
//
// El comentario no escribe el ejemplo literal a propósito:
// `locale-navigation-boundary.test.ts` lee estos archivos como texto y un
// ejemplo en prosa le cuenta como violación.
const LocaleSchema = Schema.Literals(locales)
const isLocale = Schema.is(LocaleSchema)

interface AdminStepUpBannerProps {
  locale: string
}

export function AdminStepUpBanner({ locale }: AdminStepUpBannerProps) {
  const t = useTranslations('settings')

  // `/login` es una ruta raíz de AuthKit (fuera de `[locale]`), así que va como
  // anchor plano: `Link` de `@/i18n/navigation` le pondría prefijo de idioma a
  // una ruta que no lo tiene. El destino sí se localiza, en el returnTo.
  const returnTo = `/${isLocale(locale) ? locale : defaultLocale}/admin`
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <Alert className="border-warning/30 bg-warning/10">
      <AlertTriangle className="text-warning h-4 w-4" />
      <AlertTitle className="text-warning">{t('adminStepUpTitle')}</AlertTitle>
      <AlertDescription className="text-warning/90">
        <p>{t('adminStepUpDescription')}</p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <a href={signInHref}>{t('adminStepUpCta')}</a>
        </Button>
      </AlertDescription>
    </Alert>
  )
}
