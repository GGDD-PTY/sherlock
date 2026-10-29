// ============================================================================
// NAVBAR UNIT TESTS
// ============================================================================
// Tests para el componente Navbar
// Verifica navegación, renderizado y estados de autenticación
// Usa WorkOS AuthKit para autenticación
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { Navbar } from '@/components/layout/Navbar'

// ===== MOCK FACTORY TYPES =====
// Define minimal mock versions of User and Profile for testing
interface MockUser {
  id: string
  providerUserId?: string
  workosUserId?: string
  email?: string
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  imageUrl?: string
  convexId?: string
  role?: 'COMPANY' | 'ADMIN'
  isVerified?: boolean
}

interface MockProfile {
  _id?: string
  userId?: string
  role?: 'COMPANY' | 'ADMIN'
  isVerified?: boolean
}

// ===== TYPED MOCK FACTORIES =====
// These factories ensure test mocks stay in sync with real types
// while allowing partial overrides for specific test scenarios

/**
 * Creates a mock User object with sensible defaults
 * @param overrides Partial User properties to override defaults
 * @returns Typed mock User object conforming to CurrentUser shape
 */
function createMockUser(overrides?: Partial<MockUser>): MockUser {
  return {
    id: 'test-user-id',
    providerUserId: 'test-workos-id',
    workosUserId: 'test-workos-id',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    fullName: 'Test User',
    imageUrl: '',
    convexId: 'test-convex-id',
    role: 'COMPANY',
    isVerified: false,
    ...overrides,
  }
}

/**
 * Creates a mock Profile object with sensible defaults
 * @param overrides Partial Profile properties to override defaults
 * @returns Typed mock Profile object
 */
function createMockProfile(overrides?: Partial<MockProfile>): MockProfile {
  return {
    _id: 'test-profile-id',
    userId: 'test-user-id',
    role: 'COMPANY',
    isVerified: false,
    ...overrides,
  }
}

/**
 * Creates a mock useCurrentUser return value with full helper methods
 * @param user Mock user object (uses factory if not provided)
 * @param profile Mock profile object (uses factory if not provided)
 * @param isLoading Loading state
 * @param role Optional role override for hasRole/isAdmin
 * @returns Complete mock useCurrentUser return object
 */
function createMockCurrentUser(
  user?: MockUser | null,
  profile?: MockProfile | null,
  isLoading: boolean = false,
  role?: 'COMPANY' | 'ADMIN'
) {
  const effectiveRole = role ?? user?.role
  const isAdmin = effectiveRole === 'ADMIN'

  return {
    user: user !== undefined ? user : createMockUser(),
    profile: profile !== undefined ? profile : createMockProfile(),
    isLoading,
    // `isAuthLoading` sigue solo a la sesión; `isLoading` además espera el
    // perfil de Convex. Los tests que cubren el esqueleto lo sobreescriben.
    isAuthLoading: false,
    hasRole: (checkRole: string) => {
      // Preserves existing test behavior: checks effectiveRole
      return effectiveRole === checkRole
    },
    isAdmin,
    // Additional fields from useCurrentUser (for future compatibility)
    convexUser: user ? { ...user, _id: user.convexId } : null,
    isSignedIn: user !== null,
    realRole: effectiveRole,
    effectiveRole: effectiveRole,
    isViewingAs: false,
    viewAsRole: null,
    isImpersonating: false,
    impersonateUserId: null,
    setViewAs: vi.fn(),
    clearViewAs: vi.fn(),
    setImpersonateUser: vi.fn(),
    clearImpersonate: vi.fn(),
    hasRealRole: (checkRole: string) => effectiveRole === checkRole,
    needsOnboarding: false,
  }
}

// ===== MOCK NEXT-INTL =====
// Resolves against the real catalog by `${namespace}.${key}`. A missing key
// throws: returning the key path instead would let the suite pin that path as
// an accessible name and freeze the bug into the contract.
vi.mock('next-intl', async () => {
  const catalog = (await import('@/messages/es.json')).default as unknown

  const translate = (path: string): string => {
    const message = path
      .split('.')
      .reduce<unknown>(
        (node, segment) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
        catalog
      )

    if (typeof message !== 'string') {
      throw new Error(`Missing message in src/messages/es.json: ${path}`)
    }

    return message
  }

  return {
    useTranslations: (namespace: string) => (key: string) => translate(`${namespace}.${key}`),
    useLocale: () => 'es',
  }
})

// ===== MOCK NEXT/NAVIGATION =====
const mockRouter = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

// ===== MOCK I18N NAVIGATION =====
let mockPathname = '/my-company/documents'

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: React.ReactNode
    href: string
    prefetch?: boolean | 'auto' | null
    [key: string]: unknown
  }) => (
    <a
      href={href}
      {...props}
      {...(prefetch === false ? { 'data-prefetch': 'false' } : null)}
    >
      {children}
    </a>
  ),
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

