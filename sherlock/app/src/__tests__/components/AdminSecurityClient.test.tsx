import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn(() => vi.fn()))
const mockDevAuth = vi.hoisted(() => ({ enabled: true }))

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    security: {
      getRecentSecurityEvents: 'security:getRecentSecurityEvents',
      getSecurityEventsCounts: 'security:getSecurityEventsCounts',
      resolveSecurityEvent: 'security:resolveSecurityEvent',
    },
    documents: {
      getManualReviewQueue: 'documents:getManualReviewQueue',
    },
  },
}))

vi.mock('@/lib/dev-auth/config', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuth.enabled
  },
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    profile: null,
  }),
}))

describe('AdminSecurityClient', () => {
  beforeEach(() => {
    mockUseQuery.mockClear()
    mockUseMutation.mockClear()
    mockDevAuth.enabled = true
  })

  const lastEventsArgs = () =>
    mockUseQuery.mock.calls.findLast(([query]) => query === 'security:getRecentSecurityEvents')?.[1]

  it('uses local demo security data instead of protected Convex queries in dev-auth', async () => {
    mockUseQuery.mockReturnValue(undefined)

    const { AdminSecurityClient } = await import('@/components/admin/AdminSecurityClient')
    render(<AdminSecurityClient />)

    expect(mockUseQuery).toHaveBeenCalledWith('security:getRecentSecurityEvents', 'skip')
    expect(mockUseQuery).toHaveBeenCalledWith('security:getSecurityEventsCounts', 'skip')
    expect(mockUseQuery).toHaveBeenCalledWith('documents:getManualReviewQueue', 'skip')

    expect(screen.getByText(/Se muestran datos demo locales/)).toBeInTheDocument()
    expect(screen.getByText('Inicio de sesión fallido')).toBeInTheDocument()
    expect(
      screen.getByText('Revisión manual pendiente: cronograma de deuda de SAMPLE_HYDRO')
    ).toBeInTheDocument()
    expect(screen.getByText('20 documentos en cola')).toBeInTheDocument()
  })
  it('manda el tipo de evento elegido al servidor, no lo filtra en el navegador', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue([])

    const { AdminSecurityClient } = await import('@/components/admin/AdminSecurityClient')
    render(<AdminSecurityClient />)

    expect(lastEventsArgs()).toMatchObject({
      limit: 100,
      includeResolved: false,
      type: undefined,
    })

    const [, typeSelect] = screen.getAllByRole('combobox')
    fireEvent.keyDown(typeSelect, { key: 'ArrowDown' })
    await userEvent.click(await screen.findByRole('option', { name: 'Inicio de sesión fallido' }))

    await waitFor(() => {
      expect(lastEventsArgs()).toMatchObject({ type: 'FAILED_LOGIN' })
    })
  })
})
