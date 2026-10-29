// ============================================================================
// SHELL DE LA APP
// ============================================================================
// Los providers y el cromo de todo lo que no es el sitio público: la sala, el
// panel, el alta, el banco de visores y el invitado del VDR. Vivían en
// `[locale]/layout.tsx`, o sea que el cliente de Convex, AuthKit y el bundle
// entero de mensajes bajaban también en la landing, que no consulta ninguno
// de los tres (tarjeta O2-06). El shell público es `PublicShell.tsx`.
// ============================================================================

import type { ReactNode } from 'react'
import { Effect, Schema } from 'effect'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'

import { AdminChrome } from '@/components/admin/AdminChrome'
import { FooterGate } from '@/components/layout/FooterGate'
import { Navbar } from '@/components/layout/Navbar'
import { ProductFooter } from '@/components/layout/ProductFooter'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { AuthProvider } from '@/components/providers/AuthProvider'
import { ConvexClientProvider } from '@/components/providers/ConvexClientProvider'
import { PostHogProvider } from '@/components/providers/PostHogProvider'
import { MAIN_CONTENT_ID, SkipToContent } from '@/components/providers/SkipToContent'
import { Toaster } from '@/components/ui/sonner'
import { defaultLocale, locales } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

// `getLocale()` devuelve la string del request. El catálogo del router es
// el que manda: un valor fuera de él cae al locale por defecto en vez de
// viajar como locale a los footers y al provider.
const isSupportedLocale = Schema.is(Schema.Literals(locales))

class AppShellLoadError extends Schema.TaggedError<AppShellLoadError>()('AppShellLoadError', {
  locale: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadAppShell = Effect.fn('AppShell.load')(function* () {
  const requestLocale = yield* Effect.tryPromise({
    try: () => getLocale(),
    catch: (cause) => new AppShellLoadError({ locale: 'unknown', cause }),
  })
  const locale = isSupportedLocale(requestLocale) ? requestLocale : defaultLocale
  const messages = yield* Effect.tryPromise({
    try: () => getMessages({ locale }),
    catch: (cause) => new AppShellLoadError({ locale, cause }),
  })
  const tAria = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'common.navbar.aria' }),
    catch: (cause) => new AppShellLoadError({ locale, cause }),
  })
  return { locale, messages, tAria }
})

export async function AppShell({ children }: { children: ReactNode }) {
  const { locale, messages, tAria } = await runServerEffect(loadAppShell())

  return (
    <AuthProvider>
      <ConvexClientProvider>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <PostHogProvider>
            <SkipToContent label={tAria('skipToContent')} />

            <Navbar />

            <main id={MAIN_CONTENT_ID}>{children}</main>

            <FooterGate
              site={<SiteFooter locale={locale} />}
              product={<ProductFooter locale={locale} />}
            />

            <Toaster richColors position="top-right" containerAriaLabel={tAria('notifications')} />

            <AdminChrome />
          </PostHogProvider>
        </NextIntlClientProvider>
      </ConvexClientProvider>
    </AuthProvider>
  )
}
