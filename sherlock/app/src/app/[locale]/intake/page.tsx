import { Effect, Schema } from 'effect'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { setRequestLocale } from 'next-intl/server'

import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { IntakeWorkspace } from '@/components/mycroft/IntakeWorkspace'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { runServerEffect } from '@/lib/effect/runtime'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { readIntakeSessionTokenFromCookieStore, resolveIntakeWorkspace } from '@/lib/intake/session'

export const dynamic = 'force-dynamic'
export const metadata = {
  robots: { index: false, follow: false, noarchive: true },
  referrer: 'no-referrer' as const,
}

class IntakeWorkspaceLoadError extends Schema.TaggedError<IntakeWorkspaceLoadError>()(
  'IntakeWorkspaceLoadError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadIntakeWorkspace = Effect.fn('IntakePage.loadWorkspace')(function* () {
  const cookieStore = yield* Effect.tryPromise({
    try: () => cookies(),
    catch: (cause) => new IntakeWorkspaceLoadError({ cause }),
  })
  const sessionToken = readIntakeSessionTokenFromCookieStore(cookieStore)
  if (!sessionToken) return null
  return yield* Effect.promise(() => resolveIntakeWorkspace(sessionToken))
})

export default async function IntakePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isSupportedLocale(locale)) notFound()
  setRequestLocale(locale)

  if (
    process.env.NODE_ENV !== 'production' &&
    DEV_AUTH_ENABLED &&
    process.env.E2E_INTAKE_FIXTURE === 'true'
  ) {
    return <IntakeWorkspace initialWorkspace={null} />
  }

  if (!isIntakeDemoModeEnabled()) {
    redirect(`/${locale}/sign-up?returnTo=${encodeURIComponent(`/${locale}/my-company/documents`)}`)
  }

  const initialWorkspace = await runServerEffect(loadIntakeWorkspace())

  return <IntakeWorkspace initialWorkspace={initialWorkspace} />
}
