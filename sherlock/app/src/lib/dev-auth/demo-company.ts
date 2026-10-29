import { Effect } from 'effect'
import { fetchQuery } from 'convex/nextjs'

import { api } from '@/../convex/_generated/api'
import type { Doc, Id } from '@/../convex/_generated/dataModel'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { DEMO_COMPANY_PROFILE_ID, DEMO_PUBLIC_COMPANIES } from '@/lib/dev-auth/demo-data'
import { isLoopbackConvexUrl, localConvexAdminKey } from '@/lib/dev-auth/local-convex-identity'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

// La sala demo se dibuja en el render de la página. Convex colgado no puede
// colgar el render. En un backend local real, un fallo nunca habilita datos
// ficticios; la sala permanece vacía. El carril aislado de E2E usa sus fixtures.
const DEMO_COMPANY_QUERY_TIMEOUT_MS = 5_000

// ===== FIXTURE O BACKEND REAL =====
// Con `bun run dev:local` hay admin key, así que el dueño de la cookie de
// dev-auth está impersonado y su empresa se lee autenticada por
// `getCompanyByOwner`. La otra lectura es `_demoSeed.roomForDevCompany`, que
// resuelve la sala demo por el dueño `company@dev.local` y la marca `demo`.
// Un backend loopback nunca cae al fixture, incluso si no tiene key o sala.
// Los fixtures quedan disponibles para el carril E2E aislado sin backend local.
const IS_LOCAL_CONVEX_BACKEND = isLoopbackConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL)
const HAS_LOCAL_CONVEX_IDENTITY =
  localConvexAdminKey(
    {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
    },
    DEV_AUTH_ENABLED
  ) !== null

// Los dos ids de fixture no son ids de Convex: preguntarle al backend por ellos
// es un error de validación, no una respuesta vacía.
const FIXTURE_PROFILE_IDS = new Set<string>([DEMO_COMPANY_PROFILE_ID])

type DemoCompany = Doc<'companies'> & {
  employees?: string
  isVerified?: boolean
}

export type DemoCompanyResolution = {
  company: DemoCompany | null
  /** Verdadero cuando la empresa sale del fixture local y no de Convex: sin fila
   * real no hay documentos ni bytes que pedir, y la sala tiene que decirlo. */
  isFixture: boolean
}

type ConvexDemoLookup = { readonly kind: 'seeded-room'; readonly company: DemoCompany }

export async function getDemoCompanyFromPublicList(
  ownerId?: Id<'profiles'> | string | null
): Promise<DemoCompany | null> {
  return (await resolveDemoCompany(ownerId)).company
}

/**
 * La sala demo se resuelve por `_demoSeed.roomForDevCompany` (dueño
 * `company@dev.local` + marca `demo`), no por un catálogo público. Entra por
 * `externalCall`: span, error tipado y cota de tiempo. Sin reintentos: el
 * carril demo prefiere caer rápido al fixture local antes que hacer esperar
 * al render por un deployment roto.
 */
const lookupDemoCompanyInConvex = Effect.fn('DemoCompany.lookupInConvex')(function* (
  _ownerId: Id<'profiles'> | string | null | undefined
) {
  const seededRoom = yield* externalCall({
    service: 'Convex',
    operation: '_demoSeed.roomForDevCompany',
    timeout: DEMO_COMPANY_QUERY_TIMEOUT_MS,
    retries: 0,
    run: () => fetchQuery(api._demoSeed.roomForDevCompany, {}),
  })
  if (!seededRoom) return null
  const seeded: ConvexDemoLookup = { kind: 'seeded-room', company: seededRoom as DemoCompany }
  return seeded
})

/** La empresa del dueño impersonado, leída con su propia sesión local. */
const ownedCompanyWithLocalIdentity = Effect.fn('DemoCompany.localOwnedCompany')(function* (
  ownerId: Id<'profiles'> | string
) {
  const convexAuth = yield* externalCall({
    service: 'Convex',
    operation: 'convexAuth.authenticatedClient',
    timeout: DEMO_COMPANY_QUERY_TIMEOUT_MS,
    retries: 0,
    run: () => getAuthenticatedConvex(),
  })
  if (!convexAuth?.client || !convexAuth.isAuthenticated) return null

  return yield* externalCall({
    service: 'Convex',
    operation: 'companies.getCompanyByOwner',
    timeout: DEMO_COMPANY_QUERY_TIMEOUT_MS,
    retries: 0,
    run: () =>
      convexAuth.client.query(api.companies.getCompanyByOwner, {
        ownerId: ownerId as Id<'profiles'>,
      }),
  })
})

const resolveDemoCompanyEffect = Effect.fn('DemoCompany.resolve')(function* (
  ownerId: Id<'profiles'> | string | null | undefined
) {
  // Sin catálogo público en Convex (retirado 2026-09-16), la lista es siempre el fixture.
  const publicCompanies: readonly DemoCompany[] = DEMO_PUBLIC_COMPANIES

  if (IS_LOCAL_CONVEX_BACKEND) {
    if (!HAS_LOCAL_CONVEX_IDENTITY || !ownerId || FIXTURE_PROFILE_IDS.has(ownerId)) {
      return { company: null, isFixture: false }
    }
    const owned = yield* ownedCompanyWithLocalIdentity(ownerId).pipe(
      Effect.catch((error) =>
        Effect.logWarning('[demo-company] Local identity lookup failed', error).pipe(
          Effect.as<Doc<'companies'> | null>(null)
        )
      )
    )
    return { company: owned as DemoCompany | null, isFixture: false }
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? ''
  const shouldUseLocalData =
    !convexUrl || convexUrl.includes('placeholder') || convexUrl.includes('your-project')

  if (!shouldUseLocalData) {
    const lookup = yield* lookupDemoCompanyInConvex(ownerId).pipe(
      Effect.catch((error) =>
        Effect.logWarning('[demo-company] Falling back to local demo company data', error).pipe(
          Effect.as<ConvexDemoLookup | null>(null)
        )
      )
    )

    // La sala sembrada corta aquí: es la que tiene documentos y bytes de verdad.
    if (lookup?.kind === 'seeded-room') {
      return { company: lookup.company, isFixture: false }
    }
  }

  // La empresa del perfil manda sobre cualquier fixture: si el deployment tiene
  // una sala sembrada para este usuario de dev, esa es la sala que se abre.
  // Un perfil de dev puede poseer mas de una empresa (fixtures viejos + la sala
  // sembrada): se abre la mas reciente, que es la que tiene documentos reales.
  const owned: DemoCompany | undefined =
    ownerId === null || ownerId === undefined
      ? undefined
      : publicCompanies
          .filter((company) => company.ownerId === ownerId)
          .sort((left, right) => (right._creationTime ?? 0) - (left._creationTime ?? 0))[0]
  if (owned !== undefined) {
    return { company: owned, isFixture: true }
  }

  if (ownerId === DEMO_COMPANY_PROFILE_ID) {
    return { company: DEMO_PUBLIC_COMPANIES[0] ?? null, isFixture: true }
  }

  const fallback: DemoCompany | null =
    publicCompanies.find(
      (company) =>
        company.name === 'Sample Hydro, S. A.' || company.legalName === 'Sample Hydro, S. A.'
    ) ??
    publicCompanies[0] ??
    null

  return { company: fallback, isFixture: true }
})

export async function resolveDemoCompany(
  ownerId?: Id<'profiles'> | string | null
): Promise<DemoCompanyResolution> {
  return runServerEffect(resolveDemoCompanyEffect(ownerId))
}