// ===== MOCK USE CURRENT USER (configurable) =====
// Using factory-based mock for type safety and future compatibility
let mockCurrentUser = createMockCurrentUser(null, null, false)

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockCurrentUser,
}))

// ===== MOCK USE AUTH (for demo mode) =====
let mockAuthState = {
  isSignedIn: false,
  user: null as { email: string; role: string } | null,
  signOut: vi.fn(),
}

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockAuthState,
}))

// ===== MOCK DEV_AUTH_ENABLED =====
vi.mock('@/lib/dev-auth', () => ({
  DEV_AUTH_ENABLED: false,
}))

function setAuthenticatedNavbarState(role: 'COMPANY' | 'ADMIN' = 'COMPANY') {
  const user = createMockUser({ id: 'test-user-id', role })
  const profile = createMockProfile({ role })
  mockCurrentUser = createMockCurrentUser(user, profile, false, role)
  mockAuthState = {
    isSignedIn: true,
    user: { email: user.email ?? 'test@example.com', role },
    signOut: vi.fn(),
  }
}

// ===== MOCK THEME TOGGLE =====
vi.mock('@/components/ui/theme-toggle', () => ({
  ThemeToggle: ({ showLabel = false }: { showLabel?: boolean }) => (
    <button data-testid="theme-toggle">{showLabel ? 'Tema' : 'Theme'}</button>
  ),
}))

vi.mock('@/components/admin/ViewAsSelector', () => ({
  ViewAsSelector: () => <button data-testid="view-as-selector">Ver como</button>,
}))

vi.mock('@/components/layout/NavbarUtilityMenu', () => ({
  NavbarUtilityMenu: ({ onSignOut }: { onSignOut: () => void }) => (
    <button data-testid="navbar-utility-menu" onClick={onSignOut}>
      Cuenta
    </button>
  ),
}))

// ===== MOCK SHEET COMPONENTS =====
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Mock de NotificationBell para evitar dependencias de Convex en tests de Navbar
vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: ({ showLabel = false }: { showLabel?: boolean }) => (
    <div data-testid="notification-bell">{showLabel ? 'Notificaciones' : 'Bell'}</div>
  ),
}))

// La fila de notificaciones del menú compacto lee el mismo hook que la campana.
// El mock lo deja manejar el caso con avisos y sin avisos sin tocar Convex.
const mockNotifications = vi.hoisted(() => ({ unreadCount: 0 }))

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => mockNotifications,
}))

