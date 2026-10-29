import { handleAuth, type HandleAuthSuccessData } from '@workos-inc/authkit-nextjs'
import { Effect, Schema } from 'effect'
import { cookies, headers } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { defaultLocale } from '@/i18n/config'
import { claimIntakeAfterAuthentication } from '@/lib/intake/claim'
import { scheduleIntakeClaimConversion } from '@/lib/analytics/server'
import { runServerEffect } from '@/lib/effect/runtime'
import { createLogger } from '@/lib/logger'
import { INTAKE_CLAIM_RETRY_COOKIE, INTAKE_CLAIM_RETRY_MARKER } from '@/lib/intake/claim-analytics'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import { clearIntakeCsrfCookieInStore } from '@/lib/intake/csrf'
import {
  clearIntakeSessionCookieInStore,
  readIntakeSessionTokenFromCookieStore,
} from '@/lib/intake/session'
import {
  ADMIN_STEP_UP_COOKIE_NAME,
  ADMIN_STEP_UP_MAX_AGE_SECONDS,
  createAdminStepUpCookieValue,
} from '@/lib/auth/admin-step-up'

const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL
const log = createLogger('Auth:Callback')

// Marks that a failed callback already got one automatic retry through /login,
// so a persistent failure lands on the home page instead of redirect-looping.
const AUTH_RETRY_COOKIE = 'sherlock-auth-retry'
const INTAKE_CLAIM_RETRY_MAX_AGE_SECONDS = 5 * 60

class CallbackError extends Schema.TaggedError<CallbackError>()('CallbackError', {
  reason: Schema.Literals(['cookies', 'headers', 'claim']),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function readAccessTokenSession(
  accessToken: string
): { subject: string; sessionId: string } | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    return typeof claims.sub === 'string' && typeof claims.sid === 'string'
      ? { subject: claims.sub, sessionId: claims.sid }
      : null
  } catch {
    return null
  }
}

const reconcileIntakeClaim = Effect.fn('Callback.reconcileIntakeClaim')(function* (
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  accessToken: string,
  sessionToken: string,
  workosSubject: string
) {
  const claimResult = yield* Effect.tryPromise({
    try: () =>
      claimIntakeAfterAuthentication({
        accessToken,
        sessionToken,
        workosSubject,
      }),
    catch: (cause) => new CallbackError({ reason: 'claim', cause }),
  })
  const requestHeaders = yield* Effect.tryPromise({
    try: () => headers(),
    catch: (cause) => new CallbackError({ reason: 'headers', cause }),
  })

  yield* Effect.try({
    try: () => {
      scheduleIntakeClaimConversion({
        claimDigest: claimResult.claimDigest,
        claimedDocumentCount: claimResult.claimedDocumentCount,
        locale: defaultLocale,
        requestHeaders,
      })
      cookieStore.delete(INTAKE_CLAIM_RETRY_COOKIE)
      // Ambas cookies del intake llevan prefijo `__Host-` en producción y
      // `cookieStore.delete()` emite un borrado sin `Secure` ni `Path=/`
      // que el navegador rechaza: la cookie de una sesión ya reclamada
      // sobrevivía y chocaba con la siguiente tanda de la landing.
      clearIntakeSessionCookieInStore(cookieStore)
      clearIntakeCsrfCookieInStore(cookieStore)
    },
    catch: (cause) => new CallbackError({ reason: 'claim', cause }),
  })
})

