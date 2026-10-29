// ============================================================================
// ROOT LAYOUT (por locale)
// ============================================================================
// Root layout de la app: todas las páginas viven bajo /[locale]/ (las rutas
// fuera — callback, login, logout, signup — son route handlers sin layout),
// así que <html lang={locale}> se sirve con el locale correcto en SSR y en
// prerender, sin depender de headers del middleware (patrón next-intl).
//
// Acá solo queda el documento: <html>, <body>, el tema y el mínimo de
// mensajes que necesita `error.tsx`, que cuelga directo de este layout. Los
// providers y el cromo se partieron en dos shells (tarjeta O2-06):
// `PublicShell` para el sitio público —sin Convex, sin AuthKit, sin
// dev-auth— y `AppShell` para la sala, el panel y el resto del producto.
// Mientras vivían acá, cada visita a la landing bajaba el cliente de Convex y
// AuthKit para no consultarlos nunca.
// ============================================================================

// ===== VALIDACIÓN DE ENV VARS AL INICIO =====
// La validación se ejecuta automáticamente al importar el módulo env.ts
import '@/lib/env'

import type { Metadata } from 'next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Effect, Schema } from 'effect'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { locales } from '@/i18n/config'
import { ROOT_MESSAGE_NAMESPACES, pickMessages } from '@/i18n/message-scopes'
import { runServerEffect } from '@/lib/effect/runtime'
import { getRootFontClassName } from '@/lib/fonts/font-config'
import { rootFontVariables } from '@/lib/fonts/root-fonts'
import { getPublicAppUrl, SITE_BRAND_NAME } from '@/lib/site/brand'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { THEME_BOOT_SCRIPT } from '@/lib/theme/boot-script'
import '../globals.css'
import '@/styles/print.css'

const APP_URL = getPublicAppUrl()

class LocaleLayoutLoadError extends Schema.TaggedError<LocaleLayoutLoadError>()(
  'LocaleLayoutLoadError',
  {
    locale: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadLocaleLayout = Effect.fn('LocaleLayout.load')(function* (locale: string) {
  const messages = yield* Effect.tryPromise({
    try: () => getMessages({ locale }),
    catch: (cause) => new LocaleLayoutLoadError({ locale, cause }),
  })
  return { messages: pickMessages(messages, ROOT_MESSAGE_NAMESPACES) }
})

export const metadata: Metadata = {
  // MetadataBase: URL base para resolver imágenes Open Graph
  metadataBase: new URL(APP_URL),

  // Título base y template para páginas
  title: {
    default: SITE_BRAND_NAME,
    template: '%s | Sherlock',
  },

  robots: {
    index: true,
    follow: true,
  },

  // Favicon e iconos con el monograma editorial Sherlock.
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  // Await params (Next.js 15+ requirement)
  const { locale } = await params

  // Validar que el locale sea válido. notFound() se queda fuera de Effect:
  // Effect.exit/either/result tragan el digest y la página renderiza.
  if (!isSupportedLocale(locale)) {
    notFound()
  }

  // Establecer el locale del request para next-intl
  setRequestLocale(locale)

  // Cargar mensajes de traducción para este locale
  // IMPORTANTE:
  // `getMessages()` sin locale puede caer en el defaultLocale y provocar que
  // componentes cliente rendericen en el idioma equivocado. Usamos
  // `setRequestLocale(locale)` antes de `getMessages()` para que el provider
  // tenga el bundle correcto. Cada shell vuelve a montar el suyo con los
  // namespaces que su árbol necesita.
  const { messages } = await runServerEffect(loadLocaleLayout(locale))

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={getRootFontClassName({ remoteFontVariables: rootFontVariables })}>
        {/* Primer hijo del body: bloquea el parser y aplica el tema pre-paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
        {/* Core Web Vitals por ruta. En Vercel el script y el endpoint son
            same-origin (`/_vercel/speed-insights/*`) y la CSP `'self'` los cubre.
            Fuera de Vercel (dev local, E2E, journeys) el componente cargaría
            `https://va.vercel-scripts.com/.../script.debug.js`, que la CSP
            bloquea y deja un error de consola que tumba los specs que exigen
            consola limpia. `VERCEL=1` lo pone la plataforma en build y runtime. */}
        {process.env.VERCEL === '1' ? <SpeedInsights /> : null}
      </body>
    </html>
  )
}

// Generar params estáticos para cada locale (mejor performance)
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }))
}
