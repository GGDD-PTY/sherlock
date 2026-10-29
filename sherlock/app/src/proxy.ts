// ============================================================================
// PROXY - ROUTING + AUTH + i18n (Next.js 16+)
// ============================================================================
// 1. Canonicaliza el host de Vercel al origen configurado en producción
// 2. Maneja redirección automática por locale (next-intl)
// 3. Protege rutas autenticadas (WorkOS AuthKit) - BYPASSED en dev con BYPASS_AUTH
// ============================================================================

import createMiddleware from 'next-intl/middleware'
import { authkit, applyResponseHeaders, partitionAuthkitHeaders } from '@workos-inc/authkit-nextjs'
import { ConvexHttpClient } from 'convex/browser'
import { Duration, Effect } from 'effect'
import { locales, defaultLocale } from './i18n/config'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import { DEV_AUTH_ENABLED } from './lib/dev-auth/config'
import { devUserFromId } from './lib/dev-auth/seed-identity'
import { DEV_AUTH_COOKIE_ROLE, DEV_AUTH_COOKIE_USER, DEV_USERS } from './lib/dev-auth/types'
import type { DevRole } from './lib/dev-auth/types'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { parseAppOrigin } from '@/lib/site/app-url'
import { homePathForRole } from '@/lib/navigation/home'
import { isIntakeDemoModeEnabled } from './lib/intake/demo-mode'
import { OBSERVABILITY_PROBE_ROUTE } from './lib/observability/probe'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from './lib/api/response'
import {
  ADMIN_MFA_REQUIRED_PATH,
  ADMIN_STEP_UP_COOKIE_NAME,
  isRecentAdminStepUpCookie,
} from './lib/auth/admin-step-up'

// ===== i18n PROXY =====
const intlMiddleware = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

const ROOT_AUTHKIT_ROUTES = ['/callback', '/login', '/logout', '/signup']
const PUBLIC_METADATA_ROUTES = ['/robots.txt', '/sitemap.xml', '/auth.md'] as const
const PUBLIC_VDR_GUEST_API_ROUTES = new Set([
  '/api/vdr/guest/logout',
  '/api/vdr/guest/nda',
  '/api/vdr/guest/otp/request',
  '/api/vdr/guest/room',
  '/api/vdr/guest/session',
  '/api/vdr/guest/verify',
])
const PUBLIC_INTAKE_API_ROUTES = new Set([
  '/api/intake/data',
  '/api/intake/documents',
  '/api/intake/session',
  '/api/intake/support',
  '/api/intake/uploads',
  '/api/intake/uploads/register',
])
const INTAKE_PAGE_SEGMENT = 'intake'
// Banco de pruebas de los visores del VDR: monta <DocumentViewer/> con los
// parametros de la URL para que el journey Playwright pueda abrir un XLSX, un
// PDF, un DOCX, un PPTX y una imagen sin depender de Convex. Fail-closed por
// partida doble — la ruta solo existe fuera de produccion y con dev-auth, y la
// pagina misma responde 404 con la misma condicion.
const VIEWER_BENCH_PAGE_SEGMENT = 'dev-viewers'
// El único MCP es el del cliente sobre su VDR ([F] 2026-09-06, DECISIONS):
// su ruta y sus PRM (RFC 9728) llevan bearer propio, sin sesión de navegador.
// La PRM raíz existe porque el cliente MCP la pide ANTES que la de path: sin
// ella seguía el 307 de locale, recibía HTML donde esperaba JSON y caía al
// registro dinámico en `/register`, que tampoco existe.
const MCP_OAUTH_RESOURCE_ROUTES = new Set([
  '/api/vdr-mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/vdr-mcp',
])
const PUBLIC_PAGE_SEGMENTS = ['privacy', 'terms', 'legal', 'ayuda', 'vdr-guest']
const PUBLIC_AUTH_SEGMENTS = ['sign-in', 'sign-up'] as const
// El login de desarrollo solo existe con dev-auth encendido. Sin dev-auth es un
// segmento desconocido y el deny-by-default lo reescribe al 404, como a
// `dev-viewers`; su layout repite la condición con `notFound()`.
const DEV_LOGIN_PAGE_SEGMENT = 'dev-login'
// `dashboard` y `data-room` salieron de estas listas con sus rutas
// ([F] 2026-09-07 09:00): sin segmento registrado, el deny-by-default de abajo
// reescribe `/es/dashboard` y `/es/data-room` al 404 localizado.
const PROTECTED_PAGE_SEGMENTS = [
  'admin',
  'my-company',
  'notifications',
  'onboarding',
  'settings',
] as const

