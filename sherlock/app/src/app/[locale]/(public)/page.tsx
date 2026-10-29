import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { MycroftLanding } from '@/components/mycroft/MycroftLanding'
import { runServerEffect } from '@/lib/effect/runtime'
import { homePathForRole } from '@/lib/navigation/home'
import { buildLocalizedPageMetadata } from '@/lib/site/brand'

// La casa de una empresa ya está nombrada una vez, en `lib/navigation/home.ts`.
// El `/my-company/documents` escrito acá era la segunda copia: si la sala se
// mudara, el `returnTo` del registro seguiría apuntando a la vieja.
const COMPANY_HOME = homePathForRole('COMPANY')

class HomeCopyError extends Schema.TaggedError<HomeCopyError>()('HomeCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadHomeMetadata = Effect.fn('HomePage.generateMetadata')(function* (locale: string) {
  const t = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'mycroft.meta' }),
    catch: (cause) => new HomeCopyError({ cause }),
  })
  const siteMeta = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'site.meta' }),
    catch: (cause) => new HomeCopyError({ cause }),
  })
  return buildLocalizedPageMetadata({
    locale,
    path: '',
    title: t('title'),
    description: t('description'),
    imageAlt: siteMeta('imageAlt'),
  })
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  return runServerEffect(loadHomeMetadata(locale))
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isSupportedLocale(locale)) notFound()
  setRequestLocale(locale)
  const secureHref = `/${locale}/sign-up?returnTo=${encodeURIComponent(`/${locale}${COMPANY_HOME}`)}`

  return <MycroftLanding secureHref={secureHref} />
}
