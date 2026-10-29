import { Effect, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'

import { SherlockLockup } from '@/components/shared/SherlockLockup'
import { Link } from '@/i18n/navigation'
import { defaultLocale, locales } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'
import { SITE_BRAND_NAME } from '@/lib/site/brand'

const SiteFooterLocaleSchema = Schema.Literals(locales)
const isSiteFooterLocale = Schema.is(SiteFooterLocaleSchema)

class SiteFooterCopyError extends Schema.TaggedError<SiteFooterCopyError>()('SiteFooterCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadSiteFooter = Effect.fn('SiteFooter.load')(function* (locale: (typeof locales)[number]) {
  const t = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'landing' }),
    catch: (cause) => new SiteFooterCopyError({ cause }),
  })
  return { t, year: new Date().getFullYear() }
})

export async function SiteFooter({ locale }: { locale: 'es' }) {
  const safeLocale = isSiteFooterLocale(locale) ? locale : defaultLocale
  const { t, year } = await runServerEffect(loadSiteFooter(safeLocale))

  // El aviso y el enlace Legal van a 14 px: el contrato deja los 12 px solo para
  // metadatos. En móvil la tagline ocupa su fila para que Legal no salga del margen.
  return (
    <footer className="border-border border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6 lg:px-8">
        <SherlockLockup title={SITE_BRAND_NAME} className="text-primary dark:text-foreground h-6" />
        <p className="text-muted-foreground basis-full text-xs sm:flex-1 sm:basis-auto">
          {t('footer.tagline')}
        </p>
        <nav aria-label={t('footer.legal.title')} className="flex">
          <Link
            href="/legal"
            className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          >
            {t('footer.legal.title')}
          </Link>
        </nav>
        <p className="text-muted-foreground text-xs">{t('footer.copyright', { year })}</p>
        <p className="text-muted-foreground w-full text-sm">{t('footer.disclaimer')}</p>
      </div>
    </footer>
  )
}