function isRootAuthkitRoute(pathname: string): boolean {
  return ROOT_AUTHKIT_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

function isPublicMetadataRoute(pathname: string): boolean {
  return PUBLIC_METADATA_ROUTES.some((route) => pathname === route)
}

function isKnownPublicPageSegment(segment: string): boolean {
  return (
    segment === INTAKE_PAGE_SEGMENT ||
    (segment === VIEWER_BENCH_PAGE_SEGMENT && isViewerBenchPageEnabled()) ||
    (segment === DEV_LOGIN_PAGE_SEGMENT && DEV_AUTH_ENABLED) ||
    PUBLIC_PAGE_SEGMENTS.some((value) => value === segment) ||
    PUBLIC_AUTH_SEGMENTS.some((value) => value === segment)
  )
}

function isKnownProtectedPageSegment(segment: string): boolean {
  return PROTECTED_PAGE_SEGMENTS.some((value) => value === segment)
}

function shouldLetRouterHandleUnknownLocalizedRoute(pathname: string): boolean {
  const [, locale, segment] = pathname.split('/')
  if (!locales.some((value) => value === locale)) return false
  if (!segment) return false
  return !isKnownPublicPageSegment(segment) && !isKnownProtectedPageSegment(segment)
}

// Segmentos públicos "hoja": no tienen sub-rutas reales, así que cualquier
// nested (/es/help/lo-que-sea) es un 404 conocido — antes caía al gate de auth
// y respondía 307 a sign-in en vez de 404.
const LEAF_PUBLIC_SEGMENTS = ['privacy', 'terms', 'legal', 'ayuda', 'vdr-guest', 'intake'] as const

function isViewerBenchPageEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && DEV_AUTH_ENABLED
}

function isIntakePageEnabled(): boolean {
  return (
    isIntakeDemoModeEnabled() ||
    (process.env.NODE_ENV !== 'production' &&
      DEV_AUTH_ENABLED &&
      process.env.E2E_INTAKE_FIXTURE === 'true')
  )
}

// Bajo `my-company` viven las pantallas de la sala (docs/design-system-vdr.md),
// una por intención. `profile` y `edit` (la ficha pública que hubo) se retiraron
// el 2026-09-07 ([F] 09:00) y no dejan sucesor: cualquier otro hijo es un 404
// conocido, antes de AuthKit, igual que las hojas públicas. Las pantallas se
// registran explícitas y todo lo demás cae cerrado.
const MY_COMPANY_PAGE_SEGMENT = 'my-company'
const MY_COMPANY_LIVE_CHILDREN = ['documents', 'company', 'preparation', 'team', 'guests'] as const

function isKnownDeadEndLocalizedPath(pathname: string): boolean {
  const [, locale, segment, nested] = pathname.split('/')
  if (!locales.some((value) => value === locale)) return false
  if (!segment || !nested) return false
  if (LEAF_PUBLIC_SEGMENTS.some((value) => value === segment)) return true
  if (segment === MY_COMPANY_PAGE_SEGMENT) {
    return !MY_COMPANY_LIVE_CHILDREN.some((value) => value === nested)
  }
  return false
}

// Fail-closed: los segmentos desconocidos se REESCRIBEN al catch-all 404 en
// vez de dejarse pasar al router — así una ruta real que falte en
// PROTECTED_PAGE_SEGMENTS da 404 en vez de quedar públicamente accesible.
const UNMATCHED_ROUTE_REWRITE_SEGMENT = '__not-found__'
const DESIGN_SYSTEM_SEGMENT = 'design-system'

function rewriteToLocalizedNotFound(request: NextRequest): NextResponse {
  const [, locale] = request.nextUrl.pathname.split('/')
  const url = request.nextUrl.clone()
  url.pathname = `/${locale}/${UNMATCHED_ROUTE_REWRITE_SEGMENT}`
  // status explícito: el streaming (loading.tsx) enviaría 200 antes de que el
  // notFound() del catch-all resuelva, así que lo fijamos desde el edge.
  return NextResponse.rewrite(url, { status: 404 })
}

