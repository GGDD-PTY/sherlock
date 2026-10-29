// ============================================================================
// WORKSPACE PROVISIONING — CONTRATO DEL PRIMER LOGIN
// ============================================================================
// El componente es la parada de aprovisionamiento de /onboarding: dispara la
// mutación una sola vez y enruta según el rol que devuelve. Un fallo NO navega:
// una navegación automática podría reabrir la mutación en un loop invisible,
// así que el fallo se queda en un
// estado de error con reintento manual.
// next-intl está mockeado globalmente para devolver la clave, así que las
// aserciones van sobre estructura (`role="status"`, `role="alert"`), nunca
// sobre el copy.
// ============================================================================

import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/lib/analytics/posthog'

const mockEnsureCompanyWorkspace = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())
const mockReplace = vi.hoisted(() => vi.fn())
const mockLogError = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      ensureCompanyWorkspace: 'companies:ensureCompanyWorkspace',
      updateCompany: 'companies.updateCompany',
    },
  },
}))

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

vi.mock('@/lib/logger', () => ({
  loggers: {
    onboarding: { error: mockLogError },
  },
}))

// El hook real corre contra este mock: así las aserciones fijan los nombres de
// evento que llegan a PostHog, no la superficie del hook.
vi.mock('@/lib/analytics/posthog')

import { WorkspaceProvisioning } from '@/components/onboarding/WorkspaceProvisioning'

function trackedEventNames(): string[] {
  return vi.mocked(track).mock.calls.map(([event]) => event.event)
}