const handleCallbackSuccess = Effect.fn('Callback.onSuccess')(function* ({
  authenticationMethod,
  accessToken,
  user,
}: HandleAuthSuccessData) {
  const cookieStore = yield* Effect.tryPromise({
    try: () => cookies(),
    catch: (cause) => new CallbackError({ reason: 'cookies', cause }),
  })
  if (isIntakeDemoModeEnabled()) {
    const sessionToken = readIntakeSessionTokenFromCookieStore(cookieStore)
    if (sessionToken) {
      yield* reconcileIntakeClaim(cookieStore, accessToken, sessionToken, user.id).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            // Claim reconciliation is best effort at the auth boundary. Keep
            // both intake cookies so the user can still delete the temporary
            // room if the claim backend is stale or unavailable.
            cookieStore.set(INTAKE_CLAIM_RETRY_COOKIE, INTAKE_CLAIM_RETRY_MARKER, {
              httpOnly: false,
              maxAge: INTAKE_CLAIM_RETRY_MAX_AGE_SECONDS,
              path: '/',
              sameSite: 'lax',
              secure: process.env.NODE_ENV === 'production',
            })
          })
        )
      )
    }
  }

  let stepUpCookieValue: string | null = null
  try {
    const claims = readAccessTokenSession(accessToken)
    if (claims?.subject === user.id) {
      stepUpCookieValue = createAdminStepUpCookieValue(authenticationMethod, {
        subject: user.id,
        sessionId: claims.sessionId,
      })
    }
  } catch {
    // Fail closed: a callback without a valid session-bound token cannot
    // establish the privileged admin step-up marker.
  }

  yield* Effect.sync(() => {
    if (!stepUpCookieValue) {
      cookieStore.delete(ADMIN_STEP_UP_COOKIE_NAME)
      return
    }

    cookieStore.set(ADMIN_STEP_UP_COOKIE_NAME, stepUpCookieValue, {
      httpOnly: true,
      maxAge: ADMIN_STEP_UP_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  })
})

const handleCallbackError = Effect.fn('Callback.onError')(function* ({
  request,
}: {
  request: NextRequest
  error?: unknown
}) {
  return yield* Effect.sync(() => {
    const origin = appBaseUrl ?? request.nextUrl.origin
    const alreadyRetried = request.cookies.has(AUTH_RETRY_COOKIE)

    if (alreadyRetried) {
      const response = NextResponse.redirect(new URL(`/${defaultLocale}`, origin))
      response.cookies.set(AUTH_RETRY_COOKIE, '', { maxAge: 0, path: '/callback' })
      return response
    }

    const response = NextResponse.redirect(new URL('/login', origin))
    response.cookies.set(AUTH_RETRY_COOKIE, '1', {
      httpOnly: true,
      maxAge: 60,
      path: '/callback',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
    return response
  })
})

const authHandler = handleAuth({
  ...(appBaseUrl ? { baseURL: appBaseUrl } : {}),
  returnPathname: `/${defaultLocale}/onboarding`,
  onSuccess: (data) => runServerEffect(handleCallbackSuccess(data)),
  // WorkOS-initiated flows (dashboard impersonation, AuthKit hosted UI reached
  // directly) hit /callback without the PKCE `state` param and would 500.
  // Restart the flow once through /login (which seeds PKCE/state); if the
  // callback fails again with the retry marker present, land on home instead
  // of looping.
  onError: (params) => runServerEffect(handleCallbackError(params)),
})

// Las mismas cabeceras que `handleAuth` pone a la respuesta de `onError`.
function preventCallbackCaching(headers: Headers) {
  headers.set('Vary', 'Cookie')
  headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0')
  headers.set('x-middleware-cache', 'no-cache')
}

// Un /callback sin `state` (un hit pelado, o un flujo iniciado por WorkOS sin
// PKCE) es entrada del cliente, no una falla del servidor. `handleAuth` lo
// registra con `console.error` y un stack como error de runtime; acá se
// responde igual, por `onError`, y se registra a nivel warn. Sin `state` la
// librería no tiene cookie PKCE que borrar, así que la respuesta es la misma.
const handleMissingState = Effect.fn('Callback.missingState')(function* (request: NextRequest) {
  log.warn('AuthKit callback without required auth parameter', {
    hasCode: request.nextUrl.searchParams.has('code'),
  })
  const response = yield* handleCallbackError({ request })
  preventCallbackCaching(response.headers)
  return response
})

const getCallback = Effect.fn('Callback.GET')(function* (request: NextRequest) {
  if (!request.nextUrl.searchParams.get('state')) {
    return yield* handleMissingState(request)
  }
  // `handleAuth` puede terminar en `redirect()` de Next. El catch deja el
  // throw intacto para que Next vea el digest. Envolverlo en TaggedError
  // lo tragaría.
  return yield* Effect.tryPromise({
    try: () => authHandler(request),
    catch: (cause) => cause,
  })
})

export function GET(request: NextRequest): Promise<Response> {
  return runServerEffect(getCallback(request))
}
