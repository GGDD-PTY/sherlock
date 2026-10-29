import { withHandoffNonce } from '@/lib/mycroft/handoff-navigation'
import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { requireAuth } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { api } from '@/../convex/_generated/api'
import type { Doc, Id } from '@/../convex/_generated/dataModel'
import { ROOM_SCREEN_PATH, type RoomScreen } from '@/components/company/roomScreens'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { localConvexAdminKey } from '@/lib/dev-auth/local-convex-identity'
import { homePathForRole } from '@/lib/navigation/home'
import { resolveDemoCompany } from '@/lib/dev-auth/demo-company'

// ===== FIXTURE O BACKEND REAL =====
// Con `bun run dev:local` hay backend Convex en 127.0.0.1 y admin key, así que
// la sala sale de la fila real del dueño impersonado por la cookie de dev-auth
// — la única forma de que un dueño sembrado con `seed:company` vea SU sala. El
// fixture (`DEMO_PUBLIC_COMPANIES`, `_demoSeed.roomForDevCompany`) queda para
// `bun run dev` contra la nube, donde no hay key y nadie impersona. Misma
// condición y misma forma que `admin/companies/[id]/documents/page.tsx`.
const HAS_LOCAL_CONVEX_IDENTITY =
  localConvexAdminKey(
    {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
    },
    DEV_AUTH_ENABLED
  ) !== null
const USE_DEV_AUTH_FIXTURES = DEV_AUTH_ENABLED && !HAS_LOCAL_CONVEX_IDENTITY

type VdrWorkspaceAccess = 'MANAGE' | 'READ_ONLY'

type CompanyConvexClient = NonNullable<Awaited<ReturnType<typeof getAuthenticatedConvex>>>['client']

