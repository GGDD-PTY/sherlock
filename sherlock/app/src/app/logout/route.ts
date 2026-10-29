import { signOut } from '@workos-inc/authkit-nextjs'
import { Effect, Schema } from 'effect'
import { cookies } from 'next/headers'
import { defaultLocale } from '@/i18n/config'
import { ADMIN_STEP_UP_COOKIE_NAME } from '@/lib/auth/admin-step-up'
import { runServerEffect } from '@/lib/effect/runtime'

class LogoutError extends Schema.TaggedError<LogoutError>()('LogoutError', {
  reason: Schema.Literals(['cookies']),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const getLogout = Effect.fn('Logout.GET')(function* () {
  const cookieStore = yield* Effect.tryPromise({
    try: () => cookies(),
    catch: (cause) => new LogoutError({ reason: 'cookies', cause }),
  })
  yield* Effect.sync(() => cookieStore.delete(ADMIN_STEP_UP_COOKIE_NAME))
  // `signOut` de AuthKit llama `redirect()`: el catch deja el throw intacto
  // para que Next vea el digest. Envolverlo en TaggedError lo tragaría.
  return yield* Effect.tryPromise({
    try: () => signOut({ returnTo: `/${defaultLocale}` }),
    catch: (cause) => cause,
  })
})

export function GET() {
  return runServerEffect(getLogout())
}
