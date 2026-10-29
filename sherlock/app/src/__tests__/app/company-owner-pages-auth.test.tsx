import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockRequireAuth = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
const mockConvexQuery = vi.fn()
const mockDocumentsClient = vi.hoisted(() => vi.fn((_props: unknown) => null))
const mockActivityClient = vi.hoisted(() => vi.fn((_props: unknown) => null))
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
  DEV_AUTH_ENABLED: false,
}))

const mockRefresh = vi.fn()
vi.mock('@/i18n/navigation', () => ({
  redirect: (...args: [{ href: string; locale?: string }]) => mockRedirect(...args),
  useRouter: () => ({ refresh: mockRefresh }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

const mockFetchQuery = vi.fn((..._args: unknown[]) => {
  throw new Error('fetchQuery must not be used for protected company owner queries')
})
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getCompanyByOwner: 'companies.getCompanyByOwner',
      getCompany: 'companies.getCompany',
      getMyVdrWorkspace: 'companies.getMyVdrWorkspace',
    },
    documents: {
      getByCompany: 'documents.getByCompany',
    },
  },
}))

vi.mock('@/components/company/MyCompanyDocumentsClient', () => ({
  MyCompanyDocumentsClient: (props: unknown) => mockDocumentsClient(props),
}))

vi.mock('@/components/company/data-room-activity/DataRoomActivityClient', () => ({
  DataRoomActivityClient: (props: unknown) => mockActivityClient(props),
}))

vi.mock('@/lib/dev-auth/demo-company', () => ({
  getDemoCompanyFromPublicList: vi.fn(),
}))

function createCompanyUser() {
  return {
    id: 'clerk_company_123',
    email: 'company@example.com',
    effectiveRole: 'COMPANY',
    profileId: 'profile_company_123',
  }
}

function createCompany() {
  return {
    _id: 'company_123',
    name: 'Company LATAM',
  }
}

