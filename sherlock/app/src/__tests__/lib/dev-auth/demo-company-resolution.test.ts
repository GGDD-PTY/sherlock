import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchQuery = vi.fn()
vi.mock('convex/nextjs', () => ({ fetchQuery: (...args: unknown[]) => fetchQuery(...args) }))
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getCompanyByOwner: 'companies.getCompanyByOwner',
    },
    _demoSeed: { roomForDevCompany: '_demoSeed.roomForDevCompany' },
  },
}))

// El cliente impersonado de `dev:local`. Las pruebas de la nube nunca lo tocan:
// sin admin key la rama ni se abre.
const authenticatedQuery = vi.fn()
const getAuthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => getAuthenticatedConvex(),
}))

const SEEDED = {
  _id: 'k4fbb1a992c04fb6ce03f37800a6c2cb',
  name: 'Sample Hydro, S. A.',
  ownerId: 'profile_dev_company',
  isPublic: true,
}

describe('resolveDemoCompany', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchQuery.mockReset()
    authenticatedQuery.mockReset()
    getAuthenticatedConvex.mockReset()
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://sample-deployment.convex.cloud'
    delete process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
  })

  it('prefers the company the dev profile actually owns in Convex', async () => {
    fetchQuery.mockResolvedValue(SEEDED)
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany('profile_dev_company')

    // La sala sembrada gana sobre el fixture: tiene documentos y bytes de verdad.
    expect(fetchQuery).toHaveBeenCalledWith('_demoSeed.roomForDevCompany', {})
    expect(resolved.company?._id).toBe(SEEDED._id)
    expect(resolved.isFixture).toBe(false)
  })

  it('falls back to the local fixture and says so when Convex has nothing', async () => {
    fetchQuery.mockResolvedValue(null)
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany('profile_sin_empresa')

    expect(resolved.company?.name).toBe('Sample Hydro, S. A.')
    // Sin fila real no hay bytes que pedir, y la sala tiene que saberlo.
    expect(resolved.isFixture).toBe(true)
  })

  it('maps the demo company profile to the seeded room when Convex has it', async () => {
    fetchQuery.mockResolvedValue(SEEDED)
    const { DEMO_COMPANY_PROFILE_ID } = await import('@/lib/dev-auth/demo-data')
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany(DEMO_COMPANY_PROFILE_ID)

    expect(resolved.company?._id).toBe(SEEDED._id)
    expect(resolved.isFixture).toBe(false)
  })

  it('keeps the isolated E2E lane on the local fixture without querying Convex', async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://placeholder.convex.cloud'
    const { DEMO_COMPANY_PROFILE_ID } = await import('@/lib/dev-auth/demo-data')
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany(DEMO_COMPANY_PROFILE_ID)

    expect(fetchQuery).not.toHaveBeenCalled()
    expect(resolved.isFixture).toBe(true)
  })

  // ===== `dev:local`: LA SALA SALE DE LA FILA REAL, NO DEL FIXTURE =====
  // Con admin key local el dueño está impersonado y su empresa se lee
  // autenticada por `getCompanyByOwner`. Sin eso, `_demoSeed.roomForDevCompany`
  // resuelve la sala demo por el dueño sembrado, no por un catálogo público.
  it('reads the owner company with the impersonated client when dev:local is up', async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'http://127.0.0.1:3210'
    process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY = 'anonymous-agent|local-admin-key'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    const OWNED = { _id: 'company_synthetic', name: 'Empresa Sintética 01' }
    authenticatedQuery.mockResolvedValue(OWNED)
    getAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => authenticatedQuery(...args) },
      token: null,
      isAuthenticated: true,
    })
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany('k6c4bc4afdcef689f4f9bb181913258e')

    expect(authenticatedQuery).toHaveBeenCalledWith('companies.getCompanyByOwner', {
      ownerId: 'k6c4bc4afdcef689f4f9bb181913258e',
    })
    expect(fetchQuery).not.toHaveBeenCalled()
    expect(resolved.company?._id).toBe(OWNED._id)
    expect(resolved.isFixture).toBe(false)
  })

  it('never substitutes a fixture profile for a company in a real local backend', async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'http://127.0.0.1:3210'
    process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY = 'anonymous-agent|local-admin-key'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    fetchQuery.mockResolvedValue(SEEDED)
    const { DEMO_COMPANY_PROFILE_ID } = await import('@/lib/dev-auth/demo-data')
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    const resolved = await resolveDemoCompany(DEMO_COMPANY_PROFILE_ID)

    // `demo_company_profile` no es un id de Convex: preguntarle al backend por
    // él es un error de validación, no una respuesta vacía.
    expect(getAuthenticatedConvex).not.toHaveBeenCalled()
    expect(fetchQuery).not.toHaveBeenCalled()
    expect(resolved).toEqual({ company: null, isFixture: false })
  })

  it.each(['empty', 'failed', 'unauthenticated'])(
    'does not fabricate a company when the local owner lookup is %s',
    async (scenario) => {
      process.env.NEXT_PUBLIC_CONVEX_URL = 'http://127.0.0.1:3210'
      process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY = 'anonymous-agent|local-admin-key'
      process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
      if (scenario === 'failed')
        authenticatedQuery.mockRejectedValue(new Error('backend unavailable'))
      else authenticatedQuery.mockResolvedValue(null)
      getAuthenticatedConvex.mockResolvedValue(
        scenario === 'unauthenticated'
          ? null
          : {
              client: { query: (...args: unknown[]) => authenticatedQuery(...args) },
              isAuthenticated: true,
            }
      )
      const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

      expect(await resolveDemoCompany('profile_local_owner')).toEqual({
        company: null,
        isFixture: false,
      })
      expect(fetchQuery).not.toHaveBeenCalled()
    }
  )

  it('keeps an uninitialized local backend empty when the local key is absent', async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'http://127.0.0.1:3210'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    const { resolveDemoCompany } = await import('@/lib/dev-auth/demo-company')

    expect(await resolveDemoCompany()).toEqual({ company: null, isFixture: false })
    expect(getAuthenticatedConvex).not.toHaveBeenCalled()
    expect(fetchQuery).not.toHaveBeenCalled()
  })
})
