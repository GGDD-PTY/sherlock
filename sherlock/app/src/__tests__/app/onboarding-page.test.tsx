import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// ONBOARDING ROUTE — parada de aprovisionamiento por HTTP
// ============================================================================
// /onboarding es un route handler: usa la variante suave (requireWorkosSession)
// y responde 307 antes de streamear HTML. Los dos estados de first-login —
// perfil local ausente, y COMPANY confirmado sin empresa — van a
// /onboarding/provision, la única page del segmento, donde
// <WorkspaceProvisioning /> corre la mutation con la identidad del navegador.
// Una empresa existente continúa en el data room; el contexto faltante vive en
// readiness, no en un wizard. `redirect()` lanza NEXT_REDIRECT (307 + pathname
// localizado) y Next lo vuelve respuesta sin montar React; el mock reproduce
// ese contrato: lanza y no devuelve.
// ============================================================================

const mockRequireWorkosSession = vi.fn()
const mockGetCurrentAuthenticatedUserState = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
const mockConvexQuery = vi.fn()
const mockDevAuth = vi.hoisted(() => ({ enabled: false, local: false }))
const mockDemoCompany = vi.hoisted(() => vi.fn())
const mockRedirect = vi.fn(({ href, locale }: { href: string; locale?: string }) => {
  throw new Error(`REDIRECT:${locale}:${href}`)
})

// next-intl/server real lanza en jsdom ("not supported in Client Components");
// la page de provision llama setRequestLocale(locale) al entrar. Las
// traducciones salen del catálogo real para que la página de servicio no
// disponible se pruebe con su copy, no con claves.
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async ({ namespace }: { namespace: string }) => {
    const messages = (await import('@/messages/es.json')).default as unknown as Record<
      string,
      Record<string, string>
    >
    return (key: string) => messages[namespace]?.[key] ?? key
  },
}))

vi.mock('@/lib/auth/session', () => ({
  requireWorkosSession: (...args: unknown[]) => mockRequireWorkosSession(...args),
}))

vi.mock('@/i18n/navigation', () => ({
  redirect: (...args: [{ href: string; locale?: string }]) => mockRedirect(...args),
}))

vi.mock('@/lib/convex-auth', () => ({
  getCurrentAuthenticatedUserState: (...args: unknown[]) =>
    mockGetCurrentAuthenticatedUserState(...args),
  getAuthenticatedConvex: (...args: unknown[]) => mockGetAuthenticatedConvex(...args),
}))

vi.mock('@/components/onboarding/WorkspaceProvisioning', () => ({
  WorkspaceProvisioning: () => 'WORKSPACE_PROVISIONING',
}))

vi.mock('@/lib/dev-auth/config', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuth.enabled
  },
}))

vi.mock('@/lib/dev-auth/demo-company', () => ({
  getDemoCompanyFromPublicList: (...args: unknown[]) => mockDemoCompany(...args),
}))

vi.mock('@/lib/dev-auth/local-convex-identity', () => ({
  hasLocalConvexIdentity: () => mockDevAuth.local,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: { getCompanyByOwner: 'companies:getCompanyByOwner' },
  },
}))

import * as onboardingRoute from '@/app/[locale]/(app)/onboarding/route'
import ProvisionWorkspacePage from '@/app/[locale]/(app)/onboarding/provision/page'

const { GET } = onboardingRoute
const SEGMENT = join(process.cwd(), 'src/app/[locale]/(app)/onboarding')
const params = Promise.resolve({ locale: 'es' })

function get(search = '') {
  return GET(new NextRequest(`http://localhost/es/onboarding${search}`), { params })
}

const companySession = {
  id: 'user_workos_123',
  email: 'company@example.com',
  name: 'Company User',
  profileId: 'profile_123',
  role: 'COMPANY',
  effectiveRole: 'COMPANY',
  isViewingAs: false,
  viewAsRole: null,
  impersonateUserId: null,
  needsProfile: false,
}

