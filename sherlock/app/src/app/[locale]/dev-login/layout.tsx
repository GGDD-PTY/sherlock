// Force dynamic rendering to avoid auth env validation during build.
//
// Monta el shell de la app a mano porque la ruta vive fuera de los dos grupos:
// el bypass de dev-auth que firma al usuario es parte de esos providers
// (tarjeta O2-06).
//
// Fail-closed en dos capas, como `dev-viewers`: `src/proxy.ts` solo reconoce el
// segmento con dev-auth encendido, y este layout repite la condición con
// `notFound()`. Sin dev-auth (producción y staging) la ruta no existe.

import type { Metadata } from 'next'
import { Effect } from 'effect'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { AppShell } from '@/components/providers/AppShell'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { runServerEffect } from '@/lib/effect/runtime'

export const dynamic = 'force-dynamic'

const loadDevLoginMetadata = Effect.fn('DevLoginLayout.generateMetadata')(function* (
  locale: string
) {
  const t = yield* Effect.promise(() => getTranslations({ locale, namespace: 'devLogin.metadata' }))
  // Página de herramienta, nunca de índice: el robots.txt ya la excluye y la
  // meta lo repite para quien llegue sin leerlo.
  return {
    title: t('title'),
    description: t('description'),
    robots: { index: false, follow: false },
  } satisfies Metadata
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  return runServerEffect(loadDevLoginMetadata(locale))
}

export default function DevLoginLayout({ children }: { children: React.ReactNode }) {
  if (!DEV_AUTH_ENABLED) notFound()
  return <AppShell>{children}</AppShell>
}
