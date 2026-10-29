// ============================================================================
// SHELL PÚBLICO
// ============================================================================
// Landing, ayuda, los tres documentos legales, sign-in y el 404 localizado.
// Ninguna de esas páginas consulta Convex ni la sesión de AuthKit, así que el
// shell no monta el cliente de Convex, ni el provider de AuthKit, ni el de
// dev-auth: 365 KB gzip de first-load JS en la landing eran en buena parte
// esos tres (tarjeta O2-06). El provider de mensajes recibe solo los
// namespaces que estas páginas usan (`i18n/message-scopes.ts`).
//
// PostHog sí se queda: `track()` encola en memoria y este provider es quien
// drena la cola, así que sin él la landing perdería su embudo. El SDK sigue
// bajando con `import()` diferido, fuera del grafo inicial
// (`landing-first-paint-contract.test.tsx`).
// ============================================================================

import type { ReactNode } from 'react'
import { Effect, Schema } from 'effect'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'

import { FooterGate } from '@/components/layout/FooterGate'
import { ProductFooter } from '@/components/layout/ProductFooter'
import { PublicNavbar } from '@/components/layout/PublicNavbar'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { PostHogProvider } from '@/components/providers/PostHogProvider'
import { MAIN_CONTENT_ID, SkipToContent } from '@/components/providers/SkipToContent'
import { PUBLIC_MESSAGE_NAMESPACES, pickMessages } from '@/i18n/message-scopes'
import { defaultLocale, locales } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

// `getLocale()` devuelve la string del request. El catálogo del router es
// el que manda: un valor fuera de él cae al locale por defecto en vez de
// viajar como locale a los footers y al provider.
const isSupportedLocale = Schema.is(Schema.Literals(locales))

class PublicShellLoadError extends Schema.TaggedError<PublicShellLoadError>()(
  'PublicShellLoadError',
  {
    locale: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadPublicShell = Effect.fn('PublicShell.load')(function* () {
  const requestLocale = yield* Effect.tryPromise({
    try: () => getLocale(),
    catch: (cause) => new PublicShellLoadError({ locale: 'unknown', cause }),
  })
  const locale = isSupportedLocale(requestLocale) ? requestLocale : defaultLocale
  const messages = yield* Effect.tryPromise({
    try: () => getMessages({ locale }),
    catch: (cause) => new PublicShellLoadError({ locale, cause }),
  })
  const tAria = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'common.navbar.aria' }),
    catch: (cause) => new PublicShellLoadError({ locale, cause }),
  })
  return { locale, messages: pickMessages(messages, PUBLIC_MESSAGE_NAMESPACES), tAria }
})

export async function PublicShell({ children }: { children: ReactNode }) {
  const { locale, messages, tAria } = await runServerEffect(loadPublicShell())

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <PostHogProvider>
        <SkipToContent label={tAria('skipToContent')} />

        <PublicNavbar />

        <main id={MAIN_CONTENT_ID}>{children}</main>

        <FooterGate
          site={<SiteFooter locale={locale} />}
          product={<ProductFooter locale={locale} />}
        />
      </PostHogProvider>
    </NextIntlClientProvider>
  )
}