describe('onboarding route (307 antes de streamear)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDevAuth.enabled = false
    mockDevAuth.local = false
    mockDemoCompany.mockReset().mockResolvedValue(null)
    mockGetAuthenticatedConvex.mockResolvedValue({
      isAuthenticated: true,
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
    })
    mockConvexQuery.mockResolvedValue(null)
  })

  it('is a route handler whose only page is the provisioning leaf', () => {
    expect(typeof GET).toBe('function')
    expect('default' in onboardingRoute).toBe(false)
    expect(existsSync(join(SEGMENT, 'route.ts'))).toBe(true)
    expect(existsSync(join(SEGMENT, 'page.tsx'))).toBe(false)
    expect(existsSync(join(SEGMENT, 'loading.tsx'))).toBe(false)
    expect(existsSync(join(SEGMENT, 'provision/page.tsx'))).toBe(true)
  })

  it('carries the intake nonce from first-login onboarding into provisioning', async () => {
    mockRequireWorkosSession.mockResolvedValue({ ...companySession, needsProfile: true })
    await expect(get('?handoff=938c27d4-b16f-4087-b191-4fcb7c348959')).rejects.toThrow(
      'REDIRECT:es:/onboarding/provision?handoff=938c27d4-b16f-4087-b191-4fcb7c348959'
    )
  })

  it('routes a missing profile to the provisioning leaf', async () => {
    mockRequireWorkosSession.mockResolvedValue({
      id: 'user_workos_123',
      email: 'new@example.com',
      name: 'New User',
      profileId: null,
      role: null,
      effectiveRole: null,
      isViewingAs: false,
      viewAsRole: null,
      impersonateUserId: null,
      needsProfile: true,
    })

    await expect(get()).rejects.toThrow('REDIRECT:es:/onboarding/provision')
    expect(mockRequireWorkosSession).toHaveBeenCalledWith('es')
    expect(mockRedirect).toHaveBeenCalledTimes(1)
    expect(mockRedirect).toHaveBeenCalledWith({ href: '/onboarding/provision', locale: 'es' })
    expect(mockGetCurrentAuthenticatedUserState).not.toHaveBeenCalled()
  })

  it('routes a confirmed COMPANY with no company to the provisioning leaf', async () => {
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_123' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: true },
    })
    // getCompanyByOwner devuelve null cuando no hay empresa (no lanza), así que
    // este es el first-login que el aprovisionamiento debe atender.
    mockConvexQuery.mockResolvedValue(null)

    await expect(get()).rejects.toThrow('REDIRECT:es:/onboarding/provision')
    expect(mockConvexQuery).toHaveBeenCalledWith('companies:getCompanyByOwner', {
      ownerId: 'profile_123',
    })
  })

  it('routes a COMPANY whose role is not confirmed to the provisioning leaf', async () => {
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_123' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: false },
    })

    await expect(get()).rejects.toThrow('REDIRECT:es:/onboarding/provision')
    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('falls back to the provisioning leaf when the profile lookup fails', async () => {
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockRejectedValue(new Error('convex down'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(get()).rejects.toThrow('REDIRECT:es:/onboarding/provision')

    consoleError.mockRestore()
  })

  it('routes a COMPANY with incomplete legacy metadata to the data room', async () => {
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_123' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: true },
    })
    // Empresa existente sin onboardingCompletedAt = contexto faltante en readiness.
    mockConvexQuery.mockResolvedValue({
      _id: 'company_123',
      ownerId: 'profile_123',
      onboardingStep: 2,
    })

    await expect(get()).rejects.toThrow('REDIRECT:es:/my-company/documents')
    expect(mockRedirect).toHaveBeenCalledWith({ href: '/my-company/documents', locale: 'es' })
  })

  it('routes ADMIN directly to admin without querying for a company', async () => {
    mockRequireWorkosSession.mockResolvedValue({
      ...companySession,
      role: 'ADMIN',
      effectiveRole: 'ADMIN',
      profileId: 'profile_admin',
    })
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_admin' },
      profile: { _id: 'profile_admin', role: 'ADMIN', roleConfirmed: true },
    })

    await expect(get('?handoff=938c27d4-b16f-4087-b191-4fcb7c348959')).rejects.toThrow(
      'REDIRECT:es:/admin'
    )
    expect(mockRedirect).toHaveBeenCalledWith({ href: '/admin', locale: 'es' })
    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('provisions an empty workspace for an authenticated local dev company with no room', async () => {
    mockDevAuth.enabled = true
    mockDevAuth.local = true
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_local' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: true },
    })
    mockDemoCompany.mockResolvedValue(null)
    await expect(get()).rejects.toThrow('REDIRECT:es:/onboarding/provision')
    expect(mockDemoCompany).toHaveBeenCalledWith('profile_123')
  })

  it('opens an existing local dev room without provisioning another one', async () => {
    mockDevAuth.enabled = true
    mockDevAuth.local = true
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_local' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: true },
    })
    mockDemoCompany.mockResolvedValue({ _id: 'local_company' })
    await expect(get()).rejects.toThrow('REDIRECT:es:/my-company/documents')
  })

  it('routes a dev-auth COMPANY without Convex identity to the fixture data room', async () => {
    mockDevAuth.enabled = true
    mockRequireWorkosSession.mockResolvedValue({
      ...companySession,
      id: 'dev_company',
      email: 'company@dev.local',
      profileId: 'demo_profile_company',
    })
    mockGetCurrentAuthenticatedUserState.mockResolvedValue(null)

    await expect(get()).rejects.toThrow('REDIRECT:es:/my-company/documents')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  // ===== SERVICIO NO DISPONIBLE (A1-01) =====
  // Con sesión WorkOS válida y Convex caído, `requireAuth` manda a
  // `/onboarding?error=profile-fetch-failed`. Antes esta ruta volvía a evaluar la
  // sesión, Convex seguía caído, y se redirigía a sí misma hasta
  // ERR_TOO_MANY_REDIRECTS. Ahora responde 503 sin `location` y sin tocar Convex.
  it('responds 503 without a location when the profile fetch failed, instead of looping', async () => {
    // Convex sigue caído: si la ruta re-evaluara la sesión recibiría este mismo
    // redirect otra vez. Que no lo reciba es lo que cierra el loop.
    mockRequireWorkosSession.mockImplementation((locale: string) =>
      mockRedirect({ href: '/onboarding?error=profile-fetch-failed', locale })
    )

    const response = await get('?error=profile-fetch-failed')

    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBe('60')
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(mockRequireWorkosSession).not.toHaveBeenCalled()
    expect(mockGetCurrentAuthenticatedUserState).not.toHaveBeenCalled()
    expect(mockRedirect).not.toHaveBeenCalled()

    const html = await response.text()
    expect(html).toContain('<html lang="es">')
    expect(html).toContain('No pudimos cargar tu cuenta.')
    expect(html).toContain('Inténtalo de nuevo en un minuto.')
    expect(html).toContain('href="/es/my-company/documents"')
    expect(html).toContain('Volver a intentar')
    expect(html).not.toMatch(/gratis|sin costo|emisor/i)
  })

  it('keeps every other ?error= value on the normal redirect path', async () => {
    mockRequireWorkosSession.mockResolvedValue(companySession)
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_123' },
      profile: { _id: 'profile_123', role: 'COMPANY', roleConfirmed: true },
    })
    mockConvexQuery.mockResolvedValue({ _id: 'company_123', ownerId: 'profile_123' })

    await expect(get('?error=needs-profile')).rejects.toThrow('REDIRECT:es:/my-company/documents')
    expect(mockRequireWorkosSession).toHaveBeenCalledWith('es')
  })

  it('lets the sign-in redirect of an unauthenticated session through untouched', async () => {
    // requireWorkosSession() redirige a /sign-in con el mismo redirect() que el
    // handler: el handler no lo atrapa ni le suma un segundo destino.
    mockRequireWorkosSession.mockImplementation((locale: string) =>
      mockRedirect({ href: '/sign-in', locale })
    )

    await expect(get()).rejects.toThrow('REDIRECT:es:/sign-in')
    expect(mockRedirect).toHaveBeenCalledTimes(1)
    expect(mockRedirect).toHaveBeenCalledWith({ href: '/sign-in', locale: 'es' })
    expect(mockGetCurrentAuthenticatedUserState).not.toHaveBeenCalled()
  })
})

