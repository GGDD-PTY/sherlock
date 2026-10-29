// ============================================================================
// PÁGINA DE SIGN UP (WORKOS AUTHKIT)
// ============================================================================
// Esta página redirige el registro al flujo hosted de WorkOS AuthKit.
//
// ¿Por qué la ruta es [[...sign-up]]?
// Los dobles corchetes [[ ]] hacen que el segmento sea OPCIONAL, así cualquier
// subruta heredada (/sign-up/verify-email-address, /sign-up/continue, etc.)
// aterriza aquí y se redirige al flujo de AuthKit.
// ============================================================================

import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { decodeSafeReturnTo } from '@/app/[locale]/_shared/safe-return-to'
import { getRedirectParam, type SearchParams } from '@/lib/auth-utils'
import { isDevAuthEnabled } from '@/lib/dev-auth/config'
import { runServerEffect } from '@/lib/effect/runtime'

const DevLoginPathSchema = Schema.Literals(['/dev-login'])
const DEV_LOGIN_PATH = Schema.decodeSync(DevLoginPathSchema)('/dev-login')

const HostedSignUpPathSchema = Schema.Literals(['/signup'])
const HOSTED_SIGN_UP_PATH = Schema.decodeSync(HostedSignUpPathSchema)('/signup')

const OnboardingPathSchema = Schema.Literals(['/onboarding'])
const ONBOARDING_PATH = Schema.decodeSync(OnboardingPathSchema)('/onboarding')

class SignUpCopyError extends Schema.TaggedError<SignUpCopyError>()('SignUpCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadSignUpCopy = Effect.fn('SignUp.loadCopy')(function* (locale: string) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'auth.signUp' }),
    catch: (cause) => new SignUpCopyError({ cause }),
  })
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadSignUpCopy(locale))

  return {
    title: t('title'),
    description: t('subtitle'),
  }
}

export default async function SignUpPage({
  searchParams,
  params,
}: {
  searchParams: SearchParams
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  const decoded = decodeSafeReturnTo(await getRedirectParam(searchParams))
  const safeRedirect = decoded._tag === 'Some' ? decoded.value : undefined

  // ===== DEV MODE: REDIRIGIR A DEV-LOGIN =====
  // Conservamos returnTo para que el flujo demo respete el destino original.
  if (isDevAuthEnabled()) {
    redirect(
      `/${locale}${DEV_LOGIN_PATH}${safeRedirect ? `?returnTo=${encodeURIComponent(safeRedirect)}` : ''}`
    )
  }

  redirect(
    `${HOSTED_SIGN_UP_PATH}?returnTo=${encodeURIComponent(safeRedirect ?? `/${locale}${ONBOARDING_PATH}`)}`
  )
}