function isDesignSystemRoute(pathname: string): boolean {
  const [, locale, segment] = pathname.split('/')
  return locales.some((value) => value === locale) && segment === DESIGN_SYSTEM_SEGMENT
}

function isNestedDesignSystemRoute(pathname: string): boolean {
  const [, , segment, nested] = pathname.split('/')
  return segment === DESIGN_SYSTEM_SEGMENT && Boolean(nested)
}

function handleDesignSystemRoute(request: NextRequest): NextResponse | null {
  if (!isDesignSystemRoute(request.nextUrl.pathname)) return null
  if (process.env.NODE_ENV === 'production') {
    // Do not rewrite through the localized layout in production. That layout
    // initializes AuthKit, so a private internal route could become a 500 when
    // no AuthKit request state exists instead of remaining indistinguishable
    // from an absent route.
    return new NextResponse(null, { status: 404 })
  }
  if (isNestedDesignSystemRoute(request.nextUrl.pathname)) {
    return rewriteToLocalizedNotFound(request)
  }
  return intlMiddleware(request)
}

// ===== RUTAS PÚBLICAS (NO REQUIEREN AUTH) =====
function isLocalizedPublicRoute(pathname: string) {
  const [, locale, segment, nested] = pathname.split('/')
  if (!locales.includes(locale as (typeof locales)[number])) return false
  if (!segment) return true
  if (segment === INTAKE_PAGE_SEGMENT) {
    return isIntakePageEnabled() && !nested
  }
  if (segment === VIEWER_BENCH_PAGE_SEGMENT) {
    return isViewerBenchPageEnabled() && !nested
  }
  if (segment === DEV_LOGIN_PAGE_SEGMENT) {
    return DEV_AUTH_ENABLED
  }
  if (PUBLIC_PAGE_SEGMENTS.includes(segment)) {
    return !nested
  }
  return PUBLIC_AUTH_SEGMENTS.some((value) => value === segment)
}

function intakeDemoModeOffResponse(request: NextRequest): NextResponse | null {
  if (isIntakeDemoModeEnabled() || !PUBLIC_INTAKE_API_ROUTES.has(request.nextUrl.pathname)) {
    return null
  }
  const requestId = getOrCreateRequestId(request)
  return apiError(requestId, 404, { error: 'Recurso no disponible' }) as NextResponse
}

function isPublicRoute(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/') return true
  if (PUBLIC_PAGE_SEGMENTS.includes(pathname.slice(1))) return true
  if (isRootAuthkitRoute(pathname)) return true
  if (pathname === '/api/health') return true
  if (pathname.startsWith('/api/webhooks')) return true
  // Bytes de fixtures del banco dev-viewers: misma puerta fail-closed que la
  // página del banco (jamás existe en producción) y allowlist cerrada en la
  // propia ruta. Exactamente un segmento extra: nada anidado se cuela.
  if (pathname.startsWith('/api/dev-fixtures/')) {
    return isViewerBenchPageEnabled() && pathname.split('/').length === 4
  }
  if (
    PUBLIC_VDR_GUEST_API_ROUTES.has(pathname) ||
    /^\/api\/vdr\/guest\/documents\/[a-zA-Z0-9_-]{1,128}$/.test(pathname)
  )
    return true
  if (isIntakeDemoModeEnabled() && PUBLIC_INTAKE_API_ROUTES.has(pathname)) return true
  return isLocalizedPublicRoute(pathname)
}

function hasDedicatedSuccessorBearerBoundary(pathname: string): boolean {
  return (
    MCP_OAUTH_RESOURCE_ROUTES.has(pathname) ||
    // El probe lo dispara un operador con un bearer de servidor, sin sesión de
    // navegador: pasa entero a su propia frontera. Exacta, sin prefijo: nada
    // anidado hereda la excepción.
    pathname === OBSERVABILITY_PROBE_ROUTE ||
    // JWKS del banco local: sin sesión; la propia ruta responde 404 fuera de
    // DEV_AUTH + loopback. Exacta, sin prefijo.
    pathname === '/api/dev/jwks'
  )
}

