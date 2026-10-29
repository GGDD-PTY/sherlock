import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
let searchParams = new URLSearchParams()

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess, info: vi.fn() },
}))
vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: () => vi.fn(),
}))
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      getByCompany: 'documents:getByCompany',
      bulkUpdate: 'documents:bulkUpdate',
    },
  },
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { _id: 'user-1' }, isSignedIn: true }),
}))
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/es/my-company/documents',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}))
vi.mock('@/lib/dev-auth/demo-browser-store', () => ({
  addDemoDocument: vi.fn(),
  getDemoDocuments: () => [],
  removeDemoDocument: vi.fn(),
  updateDemoDocument: vi.fn(),
}))
vi.mock('@/components/company/vdr/useVdrDocumentActions', () => ({
  useVdrDocumentActions: () => ({
    moveDocumentToFolder: vi.fn(),
    renameDocument: vi.fn(),
  }),
}))
const adminOperator = vi.hoisted(() => ({ value: false }))
vi.mock('@/components/company/vdr/AdminVdrCapabilityContext', () => ({
  useAdminVdrCapability: () =>
    vi.fn(async (_action: string, _target: unknown, input: unknown) => input),
  useAdminVdrOperator: () => adminOperator.value,
}))

import { VDR_COPY } from '@/components/company/vdr/config'
import { useCompanyVdr } from '@/components/company/vdr/useCompanyVdr'
import type { DirectVdrUploadInput } from '@/hooks/useDirectVdrUpload'

const documents = [
  {
    _id: 'document-fs',
    name: 'Estados financieros 2024',
    folder: 'room_financial',
    accessLevel: 'PRIVATE' as const,
    classification: 'RESTRICTED' as const,
    lifecycleStatus: 'ACTIVE' as const,
  },
]

function renderVdr(
  overrides: Partial<Parameters<typeof useCompanyVdr>[0]> = {},
  uploadDocument: ReturnType<typeof vi.fn> = vi.fn()
) {
  return {
    uploadDocument,
    ...renderHook(() =>
      useCompanyVdr({
        companyId: 'company-1',
        isDemo: false,
        accessMode: 'MANAGE',
        locale: 'es',
        copy: VDR_COPY.es,
        uploadDocument: uploadDocument as never,
        ...overrides,
      })
    ),
  }
}

async function selectFile(result: { current: ReturnType<typeof useCompanyVdr> }, file: File) {
  await act(async () => {
    await result.current.handleFileSelect({
      target: { files: [file], value: '' },
    } as never)
  })
}

describe('useCompanyVdr upload payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    adminOperator.value = false
    mockUseQuery.mockReturnValue(documents)
  })

  it('keeps the current document name when COMPANY uploads a new version', async () => {
    const uploadDocument = vi.fn(async (input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: input.replaceDocumentId ?? 'missing',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'EF-final-v2.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.startVersionUpload(documents[0])
    })
    await selectFile(result, file)
    expect(result.current.docName).toBe('Estados financieros 2024')

    await act(async () => {
      await result.current.handleUpload()
    })

    expect(uploadDocument).toHaveBeenCalledOnce()
    expect(uploadDocument.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        name: 'Estados financieros 2024',
        replaceDocumentId: 'document-fs',
        file,
      })
    )
  })

  it('keeps an admin-edited name when selecting the version file', async () => {
    const { result } = renderVdr()
    const file = new File(['pdf-bytes'], 'EF-final-v2.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.startVersionUpload(documents[0])
      result.current.setDocName('Estados financieros 2024 (revisado)')
    })
    await selectFile(result, file)

    expect(result.current.docName).toBe('Estados financieros 2024 (revisado)')
  })

  it('uses the file basename for a new document', async () => {
    const uploadDocument = vi.fn(async (_input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: 'new-1',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'EF-final-v2.pdf', { type: 'application/pdf' })

    await selectFile(result, file)
    expect(result.current.docName).toBe('EF-final-v2')

    await act(async () => {
      await result.current.handleUpload()
    })

    const payload = uploadDocument.mock.lastCall?.[0]
    expect(payload).toEqual(expect.objectContaining({ name: 'EF-final-v2' }))
    expect(payload).not.toHaveProperty('replaceDocumentId')
  })

  it('rutea la subida automática con el mismo clasificador de la landing', async () => {
    const uploadDocument = vi.fn(async (_input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: 'new-2',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'estados-financieros.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.queueFiles([file])
    })
    expect(result.current.folder).toBe('other')
    expect(result.current.accessLevel).toBe('NDA_REQUIRED')
    expect(result.current.classification).toBe('CONFIDENTIAL')

    await act(async () => {
      await result.current.handleUpload()
    })

    expect(uploadDocument).toHaveBeenCalledOnce()
    const payload = uploadDocument.mock.lastCall?.[0]
    expect(payload).toEqual(
      expect.objectContaining({
        name: 'estados-financieros',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        folder: 'room_financial',
      })
    )
    expect(payload).not.toHaveProperty('replaceDocumentId')
  })

  // El centinela 'other' no es una carpeta del shell: si el nombre no dice
  // nada, el destino sigue siendo el respaldo donde el equipo lo mueve.
  it('deja el respaldo cuando el nombre del archivo no dice nada', async () => {
    const uploadDocument = vi.fn(async (_input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: 'new-3',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'aapl-20250927.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.queueFiles([file])
    })
    await act(async () => {
      await result.current.handleUpload()
    })

    expect(uploadDocument.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({ folder: 'room_corporate' })
    )
  })

  it('respeta la carpeta que el cliente eligió a mano', async () => {
    const uploadDocument = vi.fn(async (_input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: 'new-4',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'estados-financieros.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.queueFiles([file])
    })
    act(() => {
      result.current.setFolder('room_legal')
    })
    await act(async () => {
      await result.current.handleUpload()
    })

    expect(uploadDocument.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({ folder: 'room_legal' })
    )
  })

  // El formulario del equipo ofrece el catálogo heredado completo: «Teaser» es
  // una reclasificación deliberada, no el centinela del ruteo automático.
  it('guarda tal cual la carpeta heredada que elige el equipo', async () => {
    adminOperator.value = true
    const uploadDocument = vi.fn(async (_input: DirectVdrUploadInput) => ({
      ok: true as const,
      documentId: 'new-5',
    }))
    const { result } = renderVdr({}, uploadDocument)
    const file = new File(['pdf-bytes'], 'estados-financieros.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.queueFiles([file])
    })
    act(() => {
      result.current.setFolder('teaser')
    })
    await act(async () => {
      await result.current.handleUpload()
    })

    expect(uploadDocument.mock.lastCall?.[0]).toEqual(expect.objectContaining({ folder: 'teaser' }))
  })

  it('preselects the room folder the client is standing on', () => {
    const { result } = renderVdr()

    act(() => {
      result.current.setActiveRoomFolder('room_financial')
    })

    expect(result.current.folder).toBe('room_financial')
  })

  it('keeps the folder of a queue the client already started', async () => {
    const { result } = renderVdr()
    const file = new File(['pdf-bytes'], 'estados-financieros.pdf', { type: 'application/pdf' })

    act(() => {
      result.current.queueFiles([file])
    })
    act(() => {
      result.current.setActiveRoomFolder('room_financial')
    })

    expect(result.current.folder).toBe('other')
  })

  it('keeps the folder of the document whose version is being replaced', () => {
    const { result } = renderVdr()

    act(() => {
      result.current.startVersionUpload(documents[0])
    })
    act(() => {
      result.current.setActiveRoomFolder('room_legal')
    })

    expect(result.current.folder).toBe('room_financial')
  })
})
