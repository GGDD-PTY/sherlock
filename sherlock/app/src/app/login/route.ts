import { getSignInUrl } from '@workos-inc/authkit-nextjs'
import { Effect, Schema } from 'effect'
import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { decodeSafeReturnTo } from '@/app/[locale]/_shared/safe-return-to'
import { defaultLocale } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

class LoginError extends Schema.TaggedError<LoginError>()('LoginError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const getLogin = Effect.fn('Login.GET')(function* (request: NextRequest) {
  const decoded = decodeSafeReturnTo(request.nextUrl.searchParams.get('returnTo'))
  const returnTo = decoded._tag === 'Some' ? decoded.value : `/${defaultLocale}/onboarding`

  return yield* Effect.tryPromise({
    try: () => getSignInUrl({ returnTo }),
    catch: (cause) => new LoginError({ cause }),
  })
})

export async function GET(request: NextRequest) {
  return redirect(await runServerEffect(getLogin(request)))
}
