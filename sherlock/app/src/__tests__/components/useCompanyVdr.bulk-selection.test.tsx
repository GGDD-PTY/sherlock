import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}))
vi.mock('convex/react', () => ({
  useQuery: () => [],
  useMutation: () => vi.fn(),
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

describe('useCompanyVdr bulk selection authority', () => {
  it('keeps the first 50 visible IDs and owns the localized cap feedback', () => {
    const { result } = renderHook(() =>
      useCompanyVdr({
        companyId: 'company-1',
        isDemo: true,
        accessMode: 'MANAGE',
        locale: 'es',
        copy: VDR_COPY.es,
        uploadDocument: vi.fn(),
      })
    )
    const ids = Array.from({ length: 51 }, (_, index) => `document-${index}`)

    act(() => result.current.selectAllFilteredDocuments(ids, true))

    expect([...result.current.selectedDocumentIds]).toEqual(ids.slice(0, 50))
    expect(toastError).toHaveBeenCalledWith('Seleccionamos los primeros 50 documentos visibles.')

    act(() => result.current.toggleDocumentSelection(ids[50], true))

    expect(result.current.selectedDocumentIds).toHaveLength(50)
    expect(toastError).toHaveBeenLastCalledWith(
      'Puedes seleccionar hasta 50 documentos por operación.'
    )
  })
})