// Ninguna URL bajo `/.well-known/` lleva prefijo de locale: las fija una
// especificación, no el router. Caían en el negociador de next-intl, que las
// mandaba a `/es/.well-known/...` y devolvía el HTML del 404 a un cliente que
// esperaba JSON. Las conocidas ya pasaron arriba; lo que llegue acá no existe y
// se dice en JSON, sin `location`.
const WELL_KNOWN_PREFIX = '/.well-known/'

function unknownWellKnownResponse(pathname: string): NextResponse | null {
  if (!pathname.startsWith(WELL_KNOWN_PREFIX)) return null
  return NextResponse.json(
    { error: 'not_found' },
    { status: 404, headers: { 'cache-control': 'no-store' } }
  )
}

// ===== COMPUERTA DE ROL DEL PANEL =====
// El rol no viaja en el JWT de WorkOS: vive en el perfil de Convex. Hasta ahora
// solo lo miraba `requireRole` dentro de la página, y para entonces el shell de
// `/admin` (su layout y su `loading.tsx`) ya salió por streaming: el `redirect()`
// llega detrás de un 200 y el navegador lo cobra como hydration mismatch. La
// compuerta se adelanta acá y responde 307 antes de renderizar nada.
// `requireRole` se queda en cada página como defensa en profundidad.
//
// El step-up de MFA del ADMIN (A1-05) se decide en el mismo lugar y por la
// misma razón: el marcador `sherlock_admin_step_up` es una cookie del request y
// `authkit()` ya entrega el `sub` y el `sid` a los que va atado, así que un
// ADMIN recién entrado con contraseña recibe su 307 a /settings antes del shell,
// no dentro del stream.
const ADMIN_PAGE_SEGMENT = 'admin'

function isLocalizedAdminPath(pathname: string): boolean {
  const [, locale, segment] = pathname.split('/')
  return locales.some((value) => value === locale) && segment === ADMIN_PAGE_SEGMENT
}

// `href` es un path de la app sin locale, con o sin query (`/settings?error=x`).
function redirectToLocalizedHref(request: NextRequest, href: string): NextResponse {
  const [, locale] = request.nextUrl.pathname.split('/')
  const redirectLocale = locales.some((value) => value === locale) ? locale : defaultLocale
  const [path, query] = href.split('?')
  const url = request.nextUrl.clone()
  url.pathname = path === '/' ? `/${redirectLocale}` : `/${redirectLocale}${path}`
  url.search = query ? `?${query}` : ''
  return NextResponse.redirect(url)
}

function redirectToRoleHome(request: NextRequest, role: string): NextResponse {
  return redirectToLocalizedHref(request, homePathForRole(role))
}

// Misma resolución que `buildDemoAuthUser`: manda la cookie de usuario y la de
// rol solo la respalda, para que un ADMIN que esté viendo la app como empresa
// entre al panel igual que en `requireRole`.
function devAuthRealRole(request: NextRequest): DevRole | null {
  const userId = request.cookies.get(DEV_AUTH_COOKIE_USER)?.value
  const role = request.cookies.get(DEV_AUTH_COOKIE_ROLE)?.value
  const user =
    (userId ? devUserFromId(userId) : null) ??
    DEV_USERS.find((candidate) => candidate.role === role)
  return user?.role ?? null
}

// Una sola lectura, sin reintento y con techo corto: corre delante de cada
// request del panel. Si Convex no contesta se devuelve `null` y el request pasa
// al render, donde `requireRole` sigue gateando: un parpadeo de red no puede
// convertirse en un 500 ni en un rebote a la casa equivocada.
const convexProfileRoleEffect = Effect.fn('Proxy.convexProfileRole')(function* (
  accessToken: string
) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!convexUrl) {
    yield* Effect.logError('[proxy] NEXT_PUBLIC_CONVEX_URL not set; admin role gate deferred')
    return null
  }

  const client = new ConvexHttpClient(convexUrl)
  client.setAuth(accessToken)

  const state = yield* externalCall({
    service: 'Convex',
    operation: 'users.getCurrentUserState',
    retries: 0,
    timeout: Duration.seconds(3),
    run: () => client.query(api.users.getCurrentUserState, {}),
  }).pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )

  if (!state.ok) {
    yield* Effect.logError(
      '[proxy] admin role gate could not read the Convex profile:',
      state.error
    )
    return null
  }

  // Sin perfil todavía es el primer login: lo atiende el onboarding de
  // `requireAuth`, no esta compuerta.
  return state.value?.profile?.role ?? null
})

