// ============================================================================
// ONBOARDING — REENVÍO POR HTTP
// ============================================================================
// Parada de aprovisionamiento para usuarios nuevos. Decide por sesión, rol y
// empresa, y responde 307 antes de que se streamee HTML: como page, el
// `loading.tsx` mandaba primero el shell con los providers de cliente y el
// redirect() llegaba en medio del stream (React #310 al aterrizar en la sala).
// Un route handler no monta React, así que no hay shell que tirar. Lo único
// que sí necesita navegador —la mutation `companies.ensureCompanyWorkspace`
// con la identidad Convex del cliente, su estado de error con reintento y el
// embudo de analytics— vive en /onboarding/provision.
//
// FLUJO:
// 0. `?error=profile-fetch-failed` (Convex no contestó con sesión válida) → 503
// 1. Usuario sin perfil local o sin roleConfirmed → /onboarding/provision
// 2. Usuario COMPANY sin company → /onboarding/provision
// 3. Usuario COMPANY con company → /my-company/documents
// 4. Usuario ADMIN → /admin
// 5. Rol desconocido (userRole undefined) → /onboarding/provision
//
// La compuerta (`requireWorkosSession`) y los `redirect()` corren FUERA del
// programa Effect, con el mismo patrón que `runAuthDecision` en
// `lib/auth/session.ts`: el programa devuelve un destino tipado y el handler lo
// convierte en el throw que Next espera. Envolverlos en Effect funcionaba por
// accidente (`runPromise` conserva el `digest`), pero un `Effect.result` o
// `Effect.exit` futuro en ese pipe se habría comido el redirect sin que el
// typecheck avisara (A1-04).
// ============================================================================

