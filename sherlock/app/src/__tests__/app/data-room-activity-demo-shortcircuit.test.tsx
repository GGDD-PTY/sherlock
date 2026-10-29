// ============================================================================
// Actividad del data room — el modo demo no tiene bitácora que mostrar
// ============================================================================
// El modo demo corre contra el store del navegador y no escribe una sola fila en
// `documentAccessLogs`. La ENTRADA a esta pantalla ya se oculta en el data room
// por esa razón (MyCompanyDocumentsClient), pero la URL seguía viva y llevaba a
// un esqueleto que nunca resuelve.
//
// Una pantalla de evidencia no se rellena con datos inventados: se cierra y se
// manda a lo que sí es real. Este archivo va aparte de
// `company-owner-pages-auth.test.tsx` porque ese fija `DEV_AUTH_ENABLED: false`
// para todo su registro de módulos.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireAuth = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
const mockConvexQuery = vi.fn()
const mockGetDemoCompany = vi.fn()
const mockRedirect = vi.fn(({ href }: { href: string }) => {
  throw new Error(`REDIRECT:${href}`)
})

// next-intl/server real lanza en jsdom ("not supported in Client Components");
// las paginas server bajo test llaman setRequestLocale(locale) al entrar.
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async () => (key: string) => key,
}))

vi.mock('@/lib/auth/session', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

vi.mock('@/lib/dev-auth/config', () => ({
  DEV_AUTH_ENABLED: true,
}))

vi.mock('@/lib/dev-auth/demo-company', () => ({
  getDemoCompanyFromPublicList: (...args: unknown[]) => mockGetDemoCompany(...args),
}))

vi.mock('@/i18n/navigation', () => ({
  redirect: (...args: [{ href: string; locale?: string }]) => mockRedirect(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getCompanyByOwner: 'companies.getCompanyByOwner',
    },
  },
}))

vi.mock('@/components/company/data-room-activity/DataRoomActivityClient', () => ({
  DataRoomActivityClient: () => null,
}))

describe('data room activity page in demo mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      id: 'demo_company',
      email: 'company@dev.local',
      effectiveRole: 'COMPANY',
      profileId: 'profile_company_demo',
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
      isAuthenticated: true,
    })
    mockGetDemoCompany.mockResolvedValue({ _id: 'company_demo', name: 'Demo Company' })
  })

  it('devuelve al data room en vez de renderizar una pantalla sin datos', async () => {
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    await expect(
      DataRoomActivityPage({ params: Promise.resolve({ locale: 'es' }) })
    ).rejects.toThrow('REDIRECT:/my-company/documents')
  })

  it('corta antes de resolver empresa: ni Convex ni el store demo se tocan', async () => {
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    await expect(
      DataRoomActivityPage({ params: Promise.resolve({ locale: 'es' }) })
    ).rejects.toThrow('REDIRECT:/my-company/documents')

    expect(mockConvexQuery).not.toHaveBeenCalled()
    expect(mockGetDemoCompany).not.toHaveBeenCalled()
  })

  // [F] 2026-09-01: la bitácora de accesos es superficie de admin. Nadie más
  // llega, y la empresa que teclea la URL vuelve a su sala en vez de encontrar
  // una pantalla forense que no pidió.
  it.each([
    ['ADMIN', 'profile_admin_demo'],
    ['COMPANY', 'profile_company_demo'],
  ])('manda a su sala a %s, que no es admin', async (effectiveRole, profileId) => {
    mockRequireAuth.mockResolvedValue({
      id: 'demo_user',
      email: 'user@dev.local',
      effectiveRole,
      profileId,
    })
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    await expect(
      DataRoomActivityPage({ params: Promise.resolve({ locale: 'es' }) })
    ).rejects.toThrow('REDIRECT:/my-company/documents')
  })
})
