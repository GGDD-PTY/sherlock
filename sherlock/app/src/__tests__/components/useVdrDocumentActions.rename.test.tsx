import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateDocument = vi.hoisted(() => vi.fn())
const mockGetDownloadUrl = vi.hoisted(() => vi.fn())
const mockAuthorize = vi.hoisted(() => vi.fn())
const mockUpdateDemoDocument = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess, info: vi.fn() },
}))
vi.mock('convex/react', () => ({
  useMutation: (reference: unknown) =>
    reference === 'documents:update' ? mockUpdateDocument : mockGetDownloadUrl,
}))
vi.mock('@/../convex/_generated/api', () => ({
  api: { documents: { update: 'documents:update', getDownloadUrl: 'documents:getDownloadUrl' } },
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { _id: 'user-1' }, isSignedIn: true }),
}))
vi.mock('@/lib/dev-auth/demo-browser-store', () => ({
  removeDemoDocument: vi.fn(),
  updateDemoDocument: mockUpdateDemoDocument,
}))
vi.mock('@/components/company/vdr/AdminVdrCapabilityContext', () => ({
  useAdminVdrCapability: () => mockAuthorize,
}))

import { VDR_COPY } from '@/components/company/vdr/config'
import { useVdrDocumentActions } from '@/components/company/vdr/useVdrDocumentActions'

describe('useVdrDocumentActions inline rename command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthorize.mockImplementation(
      async (_action: string, _target: unknown, input: unknown) => input
    )
    mockUpdateDocument.mockResolvedValue({})
    mockUpdateDemoDocument.mockReturnValue({ id: 'document-1' })
  })

  it('trims and updates only documentId and name through the existing capability', async () => {
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: false,
        bumpDemoVersion: vi.fn(),
      })
    )

    let renamed = false
    await act(async () => {
      renamed = await result.current.renameDocument('document-1', '  Final model.xlsx  ')
    })

    expect(renamed).toBe(true)
    expect(mockAuthorize).toHaveBeenCalledWith('DOCUMENT_UPDATE', 'DOCUMENT:document-1', {
      documentId: 'document-1',
      name: 'Final model.xlsx',
    })
    expect(mockUpdateDocument).toHaveBeenCalledWith({
      documentId: 'document-1',
      name: 'Final model.xlsx',
    })
  })

  it('returns false for whitespace or a rejected mutation with only safe localized feedback', async () => {
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: false,
        bumpDemoVersion: vi.fn(),
      })
    )

    await act(async () => {
      expect(await result.current.renameDocument('document-1', '   ')).toBe(false)
    })
    expect(mockUpdateDocument).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(VDR_COPY.es.missingFile)

    mockUpdateDocument.mockRejectedValueOnce(new Error('sensitive backend detail'))
    await act(async () => {
      expect(await result.current.renameDocument('document-1', 'Safe name.pdf')).toBe(false)
    })
    expect(toastError).toHaveBeenLastCalledWith(VDR_COPY.es.editError)
    expect(toastError.mock.calls.flat().join(' ')).not.toContain('sensitive backend detail')
  })

  it('uses the demo store without touching edit-dialog state', async () => {
    const bumpDemoVersion = vi.fn()
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: true,
        bumpDemoVersion,
      })
    )

    await act(async () => {
      expect(await result.current.renameDocument('document-1', '  Modelo final.xlsx ')).toBe(true)
    })

    expect(mockUpdateDemoDocument).toHaveBeenCalledWith('document-1', {
      name: 'Modelo final.xlsx',
    })
    expect(bumpDemoVersion).toHaveBeenCalledOnce()
    expect(result.current.editing).toBeNull()
    expect(result.current.editOpen).toBe(false)
  })

  it('returns false when the demo document is unknown without bumping or success feedback', async () => {
    const bumpDemoVersion = vi.fn()
    mockUpdateDemoDocument.mockReturnValueOnce(null)
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: true,
        bumpDemoVersion,
      })
    )

    await act(async () => {
      expect(await result.current.renameDocument('unknown-document', 'Nombre.pdf')).toBe(false)
    })

    expect(bumpDemoVersion).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(VDR_COPY.es.editError)
  })

  it('fails a demo move when the demo store does not find the document', async () => {
    const bumpDemoVersion = vi.fn()
    mockUpdateDemoDocument.mockReturnValueOnce(null)
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: true,
        bumpDemoVersion,
      })
    )

    await act(async () => {
      expect(await result.current.moveDocumentToFolder('unknown-document', 'room_legal')).toBe(
        false
      )
    })

    expect(bumpDemoVersion).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(VDR_COPY.es.editError)
  })

  it('keeps single move on the exact update capability and reports mutation rejection', async () => {
    const { result } = renderHook(() =>
      useVdrDocumentActions({
        copy: VDR_COPY.es,
        locale: 'es',
        isDemo: false,
        bumpDemoVersion: vi.fn(),
      })
    )

    await act(async () => {
      expect(await result.current.moveDocumentToFolder('document-1', 'room_financial')).toBe(true)
    })
    expect(mockAuthorize).toHaveBeenCalledWith('DOCUMENT_UPDATE', 'DOCUMENT:document-1', {
      documentId: 'document-1',
      folder: 'room_financial',
    })
    expect(mockUpdateDocument).toHaveBeenCalledWith({
      documentId: 'document-1',
      folder: 'room_financial',
    })

    mockUpdateDocument.mockRejectedValueOnce(new Error('scope changed'))
    await act(async () => {
      expect(await result.current.moveDocumentToFolder('document-1', 'room_legal')).toBe(false)
    })
    expect(toastError).toHaveBeenLastCalledWith(VDR_COPY.es.editError)
  })
})