type AdminGateSession = {
  accessToken: string
  subject: string
  // `authkit()` lo entrega siempre que hay usuario; sin él no hay a qué atar el
  // marcador y se trata como ausente, igual que `hasRecentAdminStepUp`.
  sessionId: string | undefined
}

function adminStepUpRedirect(request: NextRequest, session: AdminGateSession): NextResponse | null {
  const marker = request.cookies.get(ADMIN_STEP_UP_COOKIE_NAME)?.value
  const fresh =
    session.sessionId !== undefined &&
    isRecentAdminStepUpCookie(marker, { subject: session.subject, sessionId: session.sessionId })
  return fresh ? null : redirectToLocalizedHref(request, ADMIN_MFA_REQUIRED_PATH)
}

// `null` cuando Convex no contestó o el perfil no existe: el request sigue al
// render y `requireRole` decide con la misma regla.
function adminGateRedirect(
  request: NextRequest,
  session: AdminGateSession
): Promise<NextResponse | null> {
  return runServerEffect(
    convexProfileRoleEffect(session.accessToken).pipe(
      Effect.map((role) => {
        if (role === null) return null
        if (role !== 'ADMIN') return redirectToRoleHome(request, role)
        return adminStepUpRedirect(request, session)
      })
    )
  )
}

// Una ruta sin prefijo de locale no es una ruta real: TODAS viven bajo
// /[locale]/. Hasta ahora la comprobación de auth corría ANTES de que next-intl
// pudiera redirigir, así que una hoja PÚBLICA abierta sin locale mandaba al
// visitante a WorkOS sign-in, mientras que la misma hoja bajo /es/ respondía
// 200. Links compartidos así van a seguir existiendo, así que el arreglo
// durable vive acá y no solo en los generadores.
//
// Deja que next-intl negocie el locale PRIMERO y emita su 307. El request
// siguiente vuelve a entrar por este mismo proxy ya con prefijo y se evalúa con
// las reglas de siempre: /admin sigue exigiendo sesión, solo que como
// /es/admin. Esto NO agrega nada a la allowlist pública.
function isLocalelessPagePath(pathname: string): boolean {
  if (pathname.startsWith('/api')) return false
  const [, first] = pathname.split('/')
  // La raíz "/" ya cae en intlMiddleware al final del flujo normal.
  if (!first) return false
  return !locales.includes(first as (typeof locales)[number])
}

function isVdrGuestLandingPath(pathname: string): boolean {
  const [, locale, segment, nested] = pathname.split('/')
  return locales.includes(locale as (typeof locales)[number]) && segment === 'vdr-guest' && !nested
}

function isNestedVdrGuestLandingPath(pathname: string): boolean {
  const [, locale, segment, nested] = pathname.split('/')
  return (
    locales.includes(locale as (typeof locales)[number]) &&
    segment === 'vdr-guest' &&
    Boolean(nested)
  )
}

function isIntakeLandingPath(pathname: string): boolean {
  const [, locale, segment, nested] = pathname.split('/')
  return (
    locales.includes(locale as (typeof locales)[number]) &&
    segment === INTAKE_PAGE_SEGMENT &&
    !nested
  )
}

function createVdrGuestNotFoundResponse(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  })
}