describe('Navbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset all mocks to default state using factories
    mockCurrentUser = createMockCurrentUser(null, null, false)
    mockAuthState = {
      isSignedIn: false,
      user: null,
      signOut: vi.fn(),
    }
    mockPathname = '/my-company/documents'
    mockNotifications.unreadCount = 0
  })

  // ===== TEST: BADGE DE MENSAJES NO LEÍDOS =====
  it('keeps retired message navigation and unread badges absent', () => {
    setAuthenticatedNavbarState('COMPANY')
    render(<Navbar />)

    expect(screen.queryByRole('link', { name: /mensajes/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/mensajes sin leer/i)).not.toBeInTheDocument()
  })

  // ===== TEST: RENDERIZA LOGO =====
  it('renders the official lockup, never a typed wordmark', () => {
    render(<Navbar />)
    const brandLink = screen.getByRole('link', { name: /inicio de sherlock/i })
    // El lockup del kit es un SVG con el viewBox del archivo oficial; la
    // palabra "Sherlock" no aparece tipeada (BRAND.md §6). El `<title>` del
    // propio SVG sí la lleva desde la tarjeta OB-RES-4: es el nombre accesible
    // del panel móvil, no un wordmark, igual que en `SiteFooter`.
    expect(brandLink.querySelector('svg[viewBox="0 0 4342 934"]')).not.toBeNull()
    const tipeados = screen
      .queryAllByText('Sherlock')
      .filter((node) => node.tagName.toLowerCase() !== 'title')
    expect(tipeados).toHaveLength(0)
  })

  // ===== TEST: LOGO HREF SEGÚN SESIÓN =====
  it('logo links to home when signed out', () => {
    render(<Navbar />)
    const logoLink = screen.getByRole('link', { name: /inicio de sherlock/i })
    expect(logoLink).toHaveAttribute('href', '/')
  })

  // El logotipo lleva a la casa del rol, no a una ruta que solo redirige:
  // `/dashboard` se borró ([F] 2026-09-07 09:00).
  it('logo links to the company room when a company is authenticated', async () => {
    setAuthenticatedNavbarState('COMPANY')
    render(<Navbar />)
    await waitFor(() => {
      const logoLink = screen.getByRole('link', { name: /inicio de sherlock/i })
      expect(logoLink).toHaveAttribute('href', '/my-company/documents')
    })
  })

  it('logo links to the team panel when an admin is authenticated', async () => {
    setAuthenticatedNavbarState('ADMIN')
    render(<Navbar />)
    await waitFor(() => {
      const logoLink = screen.getByRole('link', { name: /inicio de sherlock/i })
      expect(logoLink).toHaveAttribute('href', '/admin')
    })
  })

  // INVESTOR está dormante: no tiene sala, así que el logotipo lo deja en el
  // home público en vez de mandarlo a un destino que no existe.
  // ===== TEST: LA SALA PROPIA SE NOMBRA POR SU DESTINO =====
  // [F] 2026-09-07 09:00: «Data Room» lleva a la sala de la empresa y «Panel»
  // al panel del equipo; «Cuenta» es el menú de la persona (configuración,
  // tema, cerrar sesión). Desde cualquier lugar se vuelve al inicio por el logo
  // y a la sala por su nombre.
  function isAdminHref(href: string | null): boolean {
    return href === '/admin' || (href?.startsWith('/admin/') ?? false)
  }

  // Cada Link de /admin en el viewport dispara getCurrentUserState en el
  // proxy. El clic sigue navegando; el prefetch no.
  it.each(['/my-company/documents', '/intake'] as const)(
    'does not prefetch admin links from %s',
    async (pathname) => {
      mockPathname = pathname
      setAuthenticatedNavbarState('ADMIN')
      render(<Navbar />)

      await waitFor(() => {
        const links = screen.getAllByRole('link')
        const adminLinks = links.filter((link) => isAdminHref(link.getAttribute('href')))
        expect(adminLinks.length).toBeGreaterThan(0)
        for (const link of adminLinks) {
          expect(link).toHaveAttribute('data-prefetch', 'false')
        }
        for (const link of links) {
          if (isAdminHref(link.getAttribute('href'))) continue
          expect(link).not.toHaveAttribute('data-prefetch')
        }
      })
    }
  )

  it('sends the team to the admin room from inside the app shell', async () => {
    setAuthenticatedNavbarState('ADMIN')
    render(<Navbar />)
    await waitFor(() => {
      const roomLinks = screen.getAllByRole('link', { name: 'Panel' })
      expect(roomLinks.length).toBeGreaterThan(0)
      for (const link of roomLinks) {
        expect(link).toHaveAttribute('href', '/admin')
      }
    })
    // `/dashboard` solo redirigía a `/admin`: era una segunda etiqueta del
    // mismo destino.
    expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cuenta' })).not.toBeInTheDocument()
  })

  it('sends the company to its own room from inside the app shell', async () => {
    setAuthenticatedNavbarState('COMPANY')
    render(<Navbar />)
    await waitFor(() => {
      const roomLinks = screen.getAllByRole('link', { name: 'Data Room' })
      expect(roomLinks.length).toBeGreaterThan(0)
      for (const link of roomLinks) {
        expect(link).toHaveAttribute('href', '/my-company/documents')
      }
    })
    expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cuenta' })).not.toBeInTheDocument()
    // La puerta pública /data-room no compite con la sala propia una vez dentro.
    expect(document.querySelector('a[href="/data-room"]')).not.toBeInTheDocument()
  })

  it('sends the company to its own room from the marketing header', async () => {
    // O2-06: la landing pública ya no pasa por esta barra. El cromo con
    // sesión sigue en `/intake` y `/vdr-guest`.
    mockPathname = '/intake'
    setAuthenticatedNavbarState('COMPANY')
    render(<Navbar />)
    await waitFor(() => {
      const roomLinks = screen.getAllByRole('link', { name: 'Data Room' })
      expect(roomLinks.length).toBeGreaterThan(0)
      for (const link of roomLinks) {
        expect(link).toHaveAttribute('href', '/my-company/documents')
      }
    })
    expect(document.querySelector('a[href="/data-room"]')).not.toBeInTheDocument()
  })

  it('sends the team to the admin room from the marketing header', async () => {
    mockPathname = '/intake'
    setAuthenticatedNavbarState('ADMIN')
    render(<Navbar />)
    await waitFor(() => {
      const roomLinks = screen.getAllByRole('link', { name: 'Panel' })
      expect(roomLinks.length).toBeGreaterThan(0)
      for (const link of roomLinks) {
        expect(link).toHaveAttribute('href', '/admin')
      }
    })
  })

  // Invierte lo que fijaba 4daf5d2f. Con la sesión resuelta y el perfil de Convex
  // todavía en vuelo no hay sala que nombrar, y el fallback pintaba «Cuenta»
  // apuntando a `/`, la página en la que ya estabas. Un segundo después se
  // corregía a «Data Room». [F] vio el salto en prod y lo reportó como bug
  // (2026-09-08 18:10). El esqueleto se queda hasta que llega el rol.
  it('holds the skeleton while the Convex profile is still in flight', () => {
    mockPathname = '/intake'
    mockCurrentUser = {
      ...createMockCurrentUser(createMockUser({ role: undefined }), null, true),
      isAuthLoading: false,
      effectiveRole: undefined,
      realRole: undefined,
      isAdmin: false,
      hasRole: () => false,
    }

    render(<Navbar />)

    expect(screen.getByTestId('navbar-skeleton')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cuenta' })).not.toBeInTheDocument()
  })

  // El otro lado del mismo candado: con el rol ya resuelto el botón nombra la
  // sala de una vez, sin pasar por «Cuenta».
  it('names the room directly once the role lands, never Cuenta first', () => {
    mockPathname = '/intake'
    mockCurrentUser = {
      ...createMockCurrentUser(createMockUser({ role: 'COMPANY' }), undefined, false, 'COMPANY'),
      isAuthLoading: false,
    }

    render(<Navbar />)

    expect(screen.queryByTestId('navbar-skeleton')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cuenta' })).not.toBeInTheDocument()
    for (const link of screen.getAllByRole('link', { name: 'Data Room' })) {
      expect(link).toHaveAttribute('href', '/my-company/documents')
    }
  })

  it('holds the marketing account control behind the session skeleton', () => {
    mockPathname = '/intake'
    mockCurrentUser = {
      ...createMockCurrentUser(null, null, true),
      isAuthLoading: true,
    }

    render(<Navbar />)

    expect(screen.getByTestId('navbar-skeleton')).toBeInTheDocument()
  })

  it('does not show dashboard link when signed out', () => {
    render(<Navbar />)
    expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument()
  })

  // ===== TEST: RENDERIZA LINKS DE NAVEGACIÓN =====
  it('renders navigation links', () => {
    render(<Navbar />)

    for (const label of [/data room/i]) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0)
    }
    expect(screen.queryByRole('link', { name: /cómo funciona/i })).not.toBeInTheDocument()
    for (const label of [/oportunidades/i, /empresas/i, /red de capital/i]) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument()
    }
  })

  it('shows the public Data Room destination on its own row before authentication', () => {
    render(<Navbar />)

    const brandCluster = screen.getByTestId('navbar-brand-cluster')
    const desktopPrimaryNavigation = screen.getByTestId('desktop-primary-navigation')

    // The marketplace routes no longer exist; only the Data Room gateway stays
    // public and gets a dedicated row below the brand/auth cluster at xl.
    expect(brandCluster).not.toContainElement(desktopPrimaryNavigation)
    expect(desktopPrimaryNavigation).toHaveClass('hidden', 'xl:flex')
    // El visitante lee lo que abre el enlace: la capa de subida, no una sala
    // ([F] 2026-09-11). Con sesión el rótulo «Data Room» lleva a la sala propia.
    expect(
      within(desktopPrimaryNavigation).getByRole('link', { name: 'Empieza tu Data Room' })
    ).toHaveAttribute('href', '/#intake')
    expect(
      within(desktopPrimaryNavigation).queryByRole('link', { name: /cómo funciona/i })
    ).not.toBeInTheDocument()
    for (const label of [/oportunidades/i, /empresas/i, /red de capital/i]) {
      expect(
        within(desktopPrimaryNavigation).queryByRole('link', { name: label })
      ).not.toBeInTheDocument()
    }
  })

  // ===== TEST: MUESTRA BOTONES DE AUTH CUANDO NO HAY USUARIO =====
  it('shows login/signup buttons when not authenticated', async () => {
    render(<Navbar />)

    // Multiple links may exist (mobile + desktop)
    await waitFor(() => {
      const signInLinks = screen.getAllByRole('link', {
        name: /iniciar sesión/i,
      })
      expect(signInLinks.length).toBeGreaterThan(0)

      const signUpLinks = screen.getAllByRole('link', {
        name: /empieza tu data room/i,
      })
      expect(signUpLinks.length).toBeGreaterThan(0)

      // La puerta de auth es un ancla nativa con el locale a mano: termina
      // fuera del origen (WorkOS) y una navegación de cliente pediría un
      // payload RSC que no existe.
      for (const link of signInLinks) {
        expect(link).toHaveAttribute('href', '/es/sign-in')
        expect(link).not.toHaveAttribute('data-prefetch')
      }

      for (const link of signUpLinks) {
        expect(link).toHaveAttribute('href', '/#intake')
      }
    })
  })

  it('keeps the Data Room gateway visible and marketplace routes out of anonymous navigation', () => {
    render(<Navbar />)

    expect(screen.getAllByTestId('theme-toggle').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('global-search')).not.toBeInTheDocument()
    // The marketplace URLs are gone from the app (they 404 like any unknown
    // route), so the navigation must not offer them.
    for (const label of [/data room/i]) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0)
    }
    expect(screen.queryByRole('link', { name: /cómo funciona/i })).not.toBeInTheDocument()
    for (const label of [/oportunidades/i, /empresas/i, /red de capital/i]) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.getAllByRole('link', { name: /iniciar sesión/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: /empieza tu data room/i }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Abrir menú' })).toBeInTheDocument()
  })

  it('keeps authenticated controls when an authenticated user opens a direct URL', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    await waitFor(() => {
      expect(screen.queryByTestId('global-search')).not.toBeInTheDocument()
      expect(screen.getAllByRole('link', { name: 'Data Room' }).length).toBeGreaterThan(0)
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
      expect(screen.queryByRole('link', { name: /iniciar sesión/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /empieza tu data room/i })).not.toBeInTheDocument()
    })
  })

  // ===== TEST: MUESTRA MENÚ DE USUARIO CUANDO ESTÁ AUTENTICADO =====
  it('shows user controls when authenticated', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    await waitFor(() => {
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    })
  })

  // ===== TEST: LINK CORRECTO A DATA ROOM =====
  it('has correct href for Data Room link', () => {
    render(<Navbar />)

    // Multiple links exist (mobile + desktop), check that at least one has correct href
    const dataRoomLinks = screen.getAllByRole('link', {
      name: /data room/i,
    })
    expect(dataRoomLinks[0]).toHaveAttribute('href', '/#intake')
  })

  // ===== TEST: ACCESIBILIDAD - NAVIGATION ROLE =====
  it('has navigation role for accessibility', () => {
    render(<Navbar />)

    // El navbar debería tener role="navigation"
    expect(screen.getByRole('navigation')).toBeInTheDocument()
  })

  // ===== TEST: NO MUESTRA BOTONES DE AUTH CUANDO ESTÁ AUTENTICADO =====
  it('hides login/signup buttons when authenticated', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    // Los botones de login/signup no deberían estar visibles
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /iniciar sesión/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /empieza tu data room/i })).not.toBeInTheDocument()
    })
  })

  // ===== TEST: RETURNS NULL FOR AUTH PAGES =====
  it('returns null when on sign-in page', () => {
    mockPathname = '/sign-in'
    const { container } = render(<Navbar />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when on sign-up page', () => {
    mockPathname = '/sign-up'
    const { container } = render(<Navbar />)
    expect(container.firstChild).toBeNull()
  })

  // ===== TEST: ROLE-BASED MENU ITEMS =====
  it('shows the live company shell destinations for COMPANY role', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    // The company shell is intentionally bounded to the preparation spine, and
    // its room is the single named destination, «Data Room»: `/dashboard`
    // only ever redirected back to it ([F] 2026-08-30, [F] 2026-09-01, [F]
    // 2026-09-07).
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: 'Data Room' })[0]).toHaveAttribute(
        'href',
        '/my-company/documents'
      )
      const desktopNavigation = screen.getByTestId('desktop-secondary-navigation')
      expect(within(desktopNavigation).queryByText('Dashboard')).not.toBeInTheDocument()
      expect(document.querySelector('a[href="/my-company/profile"]')).not.toBeInTheDocument()
      expect(document.querySelector('a[href="/my-company/edit"]')).not.toBeInTheDocument()
      expect(document.querySelector('a[href="/my-investor/profile"]')).not.toBeInTheDocument()
    })

    // ===== ADDITIONAL CHECK: WorkOS-owned account controls should be visible =====
    await waitFor(() => {
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    })
  })

  it('keeps the dormant investor role off investor-specific destinations', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    expect(screen.queryByRole('link', { name: /Mi Perfil/i })).not.toBeInTheDocument()
    expect(document.querySelector('a[href="/my-investor/profile"]')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    })
  })

  it('names the admin room Panel and keeps no second label for it', async () => {
    setAuthenticatedNavbarState('ADMIN')

    render(<Navbar />)

    // «Panel de Admin» y «Dashboard» apuntaban al mismo `/admin`, que ahora se
    // llama «Panel» ([F] 2026-09-01, [F] 2026-09-07): una etiqueta por destino.
    await waitFor(() => {
      const adminRoomLink = screen.getAllByRole('link', { name: 'Panel' })[0]
      expect(adminRoomLink).toBeInTheDocument()
      expect(adminRoomLink).toHaveAttribute('href', '/admin')
    })
    expect(screen.queryByRole('link', { name: /Panel de Admin/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cuenta' })).not.toBeInTheDocument()

    // ===== ADDITIONAL CHECK: WorkOS-owned account controls should be visible =====
    await waitFor(() => {
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    })
  })

  // ===== TEST: UTILITY COMPONENTS RENDER =====
  it('does not render retired catalog search', () => {
    render(<Navbar />)
    expect(screen.queryByTestId('global-search')).not.toBeInTheDocument()
  })

  it('uses compact public navigation on the intake handoff page', () => {
    mockPathname = '/intake'

    render(<Navbar />)

    // «Cómo funciona» salió de la navegación con la landing mínima
    // ([F] 2026-09-14); en /intake quedan solo la ancla de subida y Ayuda.
    expect(screen.queryByRole('link', { name: 'Cómo funciona' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Membresías' })).not.toBeInTheDocument()
    // El roadmap dejó de ser una entrada propia: vive dentro de /ayuda.
    expect(screen.queryByRole('link', { name: 'Roadmap' })).not.toBeInTheDocument()
    for (const link of screen.getAllByRole('link', { name: 'Empieza tu Data Room' })) {
      expect(link).toHaveAttribute('href', '/#intake')
    }
    expect(screen.queryByRole('link', { name: 'Oportunidades' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('global-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument()
  })

  it('names the public theme, language, and support controls', () => {
    mockPathname = '/intake'

    render(<Navbar />)

    const desktopNavigation = screen.getByTestId('landing-primary-navigation')
    expect(within(desktopNavigation).getByRole('link', { name: 'Ayuda' })).toHaveAttribute(
      'href',
      '/ayuda'
    )
    expect(
      screen.getAllByTestId('theme-toggle').every((control) => control.textContent === 'Tema')
    ).toBe(true)

    // [F] 2026-08-30: copy de cliente sin términos vetados ni features
    // inexistentes. El badge «MCP no disponible todavía» anunciaba en cada
    // página un conector que no existe.
    expect(screen.queryByText(/MCP/)).not.toBeInTheDocument()
  })

  it('keeps product utilities out of the authenticated landing header', () => {
    mockPathname = '/intake'
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    // [F] 2026-08-30 03:44: data room del cliente = 3 bloques. «Ir al
    // dashboard» era una etiqueta de más para el mismo destino: el logo ya
    // lleva a la sala.
    expect(screen.queryByRole('link', { name: 'Ir al dashboard' })).not.toBeInTheDocument()
    const roomLinks = screen.getAllByRole('link', { name: 'Data Room' })
    expect(roomLinks.length).toBeGreaterThan(0)
    for (const link of roomLinks) {
      expect(link).toHaveAttribute('href', '/my-company/documents')
    }
    expect(screen.queryByRole('link', { name: 'Membresías' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('global-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument()
  })

  it('renders theme toggle', () => {
    render(<Navbar />)
    expect(screen.getAllByTestId('theme-toggle').length).toBeGreaterThan(0)
  })

  // [F] 2026-09-03: el sitio y su catálogo existen solo en español, así que
  // ninguna barra puede volver a ofrecer un selector sin una decisión nueva.
  it('offers no language switcher anywhere in the navigation', () => {
    render(<Navbar />)
    expect(screen.queryByTestId('language-switcher')).not.toBeInTheDocument()
  })

  it('offers no language switcher once signed in either', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    expect(screen.queryByTestId('language-switcher')).not.toBeInTheDocument()
  })

  it('renders notification bell when authenticated', async () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    await waitFor(() => {
      expect(screen.getByTestId('notification-bell')).toBeInTheDocument()
    })
  })

  it('keeps the compact navigation trigger available at tablet width', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactMenuTrigger = screen.getByRole('button', { name: /abrir menú/i })
    expect(compactMenuTrigger).toHaveClass('xl:hidden')
    expect(compactMenuTrigger).toHaveTextContent('Abrir menú')
  })

  // [F] 2026-09-17: arregla los hallazgos del E2E. La barra autenticada
  // recupera el control directo de tema (solo icono) y «Cuenta» conserva el
  // nombrado.
  it('keeps a direct theme control in the authenticated bar and the named one in the compact menu', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactNavigation = screen.getByTestId('sheet-content')
    expect(within(compactNavigation).getByTestId('theme-toggle')).toHaveTextContent('Tema')

    const desktopControls = screen.getByTestId('navbar-desktop-controls')
    expect(within(desktopControls).getByTestId('theme-toggle')).toHaveTextContent('Theme')
  })

  it('keeps a single room destination in the compact menu once signed in', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactNavigation = screen.getByTestId('sheet-content')
    const roomLinks = within(compactNavigation).getAllByRole('link', { name: 'Data Room' })
    expect(roomLinks).toHaveLength(1)
    expect(roomLinks[0]).toHaveAttribute('href', '/my-company/documents')
  })

  // La campana solo vive en `desktop-secondary-navigation`, oculto bajo xl: sin
  // esta fila el teléfono no tenía por dónde llegar a los avisos.
  it('reaches Notificaciones from the compact menu once signed in', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactNavigation = screen.getByTestId('sheet-content')
    expect(within(compactNavigation).getByRole('link', { name: 'Notificaciones' })).toHaveAttribute(
      'href',
      '/notifications'
    )
    // Es un destino, no una acción de cuenta.
    expect(
      within(screen.getByTestId('compact-account-group')).queryByRole('link', {
        name: 'Notificaciones',
      })
    ).not.toBeInTheDocument()
  })

  it('carries the unread count into the compact notifications row', () => {
    mockNotifications.unreadCount = 3
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const notificationsRow = screen.getByTestId('compact-notifications-link')
    expect(within(notificationsRow).getByTestId('compact-notifications-unread')).toHaveTextContent(
      '3'
    )
    expect(notificationsRow).toHaveAttribute(
      'aria-label',
      expect.stringContaining('sin leer') as unknown as string
    )
  })

  // El mismo corte de la campana (tarjeta O2-02): el menú compacto decía «9+»
  // desde el décimo aviso y la campana ya contaba hasta 99.
  it.each([
    [42, '42'],
    [100, '99+'],
  ])('cuts the compact unread badge at 99+ (%i)', (unread, label) => {
    mockNotifications.unreadCount = unread
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const notificationsRow = screen.getByTestId('compact-notifications-link')
    expect(within(notificationsRow).getByTestId('compact-notifications-unread')).toHaveTextContent(
      label
    )
  })

  it('leaves the compact notifications row without a badge when nothing is unread', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const notificationsRow = screen.getByTestId('compact-notifications-link')
    expect(
      within(notificationsRow).queryByTestId('compact-notifications-unread')
    ).not.toBeInTheDocument()
    expect(notificationsRow).toHaveAccessibleName('Notificaciones')
  })

  // El menú compacto refleja la barra ancha ([F] 2026-09-07 09:00): la sala y
  // Ayuda como destinos, y «Cuenta» agrupando configuración, tema y cerrar
  // sesión igual que el menú desplegable.
  it('reaches Configuración from the compact account navigation', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactNavigation = screen.getByTestId('sheet-content')
    expect(within(compactNavigation).getByRole('link', { name: 'Configuración' })).toHaveAttribute(
      'href',
      '/settings'
    )
  })

  it('groups Configuración, Tema and Cerrar sesión under Cuenta in the compact menu', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const accountGroup = within(screen.getByTestId('compact-account-group'))
    expect(accountGroup.getByText('Cuenta')).toBeInTheDocument()
    expect(accountGroup.getByRole('link', { name: 'Configuración' })).toHaveAttribute(
      'href',
      '/settings'
    )
    expect(accountGroup.getByTestId('theme-toggle')).toHaveTextContent('Tema')
    expect(accountGroup.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    // La sala y Ayuda son destinos, no acciones de cuenta.
    expect(accountGroup.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument()
    expect(accountGroup.queryByRole('link', { name: 'Ayuda' })).not.toBeInTheDocument()
  })

  it('keeps a named sign-out action in the compact navigation menu', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const compactNavigation = screen.getByTestId('sheet-content')
    expect(
      within(compactNavigation).getByRole('button', { name: 'Cerrar sesión' })
    ).toBeInTheDocument()
  })

  it('defers expanded authenticated controls until the wide layout', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    expect(screen.getByTestId('notification-bell').parentElement).toHaveClass('hidden', 'xl:flex')
  })

  it('shows words alongside every authenticated desktop navigation icon', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const desktopNavigation = screen.getByTestId('desktop-secondary-navigation')

    const visibleLabel = within(desktopNavigation).getByText('Data Room')
    expect(visibleLabel).not.toHaveClass('sr-only')
    // «Dashboard» iba al mismo destino que la sala ([F] 2026-08-30).
    expect(within(desktopNavigation).queryByText('Dashboard')).not.toBeInTheDocument()
    expect(within(desktopNavigation).queryByText('Conexiones')).not.toBeInTheDocument()
    expect(within(desktopNavigation).queryByText('Mensajes')).not.toBeInTheDocument()
  })

  // «Ayuda» tiene que estar a un clic desde la sala, no solo desde la landing:
  // el cliente le escribe al equipo desde ahí ([F] 2026-09-01).
  it.each(['COMPANY', 'ADMIN'] as const)(
    'keeps the help hub one click away inside the %s room',
    (role) => {
      setAuthenticatedNavbarState(role)

      render(<Navbar />)

      const desktopNavigation = screen.getByTestId('desktop-secondary-navigation')
      expect(within(desktopNavigation).getByRole('link', { name: 'Ayuda' })).toHaveAttribute(
        'href',
        '/ayuda'
      )
    }
  )

  it('names every authenticated desktop utility and groups the account actions under Cuenta', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const desktopControls = screen.getByTestId('navbar-desktop-controls')
    expect(within(desktopControls).getByText('Data Room')).toBeInTheDocument()
    expect(within(desktopControls).getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    expect(within(desktopControls).queryByText('Preferencias')).not.toBeInTheDocument()

    // Product decision: authenticated wayfinding stays in the main row. Users
    // must not scan a second banner to learn where each control goes.
    const desktopNavigation = screen.getByTestId('desktop-secondary-navigation')
    expect(desktopControls).toContainElement(desktopNavigation)
    expect(within(desktopNavigation).getByText('Notificaciones')).toBeInTheDocument()
  })

  it('keeps no authenticated primary marketplace entry beside the brand after the pivot', () => {
    setAuthenticatedNavbarState('COMPANY')

    render(<Navbar />)

    const brandCluster = screen.getByTestId('navbar-brand-cluster')
    expect(within(brandCluster).queryByTestId('desktop-primary-navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /oportunidades/i })).not.toBeInTheDocument()
  })

  it('keeps the admin view-as control in the compact navigation sheet', () => {
    setAuthenticatedNavbarState('ADMIN')

    render(<Navbar />)

    expect(screen.getByTestId('sheet-content')).toContainElement(
      screen.getByTestId('view-as-selector')
    )
  })

  // ===== TEST: NAVEGACIÓN PÚBLICA = ANCLAS DE LA LANDING =====
  // Los dos items públicos viven en la landing («Data Room» abre la capa de
  // subida, «Cómo funciona» su sección): `/data-room` era una página que solo
  // redirigía y se borró ([F] 2026-09-07 09:00). Un ancla nunca es la ruta
  // actual, así que ninguno reclama aria-current desde otra página.
  it('keeps the public navigation on landing anchors, never claiming the current route', () => {
    mockPathname = '/messages'
    render(<Navbar />)

    const dataRoomLinks = screen.getAllByRole('link', { name: /data room/i })
    expect(dataRoomLinks.length).toBeGreaterThan(0)
    for (const link of dataRoomLinks) {
      expect(link).toHaveAttribute('href', '/#intake')
      expect(link).not.toHaveAttribute('aria-current')
    }
  })

  // ===== TEST: LOADING STATE =====
  it('shows loading skeleton when isLoading is true', () => {
    // Set loading state using factory
    mockCurrentUser = createMockCurrentUser(null, null, true)

    render(<Navbar />)

    const skeleton = screen.getByTestId('navbar-skeleton')
    expect(skeleton).toBeInTheDocument()
    expect(skeleton).toHaveAttribute('aria-label', 'Menú de usuario')
    expect(skeleton).toHaveAttribute('role', 'status')
    const bars = skeleton.querySelectorAll('[class*="h-8"]')
    expect(bars).toHaveLength(4)
    expect(bars[0]).toHaveClass('w-24')
    expect(bars[1]).toHaveClass('w-12')
    expect(bars[2]).toHaveClass('w-9')
    expect(bars[3]).toHaveClass('w-16')
    expect(skeleton.querySelector('[class*="rounded-full"]')).not.toBeInTheDocument()
  })

  it('does not cause layout shift when loading completes', async () => {
    // Start with loading state using factory
    mockCurrentUser = createMockCurrentUser(null, null, true)

    const { rerender } = render(<Navbar />)

    // Get navbar element
    const navbar = screen.getByRole('navigation')
    const initialHeight = navbar.getBoundingClientRect().height

    // Verify skeleton is present
    expect(screen.getByTestId('navbar-skeleton')).toBeInTheDocument()

    // Simulate data load completion
    setAuthenticatedNavbarState('COMPANY')

    // Re-render with new state
    rerender(<Navbar />)

    // Wait for skeleton to be removed and account controls to appear
    await waitFor(() => {
      expect(screen.queryByTestId('navbar-skeleton')).not.toBeInTheDocument()
      expect(screen.getByTestId('navbar-utility-menu')).toHaveTextContent('Cuenta')
    })

    // Height should remain consistent (no layout shift)
    const finalHeight = navbar.getBoundingClientRect().height
    expect(finalHeight).toBe(initialHeight)
  })
})
