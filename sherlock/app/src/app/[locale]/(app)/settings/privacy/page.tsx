import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { requireAuth } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

import { PrivacySettingsClient } from './PrivacySettingsClient'

class PrivacyMetadataError extends Schema.TaggedError<PrivacyMetadataError>()(
  'PrivacyMetadataError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadPrivacyMetadata = Effect.fn('PrivacySettings.generateMetadata')(function* (
  locale: string
) {
  const t = yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'settings.privacy.meta' }),
    catch: (cause) => new PrivacyMetadataError({ cause }),
  })
  return { title: t('title'), description: t('description') } satisfies Metadata
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  return runServerEffect(loadPrivacyMetadata(locale))
}

export default async function PrivacySettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  await requireAuth('/settings/privacy', locale)
  return <PrivacySettingsClient />
}