describe('onboarding/provision page (hoja de aprovisionamiento)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDevAuth.enabled = false
    mockDevAuth.local = false
    mockDemoCompany.mockReset().mockResolvedValue(null)
  })

  it('requires a WorkOS session before rendering the provisioning leaf', async () => {
    mockRequireWorkosSession.mockImplementation((locale: string) =>
      mockRedirect({ href: '/sign-in', locale })
    )

    await expect(ProvisionWorkspacePage({ params })).rejects.toThrow('REDIRECT:es:/sign-in')
  })

  it('passes only a valid nonce to the provisioning component', async () => {
    mockRequireWorkosSession.mockResolvedValue({ ...companySession, needsProfile: true })
    const page = await ProvisionWorkspacePage({
      params,
      searchParams: Promise.resolve({ handoff: '938c27d4-b16f-4087-b191-4fcb7c348959' }),
    })
    expect(page.props.handoffNonce).toBe('938c27d4-b16f-4087-b191-4fcb7c348959')
    const invalid = await ProvisionWorkspacePage({
      params,
      searchParams: Promise.resolve({ handoff: 'https://outside.example/' }),
    })
    expect(invalid.props.handoffNonce).toBeNull()
  })

  it('renders WorkspaceProvisioning for a signed-in account without a profile', async () => {
    mockRequireWorkosSession.mockResolvedValue({
      id: 'user_workos_123',
      email: 'new@example.com',
      name: 'New User',
      profileId: null,
      role: null,
      effectiveRole: null,
      isViewingAs: false,
      viewAsRole: null,
      impersonateUserId: null,
      needsProfile: true,
    })

    const element = await ProvisionWorkspacePage({ params })

    expect(mockRequireWorkosSession).toHaveBeenCalledWith('es')
    expect(mockRedirect).not.toHaveBeenCalled()
    // Elemento React <WorkspaceProvisioning />
    expect((element as { type: () => string }).type()).toBe('WORKSPACE_PROVISIONING')
  })
})
