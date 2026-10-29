import { Effect, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'

import { FOOTER_LEGAL_LINKS } from '@/components/layout/footer-legal-links'
import { Link } from '@/i18n/navigation'
import { defaultLocale, locales } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

const LINK_CLASS =
  'hover:text-foreground focus-visible:ring-ring rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none'

const ProductFooterLocaleSchema = Schema.Literals(locales)
const isProductFooterLocale = Schema.is(ProductFooterLocaleSchema)

class ProductFooterCopyError extends Schema.TaggedError<ProductFooterCopyError>()(
  'ProductFooterCopyError',
  { cause: Schema.optionalKey(Schema.Defect()) }
) {}

const loadProductFooter = Effect.fn('ProductFooter.load')(function* (
  locale: (typeof locales)[number]
) {
  const t = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'landing' }),
    catch: (cause) => new ProductFooterCopyError({ cause }),
  })
  return {
    t,
    links: FOOTER_LEGAL_LINKS.map((link) => ({ label: t(link.key), href: link.href })),
    year: new Date().getFullYear(),
  }
})

// Footer de producto: una línea legal bajo un hairline. Sin tagline, sin
// columnas, sin "Sube tus documentos" dentro de la sala.
export async function ProductFooter({ locale }: { locale: 'es' }) {
  const safeLocale = isProductFooterLocale(locale) ? locale : defaultLocale
  const { t, links, year } = await runServerEffect(loadProductFooter(safeLocale))

  return (
    <footer className="border-border-hairline border-t" data-testid="product-footer">
      <div className="text-muted-foreground mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 text-xs sm:px-6 lg:px-8">
        <p>{t('footer.copyright', { year })}</p>
        <nav aria-label={t('footer.legal.title')} className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={LINK_CLASS}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  )
}
