import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
const purgeMutation = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}))
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => purgeMutation,
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { _id: 'user-1' }, isSignedIn: true }),
}))
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/es/my-company/documents',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/dev-auth/demo-browser-store', () => ({
  addDemoDocument: vi.fn(),
  getDemoDocuments: () => [],
  removeDemoDocument: vi.fn(),
  updateDemoDocument: vi.fn(),
}))
vi.mock('@/components/company/vdr/useVdrDocumentActions', () => ({
  useVdrDocumentActions: () => ({}),
}))
vi.mock('@/components/company/vdr/AdminVdrCapabilityContext', () => ({
  useAdminVdrCapability: () => vi.fn(),
  useAdminVdrOperator: () => false,
}))

import { VDR_COPY } from '@/components/company/vdr/config'
import { useCompanyVdr } from '@/components/company/vdr/useCompanyVdr'

const DOCUMENTS = [
  { _id: 'document-own', name: 'Estados financieros.pdf' },
  {
    _id: 'document-delivered',
    name: 'Presentación de management.pdf',
    sourceType: 'TEAM_DELIVERABLE',
  },
]

function serverRejection(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } })
}

function renderVdr() {
  return renderHook(() =>
    useCompanyVdr({
      companyId: 'company-1',
      isDemo: false,
      accessMode: 'MANAGE',
      locale: 'es',
      copy: VDR_COPY.es,
      uploadDocument: vi.fn(),
      initialDocuments: DOCUMENTS,
    })
  )
}

describe('useCompanyVdr purge feedback', () => {
  it('names the team deliverable that blocks the batch', async () => {
    purgeMutation.mockRejectedValueOnce(
      serverRejection(
        'VALIDATION_FAILED',
        'Este documento es una entrega del equipo; el equipo puede retirarla desde Admin.'
      )
    )
    const { result } = renderVdr()

    await act(async () => {
      await result.current.purgeDocuments(['document-own', 'document-delivered'])
    })

    expect(toastError).toHaveBeenLastCalledWith(
      VDR_COPY.es.purgeTeamDeliverableError(['Presentación de management.pdf'])
    )
  })

  // El servidor redacta para un log y cita el id de la fila. Al cliente le
  // llega el nombre del documento, que es lo único que puede accionar.
  it("shows the server's reason with the document named instead of its id", async () => {
    purgeMutation.mockRejectedValueOnce(
      serverRejection(
        'VALIDATION_FAILED',
        'El documento document-own tiene un legal hold ACTIVE; ningún borrado ocurrió.'
      )
    )
    const { result } = renderVdr()

    await act(async () => {
      await result.current.purgeDocuments(['document-own'])
    })

    expect(toastError).toHaveBeenLastCalledWith(
      'El documento «Estados financieros.pdf» tiene un legal hold ACTIVE; ningún borrado ocurrió.'
    )
  })

  // Una entrega en la selección no explica un 429: el motivo del servidor manda.
  it('does not blame the team deliverable when the batch failed for another reason', async () => {
    purgeMutation.mockRejectedValueOnce(
      serverRejection('RATE_LIMIT_EXCEEDED', 'Demasiadas solicitudes.')
    )
    const { result } = renderVdr()

    await act(async () => {
      await result.current.purgeDocuments(['document-own', 'document-delivered'])
    })

    const message = toastError.mock.lastCall?.[0] as string
    expect(message).not.toContain('la preparó el equipo')
    expect(message).toBe(VDR_COPY.es.mutationErrors.RATE_LIMIT_EXCEEDED)
  })

  it('falls back to the room copy when the failure carries no reason', async () => {
    purgeMutation.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderVdr()

    await act(async () => {
      await result.current.purgeDocuments(['document-own'])
    })

    expect(toastError).toHaveBeenLastCalledWith(VDR_COPY.es.purgeErrorFallback)
  })
})
