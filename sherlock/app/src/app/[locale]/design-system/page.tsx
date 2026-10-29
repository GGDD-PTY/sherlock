import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { PrimitiveShowcase } from '@/components/showcase/PrimitiveShowcase'
import { runServerEffect } from '@/lib/effect/runtime'

type DesignSystemPageProps = {
  readonly params: Promise<{ readonly locale: string }>
}

class DesignSystemCopyError extends Schema.TaggedError<DesignSystemCopyError>()(
  'DesignSystemCopyError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadDesignSystemMetadata = Effect.fn('DesignSystemPage.generateMetadata')(function* (
  locale: string
) {
  const t = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'designSystem' }),
    catch: (cause) => new DesignSystemCopyError({ cause }),
  })
  return {
    title: t('meta.title'),
    description: t('meta.description'),
    robots: { index: false, follow: false },
  } satisfies Metadata
})

export async function generateMetadata({ params }: DesignSystemPageProps): Promise<Metadata> {
  const { locale } = await params
  return runServerEffect(loadDesignSystemMetadata(locale))
}

export default async function DesignSystemPage({ params }: DesignSystemPageProps) {
  if (process.env.NODE_ENV === 'production') {
    notFound()
  }

  const { locale } = await params
  if (!isSupportedLocale(locale)) {
    notFound()
  }

  setRequestLocale(locale)
  return <PrimitiveShowcase />
}
