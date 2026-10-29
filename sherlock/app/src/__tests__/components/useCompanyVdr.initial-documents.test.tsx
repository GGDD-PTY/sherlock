// ============================================================================
// LISTA INICIAL DE LA SALA RESUELTA EN EL SERVIDOR
// ============================================================================
// Sin ella, la sala pinta un esqueleto hasta que el cliente hidrata, abre el
// WebSocket y recibe la primera respuesta de `documents.getByCompany`: la lista
// aparecia a ~1,0 s a 20 Mbps aunque el HTML llegara a 0,4 s. La pagina la
// resuelve en el servidor y la pasa por props; la consulta viva manda en cuanto
// responde, y la lista inicial solo vale para la sala corporativa, que es el
// scope con el que se resolvio.
// ============================================================================

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  live: undefined as unknown[] | undefined,
  search: '',
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))
vi.mock('convex/react', () => ({
  useQuery: () => state.live,
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
  useSearchParams: () => new URLSearchParams(state.search),
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
import type { VdrDocumentView } from '@/components/company/vdr/types'
import { useCompanyVdr } from '@/components/company/vdr/useCompanyVdr'

const INITIAL: VdrDocumentView[] = [
  { _id: 'document_initial', name: 'Modelo financiero.xlsx', folder: 'room_financial' },
]
const LIVE: VdrDocumentView[] = [
  { _id: 'document_initial', name: 'Modelo financiero.xlsx', folder: 'room_financial' },
  { _id: 'document_new', name: 'Teaser.pdf', folder: 'room_marketing' },
]

function renderVdr(initialDocuments: VdrDocumentView[] | null) {
  return renderHook(() =>
    useCompanyVdr({
      companyId: 'company-1',
      isDemo: false,
      accessMode: 'MANAGE',
      locale: 'es',
      copy: VDR_COPY.es,
      initialDocuments,
      uploadDocument: vi.fn(),
    })
  )
}

describe('useCompanyVdr initial documents', () => {
  it('pinta la lista del servidor sin pasar por el esqueleto y cede a la consulta viva', () => {
    state.live = undefined
    state.search = ''
    const { result, rerender } = renderVdr(INITIAL)

    expect(result.current.isLoading).toBe(false)
    expect(result.current.documents.map((document) => document._id)).toEqual(['document_initial'])

    state.live = LIVE
    rerender()

    expect(result.current.documents.map((document) => document._id)).toEqual([
      'document_initial',
      'document_new',
    ])
  })

  it('sin lista inicial la sala sigue cargando hasta que la consulta viva responde', () => {
    state.live = undefined
    state.search = ''
    const { result } = renderVdr(null)

    expect(result.current.isLoading).toBe(true)
    expect(result.current.documents).toEqual([])
  })

  // La sala es una por empresa ([F] 2026-09-17): una URL vieja con otro scope
  // no cambia qué lista se hereda ni la deja en esqueleto.
  it('una URL de sala retirada sigue pintando la lista de la empresa', () => {
    state.live = undefined
    state.search = 'room=deal:deal_1&view=documents'
    const { result } = renderVdr(INITIAL)

    expect(result.current.isLoading).toBe(false)
    expect(result.current.documents.map((document) => document._id)).toEqual(['document_initial'])
  })
})