// ===== CARGA DE LA SALA =====
// Las dos formas de quedarse sin sala tienen destinos distintos, y el `reason`
// es lo que las separa: sin sesión de empresa el alta sigue viva y el destino
// es /onboarding; una consulta caída NO significa «no tienes empresa».
class CompanyWorkspaceUnavailable extends Schema.TaggedError<CompanyWorkspaceUnavailable>()(
  'CompanyWorkspaceUnavailable',
  {
    reason: Schema.Literals(['no-company-session', 'query-failed']),
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

// En modo demo la empresa sale del fixture local. Si ese resolutor se cae, la
// pantalla tiene que terminar en /onboarding igual que en el camino real, no en
// un 500: el try/catch que lo cubría se volvió este fallo con nombre.
const loadDemoCompany = Effect.fn('CompanyScreen.loadDemoCompany')(function* (
  profileId: Id<'profiles'>
) {
  return yield* Effect.tryPromise({
    try: () => resolveDemoCompany(profileId),
    catch: (cause) => new CompanyWorkspaceUnavailable({ reason: 'query-failed', cause }),
  })
})

const loadCompanyWorkspace = Effect.fn('CompanyScreen.loadWorkspace')(function* () {
  const convexAuth = yield* Effect.tryPromise({
    try: () => getAuthenticatedConvex(),
    catch: (cause) => new CompanyWorkspaceUnavailable({ reason: 'no-company-session', cause }),
  })
  if (!convexAuth?.client || !convexAuth.isAuthenticated) {
    return yield* new CompanyWorkspaceUnavailable({ reason: 'no-company-session' })
  }

  const workspace = yield* Effect.tryPromise({
    try: () => convexAuth.client.query(api.companies.getMyVdrWorkspace, {}),
    catch: (cause) => new CompanyWorkspaceUnavailable({ reason: 'query-failed', cause }),
  })

  return { client: convexAuth.client, workspace }
})

// La barra solo ofrece «Invitados» cuando la empresa tiene NDA aprobado. Es una
// lectura de cortesía: si falla, la pantalla se esconde y la sala sigue.
const loadGuestsAvailable = Effect.fn('CompanyScreen.loadGuestsAvailable')(function* (
  client: CompanyConvexClient,
  companyId: Id<'companies'>
) {
  return yield* Effect.tryPromise({
    try: () => client.query(api.guestAccess.listForCompany, { companyId, locale: 'es' }),
    catch: (cause) => new CompanyWorkspaceUnavailable({ reason: 'query-failed', cause }),
  }).pipe(
    Effect.map((roster) => roster.ndaConfigured),
    Effect.catch((error) =>
      Effect.logWarning('[CompanyScreen] guest roster unavailable:', error.cause ?? error).pipe(
        Effect.as(false)
      )
    )
  )
})

export type CompanyScreen = {
  /** `null` solo cuando la consulta del workspace cayó: la sala existe y volverá. */
  company: Doc<'companies'> | null
  accessMode: VdrWorkspaceAccess
  /** La sala de ejemplo de dev-auth: sin fila en Convex, nada se guarda. */
  isDemo: boolean
  convexClient: CompanyConvexClient | null
  workspaceQueryFailed: boolean
  guestsAvailable: boolean
}

/**
 * Resuelve la sala del cliente para una pantalla. Los `redirect()` se quedan
 * AFUERA de los programas Effect: su throw viaja con un `digest` que Next es lo
 * único que mira, y `Effect.runPromise` lo devolvería envuelto en un
 * `FiberFailure` que ya no lo tiene.
 */
export async function loadCompanyScreen(
  locale: string,
  screen: RoomScreen,
  handoffNonce?: string | null
): Promise<CompanyScreen> {
  const nonce = screen === 'documents' ? handoffNonce : null
  const destination =
    screen === 'documents'
      ? withHandoffNonce('/my-company/documents', nonce)
      : ROOM_SCREEN_PATH[screen]
  const user = await requireAuth(destination, locale)
  const effectiveRole = user.effectiveRole

  if (effectiveRole !== 'COMPANY') {
    redirect({ href: homePathForRole(effectiveRole), locale })
  }

  const profileId = user.profileId as Id<'profiles'> | null
  if (USE_DEV_AUTH_FIXTURES && !profileId) {
    redirect({ href: withHandoffNonce('/onboarding', nonce), locale })
  }

  let company: Doc<'companies'> | null = null
  let accessMode: VdrWorkspaceAccess = 'MANAGE'
  let isFixtureCompany = USE_DEV_AUTH_FIXTURES
  let convexClient: CompanyConvexClient | null = null
  let workspaceQueryFailed = false

  if (USE_DEV_AUTH_FIXTURES) {
    const resolved = await runServerEffect(
      loadDemoCompany(profileId!).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            `[CompanyScreen] Error fetching demo company (${error.reason}):`,
            error.cause ?? error
          )
        ),
        Effect.match({ onSuccess: (result) => result, onFailure: () => null })
      )
    )
    company = resolved?.company ?? null
    // Solo es demo sin bytes cuando la empresa sale del fixture local; una sala
    // sembrada en Convex tiene documentos reales y se abre como cualquier otra.
    isFixtureCompany = resolved?.isFixture ?? true
  } else {
    const loaded = await runServerEffect(
      loadCompanyWorkspace().pipe(
        Effect.tapError((error) =>
          Effect.logError(
            `[CompanyScreen] Error fetching company (${error.reason}):`,
            error.cause ?? error
          )
        ),
        Effect.match({
          onSuccess: (result) => ({ ok: true as const, ...result }),
          onFailure: (error) => ({ ok: false as const, reason: error.reason }),
        })
      )
    )

    if (loaded.ok) {
      convexClient = loaded.client
      if (loaded.workspace) {
        company = loaded.workspace.company
        accessMode = loaded.workspace.access
      }
    } else if (loaded.reason === 'query-failed') {
      // Cualquier fallo mandaba al cliente a /onboarding, y esa ruta lo
      // devuelve acá en cuanto ve que ya tiene empresa (`onboarding/route.ts`):
      // el ciclo se repetía hasta que Convex volviera. El fallo transitorio se
      // queda en la pantalla, con el estado de reintento de la sala.
      workspaceQueryFailed = true
    } else {
      redirect({ href: withHandoffNonce('/onboarding', nonce), locale })
    }
  }

  // Sin empresa —y sin fallo de consulta— el alta todavía está pendiente.
  if (!company && !workspaceQueryFailed) {
    redirect({ href: withHandoffNonce('/onboarding', nonce), locale })
  }

  const isDemo = USE_DEV_AUTH_FIXTURES && isFixtureCompany
  const guestsAvailable =
    company && convexClient && !isDemo && accessMode === 'MANAGE'
      ? await runServerEffect(loadGuestsAvailable(convexClient, company._id))
      : false

  return { company, accessMode, isDemo, convexClient, workspaceQueryFailed, guestsAvailable }
}

/** `generateMetadata` de una pantalla: título y descripción de `vdr.meta.<pantalla>`. */
export function roomScreenMetadata(screen: RoomScreen) {
  return async function generateMetadata({
    params,
  }: {
    params: Promise<{ locale: string }>
  }): Promise<Metadata> {
    const { locale } = await params
    const t = await runServerEffect(
      Effect.tryPromise({
        try: () => getTranslations({ locale, namespace: `vdr.meta.${screen}` }),
        catch: (cause) => cause,
      })
    )
    return { title: t('title'), description: t('description') }
  }
}
