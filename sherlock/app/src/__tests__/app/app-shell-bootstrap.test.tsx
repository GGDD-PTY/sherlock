import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/components/providers/AppShell'
import { WorkspaceProvisioning } from '@/components/onboarding/WorkspaceProvisioning'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => vi.fn()),
}))

vi.mock('@/lib/env', () => ({}))
vi.mock('@/i18n/config', () => ({ locales: ['es'], defaultLocale: 'es' }))
vi.mock('@/lib/site/brand', () => ({
  getPublicAppUrl: () => 'https://sherlock.example',
  // El navbar llega a `safe-redirect` desde la fila de notificaciones del menú
  // compacto, y esa lista de dominios se arma con el host al importar.
  getPublicAppHost: () => 'sherlock.example',
  SITE_BRAND_NAME: 'Sherlock',
}))
vi.mock('@/lib/dev-auth', () => ({
  DEV_AUTH_ENABLED: false,
  useDevAuth: vi.fn(),
}))
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: false }))

vi.mock('next/dynamic', () => ({
  default: (_loader: () => Promise<unknown>, options?: { loading?: () => ReactNode }) =>
    options?.loading ?? (() => null),
}))
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
  useLocale: () => 'es',
  useTranslations: () => (key: string) => key,
}))
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'es',
  getMessages: async () => ({}),
  getTranslations: async () => (key: string) => key,
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/onboarding',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  useAuth: () => ({
    loading: false,
    user: {
      id: 'user_workos_bootstrap',
      email: 'bootstrap@example.com',
      firstName: 'Bootstrap',
      lastName: 'User',
    },
  }),
}))
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: () => mocks.useMutation(),
  // El bootstrap que este test fija es el de "Convex ya aceptó el token": ahí
  // la única query permitida es `getCurrentUserState` con args reales.
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true, isRefreshing: false }),
}))
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    users: { getCurrentUserState: 'users:getCurrentUserState' },
    companies: { ensureCompanyWorkspace: 'companies:ensureCompanyWorkspace' },
  },
}))
vi.mock('@/stores/useViewAsStore', () => ({
  useViewAsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      viewAsRole: null,
      impersonateUserId: null,
      setViewAs: vi.fn(),
      clearViewAs: vi.fn(),
      setImpersonateUser: vi.fn(),
      clearImpersonate: vi.fn(),
    }),
}))
vi.mock('zustand/shallow', () => ({ useShallow: (selector: unknown) => selector }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isSignedIn: false, signOut: vi.fn() }),
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/components/layout/NavbarUtilityMenu', () => ({
  NavbarUtilityMenu: () => <span>account-menu</span>,
}))
vi.mock('@/components/admin/ViewAsSelector', () => ({ ViewAsSelector: () => null }))

vi.mock('@/components/layout/SiteFooter', () => ({ SiteFooter: () => null }))
vi.mock('@/components/layout/ProductFooter', () => ({ ProductFooter: () => null }))
vi.mock('@/components/admin/AdminChrome', () => ({ AdminChrome: () => null }))
vi.mock('@/components/analytics/ConsentBanner', () => ({ ConsentBanner: () => null }))
vi.mock('@/components/providers/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))
vi.mock('@/components/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/providers/ConvexClientProvider', () => ({
  ConvexClientProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/providers/PostHogProvider', () => ({
  PostHogProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))

// El shell salió de `[locale]/layout.tsx` a `AppShell` (tarjeta O2-06). Este
// archivo se llamaba `locale-layout-bootstrap.test.tsx`.
describe('app shell during WorkOS bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useMutation.mockReturnValue(vi.fn())
    mocks.useQuery.mockImplementation((query: unknown, _args: unknown) => {
      if (query === 'users:getCurrentUserState') {
        return { user: null, profile: null }
      }
      throw new Error(`Unexpected query: ${String(query)}`)
    })
  })

  it('renders the complete shell and provisioning stop without querying profile-dependent data', async () => {
    const shell = await AppShell({ children: <WorkspaceProvisioning /> })

    const markup = renderToStaticMarkup(shell)

    // El mock global de next-intl devuelve la clave, así que el contrato se
    // afirma por estructura: la región de estado del aprovisionamiento.
    expect(markup).toContain('data-provisioning="true"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria.mainNavigation')
    // La única query permitida durante el bootstrap es el estado autocontenido
    // del usuario; el shell ya no consulta datos dependientes del profile.
    expect(mocks.useQuery).toHaveBeenCalledWith('users:getCurrentUserState', {})
  })
})
