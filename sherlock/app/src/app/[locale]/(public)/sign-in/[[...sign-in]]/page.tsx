import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { redirect } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { decodeSafeReturnTo } from '@/app/[locale]/_shared/safe-return-to'
import { Link } from '@/i18n/navigation'
import { getRedirectParam, type SearchParams } from '@/lib/auth-utils'
import { isDevAuthEnabled } from '@/lib/dev-auth/config'
import { runServerEffect } from '@/lib/effect/runtime'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const DevLoginPathSchema = Schema.Literals(['/dev-login'])
const DEV_LOGIN_PATH = Schema.decodeSync(DevLoginPathSchema)('/dev-login')

class SignInCopyError extends Schema.TaggedError<SignInCopyError>()('SignInCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadSignInCopy = Effect.fn('SignIn.loadCopy')(function* (locale: string) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'auth.signIn' }),
    catch: (cause) => new SignInCopyError({ cause }),
  })
})

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadSignInCopy(locale))

  return {
    title: t('title'),
    description: t('subtitle'),
  }
}

export default async function SignInPage({
  searchParams,
  params,
}: {
  searchParams: SearchParams
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const decoded = decodeSafeReturnTo(await getRedirectParam(searchParams))
  const safeRedirect = decoded._tag === 'Some' ? decoded.value : undefined

  // ===== DEV MODE: REDIRIGIR A DEV-LOGIN =====
  // Conservamos returnTo para que el flujo demo respete el destino original.
  if (isDevAuthEnabled()) {
    const devLoginHref = safeRedirect
      ? `${DEV_LOGIN_PATH}?returnTo=${encodeURIComponent(safeRedirect)}`
      : DEV_LOGIN_PATH
    return (
      <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-4">
        <Card className="bg-card text-card-foreground border-border w-full max-w-md">
          <CardHeader>
            <CardTitle>Development sign in</CardTitle>
            <CardDescription className="text-muted-foreground">
              Auth bypass is enabled. Use the demo login surface to choose a role.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href={devLoginHref}>Open Demo Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  redirect(`/login?returnTo=${encodeURIComponent(safeRedirect ?? `/${locale}/onboarding`)}`)
}