function secureVdrGuestLandingResponse(request: NextRequest, response: NextResponse) {
  if (
    !isVdrGuestLandingPath(request.nextUrl.pathname) &&
    !isIntakeLandingPath(request.nextUrl.pathname)
  ) {
    return response
  }
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

// La landing de Mycroft ES la home desde el swap C8: /mycroft ya no existe como
// ruta. Redirige en vez de 404 porque el path circuló en CTAs y links
// compartidos. Va antes del rewrite de rutas desconocidas — sin esto, sacar
// 'mycroft' de PUBLIC_PAGE_SEGMENTS lo convertiría en un 404.
function isRetiredMycroftPath(pathname: string): boolean {
  const [, locale, segment] = pathname.split('/')
  return locales.includes(locale as (typeof locales)[number]) && segment === 'mycroft'
}

// /help y /roadmap se fusionaron en /ayuda ([F] 2026-09-01: un solo hub, «menos
// copy, menos cards»). Redirige en vez de 404 porque los dos paths circularon en
// el navbar, el footer, la página 404 y el sitemap. Va antes del rewrite de
// rutas desconocidas: sin esto, sacarlos de PUBLIC_PAGE_SEGMENTS los convertiría
// en un 404. 308 y no 307 para que el path viejo se retire del índice.
const RETIRED_HUB_SEGMENTS = ['help', 'roadmap'] as const
const AYUDA_PAGE_SEGMENT = 'ayuda'

function isRetiredHubPath(pathname: string): boolean {
  const [, locale, segment, nested] = pathname.split('/')
  return (
    locales.includes(locale as (typeof locales)[number]) &&
    RETIRED_HUB_SEGMENTS.some((value) => value === segment) &&
    // Solo la hoja se redirige. `/es/help/lo-que-sea` nunca existió, así que
    // sigue siendo el 404 de siempre y no un salto al hub.
    !nested
  )
}

function redirectToLocalizedAyuda(request: NextRequest): NextResponse {
  const [, locale] = request.nextUrl.pathname.split('/')
  const url = request.nextUrl.clone()
  url.pathname = `/${locale}/${AYUDA_PAGE_SEGMENT}`
  url.search = ''
  return NextResponse.redirect(url, 308)
}

function redirectToLocalizedHome(request: NextRequest): NextResponse {
  const locale = locales.includes(
    request.nextUrl.pathname.split('/')[1] as (typeof locales)[number]
  )
    ? request.nextUrl.pathname.split('/')[1]
    : defaultLocale
  const url = request.nextUrl.clone()
  url.pathname = `/${locale}`
  url.search = ''
  return NextResponse.redirect(url)
}

// ES: ASSETS ESTÁTICOS DE LOS VISORES DEL VDR (/mog/*, /pdfjs/*).
// El bypass va por PREFIJO y no por extensión: el sidecar Mog y pdfjs sirven
// `.wasm`, `.mjs`, `.data`, `.otf` y `.ttf`, ninguna de las cuales está en el
// regex de `isStaticAssetRoute` ni en el `matcher` de abajo. Sin esta guarda,
// `/mog/assets/x.wasm` cae en el catch-all localizado, el navegador recibe el
// HTML del 404 y el runtime revienta con "expected magic word 00 61 73 6d,
// found 3c 21 64 6f" (LESSONS 2026-08-23). Es la PRIMERA comprobación de ambos
// proxies para que ninguna regla posterior (rewrite de rutas desconocidas)
// pueda reclamar el prefijo.
// EN: bypass the viewer asset prefixes before any rewrite can claim them.
const VIEWER_ASSET_PREFIXES = ['/mog/', '/pdfjs/'] as const

export function isViewerAssetRoute(pathname: string): boolean {
  return VIEWER_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function isStaticAssetRoute(pathname: string): boolean {
  if (pathname.startsWith('/_next')) return true
  if (pathname.startsWith('/_vercel')) return true
  if (
    /\.(?:html?|css|json|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$/.test(
      pathname
    )
  ) {
    return true
  }
  return false
}

function hasWorkOSSessionCookie(request: NextRequest) {
  return request.cookies.has(process.env.WORKOS_COOKIE_NAME || 'wos-session')
}

function applyAuthkitState(
  request: NextRequest,
  response: NextResponse,
  authkitHeaders: Headers,
  options: { includeRequestHeaders: boolean }
) {
  const { requestHeaders, responseHeaders } = partitionAuthkitHeaders(request, authkitHeaders)

  if (options.includeRequestHeaders) {
    const requestOverrideResponse = NextResponse.next({
      request: { headers: requestHeaders },
    })

    for (const [name, value] of requestOverrideResponse.headers) {
      if (name.toLowerCase().startsWith('x-middleware-')) {
        response.headers.set(name, value)
      }
    }
  }

  return applyResponseHeaders(response, responseHeaders)
}

// ===== PROXY SIMPLIFICADO PARA DEV AUTH =====
function devProxy(request: NextRequest) {
  const intakeOff = intakeDemoModeOffResponse(request)
  if (intakeOff) return intakeOff

  const { pathname } = request.nextUrl
  if (isViewerAssetRoute(pathname)) return NextResponse.next()

  const isApi = pathname.startsWith('/api')
  const designSystemResponse = handleDesignSystemRoute(request)

  if (designSystemResponse) return designSystemResponse
  if (hasDedicatedSuccessorBearerBoundary(pathname)) return NextResponse.next()
  const unknownWellKnown = unknownWellKnownResponse(pathname)
  if (unknownWellKnown) return unknownWellKnown
  // No se reescribe al catch-all localizado: ese layout inicializa AuthKit y,
  // sin middleware auth state, puede convertir un 404 público en un 500. La
  // ruta guest es hoja exacta y falla cerrada antes de tocar AuthKit/router.
  if (isNestedVdrGuestLandingPath(pathname)) return createVdrGuestNotFoundResponse()

  if (isPublicMetadataRoute(pathname)) return NextResponse.next()
  if (isRetiredMycroftPath(pathname)) return redirectToLocalizedHome(request)
  if (isRetiredHubPath(pathname)) return redirectToLocalizedAyuda(request)
  if (
    shouldLetRouterHandleUnknownLocalizedRoute(pathname) ||
    isKnownDeadEndLocalizedPath(pathname)
  ) {
    return rewriteToLocalizedNotFound(request)
  }

  if (isStaticAssetRoute(pathname)) {
    return NextResponse.next()
  }

  if (isRootAuthkitRoute(pathname)) {
    return NextResponse.next()
  }

  // Negociar el locale antes de exigir sesión (ver isLocalelessPagePath).
  if (isLocalelessPagePath(pathname)) {
    return intlMiddleware(request)
  }

  if (!isPublicRoute(request)) {
    const hasDevSession =
      request.cookies.has(DEV_AUTH_COOKIE_USER) && request.cookies.has(DEV_AUTH_COOKIE_ROLE)

    if (!hasDevSession) {
      if (isApi) {
        const requestId = getOrCreateRequestId(request)
        return withRequestIdHeader(
          NextResponse.json({ error: 'Unauthorized', requestId }, { status: 401 }),
          requestId
        )
      }

      const locale = pathname.split('/')[1]
      const redirectLocale = locales.includes(locale as (typeof locales)[number])
        ? locale
        : defaultLocale
      const url = request.nextUrl.clone()
      url.pathname = `/${redirectLocale}/${DEV_LOGIN_PAGE_SEGMENT}`
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  if (isLocalizedAdminPath(pathname)) {
    const role = devAuthRealRole(request)
    if (role !== null && role !== 'ADMIN') return redirectToRoleHome(request, role)
  }

  return secureVdrGuestLandingResponse(
    request,
    isApi ? NextResponse.next() : intlMiddleware(request)
  )
}

// ===== CANONICALIZACIÓN DE HOST (SOLO PRODUCCIÓN) =====
// Los hosts automáticos de Vercel se redirigen al origen de esta instalación.
// Ningún dominio del autor se acepta como alias implícito.
function normalizeHostHeader(rawHost: string | null): string {
  if (!rawHost) return ''
  const host = rawHost.trim().toLowerCase()
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']')
    return closingBracket === -1 ? host : host.slice(0, closingBracket + 1)
  }
  const portSeparator = host.indexOf(':')
  return portSeparator === -1 ? host : host.slice(0, portSeparator)
}

function canonicalHostRedirect(request: NextRequest): NextResponse | null {
  if (process.env.VERCEL_ENV !== 'production') return null
  const origin = parseAppOrigin(process.env.NEXT_PUBLIC_APP_URL ?? '', true)
  if (!origin) return null
  const host = normalizeHostHeader(request.headers.get('host'))
  if (!host || host === new URL(origin).hostname || !/\.vercel\.app$/i.test(host)) return null

  const { pathname, search } = request.nextUrl
  // 308 preserva método y body de APIs y webhooks.
  return NextResponse.redirect(`${origin}${pathname}${search}`, 308)
}

type ProxyHandler = (request: NextRequest) => NextResponse | Promise<NextResponse>

// Un solo envoltorio compartido: el check no puede vivir duplicado dentro de
// devProxy y workosProxy o una rama se queda atrás.
// ===== UNA SOLA CARA: ESPAÑOL =====
// [F] 2026-09-03: el sitio sirve únicamente español y el catálogo `en` ya no
// existe. El redirect conserva enlaces históricos sin mantener una segunda
// superficie de producto.
const ENGLISH_FACE_PREFIX = '/en'

function englishFaceRedirect(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl
  if (pathname !== ENGLISH_FACE_PREFIX && !pathname.startsWith(`${ENGLISH_FACE_PREFIX}/`)) {
    return null
  }
  const url = request.nextUrl.clone()
  url.pathname = `/${defaultLocale}${pathname.slice(ENGLISH_FACE_PREFIX.length)}`
  return NextResponse.redirect(url, 308)
}

function withCanonicalHost(handler: ProxyHandler): ProxyHandler {
  return (request) =>
    canonicalHostRedirect(request) ?? englishFaceRedirect(request) ?? handler(request)
}

// ===== PROXY PRINCIPAL =====
export const proxy = withCanonicalHost(DEV_AUTH_ENABLED ? devProxy : workosProxy)

async function workosProxy(request: NextRequest) {
  const intakeOff = intakeDemoModeOffResponse(request)
  if (intakeOff) return intakeOff

  const { pathname } = request.nextUrl
  if (isViewerAssetRoute(pathname)) return NextResponse.next()

  const designSystemResponse = handleDesignSystemRoute(request)

  if (designSystemResponse) return designSystemResponse
  if (hasDedicatedSuccessorBearerBoundary(pathname)) return NextResponse.next()
  const unknownWellKnown = unknownWellKnownResponse(pathname)
  if (unknownWellKnown) return unknownWellKnown
  if (isNestedVdrGuestLandingPath(pathname)) return createVdrGuestNotFoundResponse()

  if (isPublicMetadataRoute(pathname)) return NextResponse.next()
  if (isRetiredMycroftPath(pathname)) return redirectToLocalizedHome(request)
  if (isRetiredHubPath(pathname)) return redirectToLocalizedAyuda(request)
  if (
    shouldLetRouterHandleUnknownLocalizedRoute(pathname) ||
    isKnownDeadEndLocalizedPath(pathname)
  ) {
    return rewriteToLocalizedNotFound(request)
  }

  if (isStaticAssetRoute(pathname)) {
    return NextResponse.next()
  }

  if (isRootAuthkitRoute(pathname)) {
    return NextResponse.next()
  }

  // Negociar el locale antes de exigir sesión (ver isLocalelessPagePath).
  if (isLocalelessPagePath(pathname)) {
    return intlMiddleware(request)
  }

  const isPublic = isPublicRoute(request)
  const isApi = pathname.startsWith('/api')

  if (isPublic && isApi && !hasWorkOSSessionCookie(request)) {
    return NextResponse.next()
  }

  const {
    session,
    headers: authkitHeaders,
    authorizationUrl,
  } = await authkit(request, {
    redirectUri: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
  })

  if (!isPublic && !session.user) {
    if (isApi) {
      const requestId = getOrCreateRequestId(request)
      return withRequestIdHeader(
        applyAuthkitState(
          request,
          NextResponse.json({ error: 'Unauthorized', requestId }, { status: 401 }),
          authkitHeaders,
          { includeRequestHeaders: false }
        ),
        requestId
      )
    }

    return applyAuthkitState(
      request,
      NextResponse.redirect(authorizationUrl as string),
      authkitHeaders,
      { includeRequestHeaders: false }
    )
  }

  if (session.user && isLocalizedAdminPath(pathname)) {
    const gateRedirect = await adminGateRedirect(request, {
      accessToken: session.accessToken,
      subject: session.user.id,
      sessionId: session.sessionId,
    })
    if (gateRedirect) {
      return applyAuthkitState(request, gateRedirect, authkitHeaders, {
        includeRequestHeaders: false,
      })
    }
  }

  const response = isApi ? NextResponse.next() : intlMiddleware(request)
  return secureVdrGuestLandingResponse(
    request,
    applyAuthkitState(request, response, authkitHeaders, { includeRequestHeaders: true })
  )
}

export default proxy

export const config = {
  matcher: [
    '/((?!_next|ingest|monitoring|mog/|pdfjs/|[^?]*\\.(?:html?|css|js(?!on)|mjs|wasm|data|otf|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
