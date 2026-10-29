import type { Metadata } from 'next'
import { Effect } from 'effect'
import { getTranslations } from 'next-intl/server'
import { AppShell } from '@/components/providers/AppShell'
import { runServerEffect } from '@/lib/effect/runtime'

export const dynamic = 'force-dynamic'

const loadSettingsMetadata = Effect.fn('SettingsLayout.generateMetadata')(function* (
  locale: string
) {
  const t = yield* Effect.promise(() => getTranslations({ locale, namespace: 'settings' }))
  return { title: t('title'), description: t('subtitle') } satisfies Metadata
})

// ===== SEO METADATA =====
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  return runServerEffect(loadSettingsMetadata(locale))
}

// El cromo y los providers viven acá, no en `(app)/layout.tsx`: un entry con
// Convex a nivel de grupo arrastraba sus chunks a la landing (tarjeta O2-06).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