import { withHandoffNonce } from '@/lib/mycroft/handoff-navigation'
import { readHandoffNonce } from '@/lib/mycroft/handoff-claim'
import { Effect, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'
import { NextResponse, type NextRequest } from 'next/server'

import { redirect } from '@/i18n/navigation'
import { requireWorkosSession } from '@/lib/auth/session'
import { getAuthenticatedConvex, getCurrentAuthenticatedUserState } from '@/lib/convex-auth'
import { api } from '@/../convex/_generated/api'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { getDemoCompanyFromPublicList } from '@/lib/dev-auth/demo-company'
import { hasLocalConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { runServerEffect } from '@/lib/effect/runtime'

export const dynamic = 'force-dynamic'

type UserRole = 'COMPANY' | 'ADMIN' | undefined
type WorkosSession = Awaited<ReturnType<typeof requireWorkosSession>>
type OnboardingStatus = {
  roleConfirmed: boolean
  onboardingCompleted: boolean
  companyExists: boolean
  userRole: UserRole
}
type RouteContext = { params: Promise<{ locale: string }> }

// Los únicos destinos que este handler sabe emitir: un path nuevo tiene que
// declararse aquí antes de poder redirigir.
type OnboardingDestination = '/onboarding/provision' | '/my-company/documents' | '/admin' | '/'

const PROFILE_FETCH_FAILED_ERROR = 'profile-fetch-failed'
const SERVICE_UNAVAILABLE_RETRY_HREF = '/my-company/documents'
const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60

const checkOnboardingStatus = Effect.fn('Onboarding.checkStatus')(function* (
  session: WorkosSession,
  status: OnboardingStatus
) {
  const currentUserState = yield* Effect.tryPromise({
    try: () =>
      getCurrentAuthenticatedUserState({
        requireConvexAuth: true,
      }),
    catch: (cause) => cause,
  })
  const profile = currentUserState?.profile

  if (profile?.roleConfirmed || DEV_AUTH_ENABLED) {
    status.roleConfirmed = true
    // Validar rol en runtime
    if (profile && (profile.role === 'COMPANY' || profile.role === 'ADMIN')) {
      // ===== DEMO MODE: USAR ROL DEL USER =====
      // En demo respetamos el rol seleccionado en DevAuth.
      status.userRole = DEV_AUTH_ENABLED ? (session.role ?? undefined) : profile.role
    } else {
      // Rol inválido - caer al aprovisionamiento
      status.userRole = undefined
    }
  }

  // ===== VERIFICAR ONBOARDING SEGÚN ROL =====
  const convexAuth = DEV_AUTH_ENABLED
    ? null
    : yield* Effect.tryPromise({
        try: () => getAuthenticatedConvex(),
        catch: (cause) => cause,
      })
  if (status.userRole === 'COMPANY' && profile) {
    const company = yield* Effect.tryPromise({
      try: async () => {
        if (DEV_AUTH_ENABLED) return getDemoCompanyFromPublicList(profile._id)
        if (convexAuth?.isAuthenticated) {
          return convexAuth.client.query(api.companies.getCompanyByOwner, {
            ownerId: profile._id,
          })
        }
        return null
      },
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    // getCompanyByOwner devuelve null cuando no hay empresa (no lanza), así
    // que esta bandera separa "sin empresa" de "empresa a medio wizard".
    status.companyExists = Boolean(company)
    if (company) status.onboardingCompleted = true
  } else if (status.userRole === 'ADMIN') {
    // ADMIN no necesita onboarding
    status.onboardingCompleted = true
  }
})

// El programa decide; no redirige. Devuelve el destino y el borde lo ejecuta.
const resolveOnboardingDestination = Effect.fn('Onboarding.destination')(function* (
  session: WorkosSession
) {
  const status: OnboardingStatus = {
    roleConfirmed: false,
    onboardingCompleted: false,
    companyExists: false,
    userRole: undefined,
  }

  yield* checkOnboardingStatus(session, status).pipe(
    Effect.catch((error) =>
      // Si hay error, caer al aprovisionamiento por seguridad
      Effect.logError('[OnboardingRoute] Error checking onboarding status:', error)
    )
  )

  // ===== DEMO MODE FALLBACK =====
  // En demo aseguramos rol confirmado aunque falte perfil.
  if (DEV_AUTH_ENABLED) {
    status.roleConfirmed = true
    status.userRole = session.role ?? status.userRole

    // Solo el carril de fixtures simula una empresa. Con un backend local,
    // la identidad ya existe y el flujo normal puede crear su espacio vacío.
    if (status.userRole === 'COMPANY' && !hasLocalConvexIdentity()) {
      status.companyExists = true
      status.onboardingCompleted = true
    }
  }

  // ===== LÓGICA DE REDIRECCIÓN =====

  // Si NO ha confirmado rol → aprovisionar el workspace
  if (!status.roleConfirmed) {
    return '/onboarding/provision' satisfies OnboardingDestination
  }

  // Si YA completó todo el onboarding → ir al destino vivo correspondiente
  if (status.onboardingCompleted) {
    return (
      status.userRole === 'ADMIN' ? '/admin' : '/my-company/documents'
    ) satisfies OnboardingDestination
  }

  // Missing company metadata is completed progressively in the workspace.
  if (status.userRole === 'COMPANY') {
    return (
      status.companyExists ? '/my-company/documents' : '/onboarding/provision'
    ) satisfies OnboardingDestination
  }
  if (status.userRole === 'ADMIN') {
    // ADMIN sin onboarding completo (raro) → ir a admin
    return '/admin' satisfies OnboardingDestination
  }
  // userRole undefined - caso inválido: aprovisionar el workspace para salir del limbo
  return '/onboarding/provision' satisfies OnboardingDestination
})

// ===== SERVICIO NO DISPONIBLE =====
// `requireAuth` y `requireWorkosSession` mandan acá con `?error=profile-fetch-failed`
// cuando la sesión de WorkOS es válida pero Convex no contestó (caído, lento
// más allá de la cota, o sesión sin access token). Volver a evaluar la sesión
// repetía la misma lectura y el mismo redirect hasta ERR_TOO_MANY_REDIRECTS
// (A1-01). Se responde 503 sin tocar Convex ni WorkOS; el enlace vuelve a la
// sala, donde `requireAuth` decide de nuevo con Convex ya de vuelta.
class ServiceUnavailableCopyError extends Schema.TaggedError<ServiceUnavailableCopyError>()(
  'ServiceUnavailableCopyError',
  { cause: Schema.optionalKey(Schema.Defect()) }
) {}

const loadServiceUnavailableCopy = Effect.fn('Onboarding.serviceUnavailableCopy')(function* (
  locale: string
) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'serviceUnavailable' }),
    catch: (cause) => new ServiceUnavailableCopyError({ cause }),
  })
})

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// Página mínima y autocontenida: no hay layout ni CSS del sitio en un route
// handler. Solo pigmentos del sistema (crema, navy, gris, borgoña) y la sans
// del sistema; nada más que un título, una línea y el enlace de reintento.
function serviceUnavailableHtml(
  locale: string,
  copy: { title: string; body: string; retry: string }
) {
  const title = escapeHtml(copy.title)
  const body = escapeHtml(copy.body)
  const retry = escapeHtml(copy.retry)
  const href = `/${locale}${SERVICE_UNAVAILABLE_RETRY_HREF}`
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F3EC;color:#0E1A2B;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;padding:2rem 1.5rem}
h1{font-size:1.5rem;font-weight:600;margin:0 0 .5rem}
p{margin:0 0 1.5rem;color:#6A7689}
a{color:#5A2331;text-decoration:underline;text-underline-offset:.2em}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${body}</p>
<a href="${href}">${retry}</a>
</main>
</body>
</html>
`
}

function serviceUnavailableResponse(
  locale: string,
  copy: { title: string; body: string; retry: string }
): NextResponse {
  return new NextResponse(serviceUnavailableHtml(locale, copy), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS),
    },
  })
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  // El locale llega validado por el proxy: nada sin prefijo conocido entra al
  // segmento `(app)`.
  const { locale } = await params

  if (request.nextUrl.searchParams.get('error') === PROFILE_FETCH_FAILED_ERROR) {
    const t = await runServerEffect(loadServiceUnavailableCopy(locale))
    return serviceUnavailableResponse(locale, {
      title: t('title'),
      body: t('body'),
      retry: t('retry'),
    })
  }

  // ===== SOFT AUTH (BOOTSTRAP) =====
  // El onboarding root usa la variante suave: exige sesión WorkOS + email, pero
  // PERMITE que el perfil de Convex todavía no exista. Esto rompe el deadlock de
  // first-login — requireAuth() estricto redirige un perfil ausente a
  // /onboarding?error=needs-profile, y si el propio /onboarding usara requireAuth
  // el usuario quedaría atrapado en un loop. Aquí, cuando falta el perfil,
  // mandamos a /onboarding/provision para que el bootstrap ocurra
  // (companies.ensureCompanyWorkspace).
  const session = await requireWorkosSession(locale)
  const handoffs = request.nextUrl.searchParams.getAll('handoff')
  const nonce = handoffs.length === 1 ? readHandoffNonce(handoffs[0]) : null

  // ===== FIRST-LOGIN: PERFIL AÚN NO EXISTE =====
  if (session.needsProfile) {
    return redirect({ href: withHandoffNonce('/onboarding/provision', nonce), locale })
  }

  const href = await runServerEffect(resolveOnboardingDestination(session))
  return redirect({
    href:
      href === '/onboarding/provision' || href === '/my-company/documents'
        ? withHandoffNonce(href, nonce)
        : href,
    locale,
  })
}