describe('WorkspaceProvisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: true,
      role: 'COMPANY',
      company: { _id: 'companies_1' },
    })
    mockUseMutation.mockReturnValue(mockEnsureCompanyWorkspace)
  })

  it('preserves the intake nonce through provisioning in StrictMode', async () => {
    render(
      <StrictMode>
        <WorkspaceProvisioning handoffNonce="938c27d4-b16f-4087-b191-4fcb7c348959" />
      </StrictMode>
    )
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/my-company/documents?handoff=938c27d4-b16f-4087-b191-4fcb7c348959'
      )
    )
  })

  it('does not forward an intake nonce to ADMIN', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({ role: 'ADMIN', company: null })
    render(<WorkspaceProvisioning handoffNonce="938c27d4-b16f-4087-b191-4fcb7c348959" />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'))
  })

  it('fires the provisioning mutation exactly once across re-renders', async () => {
    const { rerender } = render(<WorkspaceProvisioning />)
    rerender(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockEnsureCompanyWorkspace).toHaveBeenCalledTimes(1)
    })
    expect(mockEnsureCompanyWorkspace).toHaveBeenCalledWith({})
    expect(mockUseMutation).toHaveBeenCalledWith('companies:ensureCompanyWorkspace')
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  // El destino del éxito es el workspace de documentos: ahí reclama
  // MyCompanyDocumentsClient el stash de IndexedDB que dejó el flujo mycroft.
  it('sends a provisioned COMPANY to the documents workspace', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: true,
      role: 'COMPANY',
      company: { _id: 'companies_1' },
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/my-company/documents')
    })
    expect(mockReplace).not.toHaveBeenCalledWith('/onboarding')
  })

  it('treats incomplete legacy metadata as readiness work, not a wizard gate', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'COMPANY',
      company: { _id: 'companies_1', onboardingStep: 3 },
    })

    const { unmount } = render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/my-company/documents')
    })

    unmount()
    expect(trackedEventNames()).toEqual(['onboarding_started', 'onboarding_completed'])
  })

  it('sends an existing completed company to the documents workspace', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'COMPANY',
      company: { _id: 'companies_1', onboardingStep: 6, onboardingCompletedAt: 1724200000000 },
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/my-company/documents')
    })
  })

  // Un `company: null` es una negación del resolver (enforcement, membresías
  // ambiguas). El estado de error retryable es el único destino honesto.
  it('surfaces the error state for a COMPANY whose provisioning was denied', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'COMPANY',
      company: null,
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeInTheDocument()
    })
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith('Workspace provisioning denied')
    // Un aprovisionamiento denegado no cuenta como onboarding completado.
    expect(vi.mocked(track)).not.toHaveBeenCalled()
  })

  it('sends an ADMIN session to the admin surface', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'ADMIN',
      company: null,
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/admin')
    })
    // Un ADMIN no atraviesa el embudo de onboarding de empresa.
    expect(vi.mocked(track)).not.toHaveBeenCalled()
  })

  it('surfaces a retryable error state instead of redirecting when provisioning fails', async () => {
    mockEnsureCompanyWorkspace.mockRejectedValue(new Error('convex unreachable'))

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('button')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // Igualdad estricta de argumentos: un segundo argumento con el error crudo
    // (o la identidad del usuario) haría fallar este assert.
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String))
  })

  // La regresión concreta: redirigir al wizard con el perfil de Convex ausente
  // lo rebotaba a /onboarding, remontaba el componente con el `useRef` limpio y
  // reabría la mutación detrás del copy de "preparando tu espacio".
  it('never navigates or refires the mutation while the error state is on screen', async () => {
    mockEnsureCompanyWorkspace.mockRejectedValue(new Error('convex unreachable'))

    const { rerender } = render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    rerender(<WorkspaceProvisioning />)

    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockEnsureCompanyWorkspace).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('retries the mutation and routes when the user asks', async () => {
    mockEnsureCompanyWorkspace.mockRejectedValueOnce(new Error('convex unreachable'))
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: true,
      role: 'COMPANY',
      company: { _id: 'companies_1' },
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(mockReplace).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/my-company/documents')
    })
    expect(mockEnsureCompanyWorkspace).toHaveBeenCalledTimes(2)
    expect(mockEnsureCompanyWorkspace).toHaveBeenLastCalledWith({})
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // El camino dorado no emitía nada, así que los usuarios aprovisionados
  // desaparecían del embudo mientras `onboarding_started` solo se veía en
  // fallos y en demo.
  it('counts a provisioned workspace as started and completed exactly once', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: true,
      role: 'COMPANY',
      company: { _id: 'companies_1' },
    })

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/my-company/documents')
    })

    expect(trackedEventNames()).toEqual(['onboarding_started', 'onboarding_completed'])
    expect(vi.mocked(track)).toHaveBeenCalledWith({
      event: 'onboarding_started',
      properties: { role: 'COMPANY' },
    })
    expect(vi.mocked(track)).toHaveBeenCalledWith({
      event: 'onboarding_completed',
      properties: expect.objectContaining({
        role: 'COMPANY',
        totalSteps: 1,
        stepsCompleted: 1,
      }),
    })
    // Ninguna identidad de usuario viaja al analytics: sin email, sin id.
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('@')
  })

  it('emits no funnel events when provisioning fails', async () => {
    mockEnsureCompanyWorkspace.mockRejectedValue(new Error('convex unreachable'))

    render(<WorkspaceProvisioning />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    expect(vi.mocked(track)).not.toHaveBeenCalled()
  })

  // `useOnboardingAnalytics` abre la sesión al montarse y emite
  // `onboarding_abandoned` en el CLEANUP si nadie la completó. Las aserciones de
  // arriba corren antes del desmonte, así que un abandono inventado a cada ADMIN
  // y a cada degradación al wizard les pasaba por debajo: hay que desmontar.
  it('never reports an abandonment for an ADMIN session', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'ADMIN',
      company: null,
    })

    const { unmount } = render(<WorkspaceProvisioning />)
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/admin')
    })

    unmount()

    expect(trackedEventNames()).not.toContain('onboarding_abandoned')
    expect(vi.mocked(track)).not.toHaveBeenCalled()
  })

  it('never reports an abandonment for a denied provisioning', async () => {
    mockEnsureCompanyWorkspace.mockResolvedValue({
      created: false,
      role: 'COMPANY',
      company: null,
    })

    const { unmount } = render(<WorkspaceProvisioning />)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    unmount()

    expect(trackedEventNames()).not.toContain('onboarding_abandoned')
    expect(vi.mocked(track)).not.toHaveBeenCalled()
  })
})