describe('company owner pages Convex auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue(createCompanyUser())
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
      isAuthenticated: true,
    })
    mockConvexQuery.mockImplementation(async (query: unknown) => {
      if (query === 'companies.getMyVdrWorkspace') {
        return { access: 'MANAGE', company: createCompany(), rooms: [] }
      }
      if (query === 'documents.getByCompany') {
        return [{ _id: 'document_1', name: 'Modelo financiero.xlsx', folder: 'room_financial' }]
      }
      return createCompany()
    })
  })

  it('carries the documents intake nonce into the auth gate and bootstrap redirect', async () => {
    mockConvexQuery.mockResolvedValue(null)
    const { default: page } = await import('@/app/[locale]/(app)/my-company/documents/page')
    await expect(
      page({
        params: Promise.resolve({ locale: 'es' }),
        searchParams: Promise.resolve({ handoff: '938c27d4-b16f-4087-b191-4fcb7c348959' }),
      })
    ).rejects.toThrow('REDIRECT:/onboarding?handoff=938c27d4-b16f-4087-b191-4fcb7c348959')
    expect(mockRequireAuth).toHaveBeenCalledWith(
      '/my-company/documents?handoff=938c27d4-b16f-4087-b191-4fcb7c348959',
      'es'
    )
  })

  it('drops duplicate intake nonces before the auth gate', async () => {
    const { default: page } = await import('@/app/[locale]/(app)/my-company/documents/page')
    await page({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({
        handoff: ['938c27d4-b16f-4087-b191-4fcb7c348959', '938c27d4-b16f-4087-b191-4fcb7c348959'],
      }),
    })
    expect(mockRequireAuth).toHaveBeenCalledWith('/my-company/documents', 'es')
  })

  // La lista de la sala corporativa viaja en el HTML para que la sala pinte con
  // documentos desde el primer render, por el mismo cliente autenticado que
  // resuelve el workspace (nunca `fetchQuery`).
  it('resolves the corporate room list on the server and hands it to the workspace', async () => {
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    const result = (await MyCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es' }),
    })) as { props: Record<string, unknown> }

    expect(mockConvexQuery).toHaveBeenCalledWith('documents.getByCompany', {
      companyId: 'company_123',
    })
    expect(mockFetchQuery).not.toHaveBeenCalled()
    expect(result.props.initialDocuments).toEqual([
      { _id: 'document_1', name: 'Modelo financiero.xlsx', folder: 'room_financial' },
    ])
  })

  it('still mounts the workspace when the initial room list fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockConvexQuery.mockImplementation(async (query: unknown) => {
      if (query === 'companies.getMyVdrWorkspace') {
        return { access: 'MANAGE', company: createCompany(), rooms: [] }
      }
      throw new Error('documents unavailable')
    })
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    const result = (await MyCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es' }),
    })) as { props: Record<string, unknown> }

    expect(result.props).toEqual(
      expect.objectContaining({ companyId: 'company_123', initialDocuments: null })
    )
    errorSpy.mockRestore()
  })

  it('loads company documents page owner data with authenticated Convex client', async () => {
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    await MyCompanyDocumentsPage({ params: Promise.resolve({ locale: 'es' }) })

    expect(mockConvexQuery).toHaveBeenCalledWith('companies.getMyVdrWorkspace', {})
    expect(mockConvexQuery).not.toHaveBeenCalledWith(
      'companies.getCompanyByOwner',
      expect.anything()
    )
    expect(mockConvexQuery).not.toHaveBeenCalledWith('deals.getDealsByCompany', expect.anything())
    expect(mockFetchQuery).not.toHaveBeenCalled()
  })

  it('sends a company owner without a workspace to onboarding instead of mounting the retry client', async () => {
    mockConvexQuery.mockResolvedValue(null)
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    await expect(
      MyCompanyDocumentsPage({ params: Promise.resolve({ locale: 'es' }) })
    ).rejects.toThrow('REDIRECT:/onboarding')
    expect(mockDocumentsClient).not.toHaveBeenCalled()
  })

  // Antes cualquier fallo terminaba en /onboarding, y esa ruta devuelve a esta
  // página en cuanto ve que el usuario ya tiene empresa: el ciclo se repetía
  // hasta que Convex volviera. Una consulta caída no es «no tienes empresa».
  it('shows the recoverable error screen when the workspace query fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockConvexQuery.mockRejectedValue(new Error('convex unavailable'))
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    const page = await MyCompanyDocumentsPage({ params: Promise.resolve({ locale: 'es' }) })
    render(page)

    expect(mockRedirect).not.toHaveBeenCalled()
    expect(mockDocumentsClient).not.toHaveBeenCalled()
    expect(screen.getByText('No pudimos cargar este espacio')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Intentar de nuevo/i })).toBeInTheDocument()
    errorSpy.mockRestore()
  })

  // La otra mitad del `reason`: sin sesión de empresa el alta sigue viva y el
  // destino sigue siendo el onboarding.
  it('still sends a company owner without a Convex session to onboarding', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetAuthenticatedConvex.mockResolvedValue({ client: null, isAuthenticated: false })
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    await expect(
      MyCompanyDocumentsPage({ params: Promise.resolve({ locale: 'es' }) })
    ).rejects.toThrow('REDIRECT:/onboarding')
    expect(mockDocumentsClient).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('passes the server-resolved read-only capability to a company member workspace', async () => {
    mockConvexQuery.mockResolvedValue({
      access: 'READ_ONLY',
      company: createCompany(),
      rooms: [{ id: 'deal_member_1', title: 'Raise 2027', status: 'OPEN' }],
    })
    const { default: MyCompanyDocumentsPage } =
      await import('@/app/[locale]/(app)/my-company/documents/page')

    const result = (await MyCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es' }),
    })) as { props: Record<string, unknown> }

    expect(result.props).toEqual(
      expect.objectContaining({
        companyId: 'company_123',
        accessMode: 'READ_ONLY',
      })
    )
  })

  // [F] 2026-09-01: la bitácora de accesos salió de la cara del cliente. La
  // empresa dueña ya no la carga ni consulta su propia sala desde acá: vuelve al
  // data room sin tocar Convex.
  it.each(['COMPANY'])(
    'sends %s back to the data room without querying the activity page data',
    async (effectiveRole) => {
      mockRequireAuth.mockResolvedValue({ ...createCompanyUser(), effectiveRole })
      const { default: DataRoomActivityPage } =
        await import('@/app/[locale]/(app)/my-company/documents/activity/page')

      await expect(
        DataRoomActivityPage({ params: Promise.resolve({ locale: 'es' }) })
      ).rejects.toThrow('REDIRECT:/my-company/documents')
      expect(mockConvexQuery).not.toHaveBeenCalled()
      expect(mockFetchQuery).not.toHaveBeenCalled()
    }
  )

  // ES: El equipo audita salas ajenas: `getRoomActivity` ya autoriza admin en
  // Convex; la página solo tiene que dejarlo elegir la sala vía `?company=`.
  it('sends an admin without a company param back to the admin panel', async () => {
    mockRequireAuth.mockResolvedValue({ ...createCompanyUser(), effectiveRole: 'ADMIN' })
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    await expect(
      DataRoomActivityPage({
        params: Promise.resolve({ locale: 'es' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('REDIRECT:/admin')
    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('loads the requested company for an admin through the authenticated Convex client', async () => {
    mockRequireAuth.mockResolvedValue({ ...createCompanyUser(), effectiveRole: 'ADMIN' })
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    const page = await DataRoomActivityPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ company: 'k57abcdefghijklmnopqrstuv' }),
    })
    render(page)

    expect(mockConvexQuery).toHaveBeenCalledWith('companies.getCompany', {
      companyId: 'k57abcdefghijklmnopqrstuv',
    })
    expect(mockActivityClient).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company_123',
        returnHref: '/admin/companies/company_123/documents',
      })
    )
    expect(mockFetchQuery).not.toHaveBeenCalled()
  })

  it('sends an admin back to the panel when the requested company does not exist', async () => {
    mockRequireAuth.mockResolvedValue({ ...createCompanyUser(), effectiveRole: 'ADMIN' })
    mockConvexQuery.mockResolvedValue(null)
    const { default: DataRoomActivityPage } =
      await import('@/app/[locale]/(app)/my-company/documents/activity/page')

    await expect(
      DataRoomActivityPage({
        params: Promise.resolve({ locale: 'es' }),
        searchParams: Promise.resolve({ company: 'k57companydoesnotexist01' }),
      })
    ).rejects.toThrow('REDIRECT:/admin')
  })

  it.each(['company_123', '<script>alert(1)</script>', 'not-an-id'])(
    'ignores an invalid company filter %s instead of querying Convex',
    async (company) => {
      mockRequireAuth.mockResolvedValue({ ...createCompanyUser(), effectiveRole: 'ADMIN' })
      const { default: DataRoomActivityPage } =
        await import('@/app/[locale]/(app)/my-company/documents/activity/page')

      await expect(
        DataRoomActivityPage({
          params: Promise.resolve({ locale: 'es' }),
          searchParams: Promise.resolve({ company }),
        })
      ).rejects.toThrow('REDIRECT:/admin')
      expect(mockConvexQuery).not.toHaveBeenCalled()
    }
  )
})
