import { getSignUpUrl, withAuth } from '@workos-inc/authkit-nextjs'
import { Effect, Schema } from 'effect'
import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { decodeSafeReturnTo } from '@/app/[locale]/_shared/safe-return-to'
import { defaultLocale } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

class SignupError extends Schema.TaggedError<SignupError>()('SignupError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const getSignup = Effect.fn('Signup.GET')(function* (request: NextRequest) {
  const decoded = decodeSafeReturnTo(request.nextUrl.searchParams.get('returnTo'))
  const returnTo = decoded._tag === 'Some' ? decoded.value : `/${defaultLocale}/onboarding`

  // Una sesión viva no pasa por el hosted de WorkOS: el rebote sign-up→callback
  // →returnTo era el hueco donde el cliente veía el error fatal transitorio
  // (E2E-01, auditoría 2026-08-30). Si leer la sesión falla, se conserva el
  // flujo normal de registro. El `.catch(() => null)` interior es la política;
  // `Effect.promise` no tiene un rechazo que mapear.
  const session = yield* Effect.promise(() => withAuth().catch(() => null))
  if (session?.user) return returnTo

  return yield* Effect.tryPromise({
    try: () => getSignUpUrl({ returnTo }),
    catch: (cause) => new SignupError({ cause }),
  })
})

export async function GET(request: NextRequest) {
  return redirect(await runServerEffect(getSignup(request)))
}
