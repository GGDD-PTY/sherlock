import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockBulkUpdate = vi.hoisted(() => vi.fn())
const mockUseQuery = vi.hoisted(() => vi.fn())
const mockAuthorize = vi.hoisted(() => vi.fn())
const mockMoveOne = vi.hoisted(() => vi.fn())
const mockRename = vi.hoisted(() => vi.fn())
const mockUpdateDemoDocument = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())
let searchParams = new URLSearchParams()

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess, info: toastInfo },
}))
vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: (reference: unknown) => {
    if (reference === 'documents:bulkUpdate') return mockBulkUpdate
    return vi.fn()
  },
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
  updateDemoDocument: mockUpdateDemoDocument,
}))
vi.mock('@/components/company/vdr/useVdrDocumentActions', () => ({
  useVdrDocumentActions: () => ({
    moveDocumentToFolder: mockMoveOne,
    renameDocument: mockRename,
  }),
}))
vi.mock('@/components/company/vdr/AdminVdrCapabilityContext', () => ({
  useAdminVdrCapability: () => mockAuthorize,
  useAdminVdrOperator: () => false,
}))

import { VDR_COPY } from '@/components/company/vdr/config'
import { roomQueryArgs } from '@/components/company/vdr/helpers'
import { useCompanyVdr } from '@/components/company/vdr/useCompanyVdr'

const documents = [
  { _id: 'document-a', name: 'A.pdf', folder: 'legal', lifecycleStatus: 'ACTIVE' as const },
  { _id: 'document-b', name: 'B.pdf', folder: 'operations', lifecycleStatus: null },
  {
    _id: 'document-noop',
    name: 'Noop.pdf',
    folder: 'model',
    lifecycleStatus: 'ACTIVE' as const,
  },
  {
    _id: 'document-quarantined',
    name: 'Blocked.pdf',
    folder: 'legal',
    lifecycleStatus: 'QUARANTINED' as const,
  },
]

function renderVdr(overrides: Partial<Parameters<typeof useCompanyVdr>[0]> = {}) {
  return renderHook(() =>
    useCompanyVdr({
      companyId: 'company-1',
      isDemo: false,
      accessMode: 'MANAGE',
      locale: 'es',
      copy: VDR_COPY.es,
      uploadDocument: vi.fn(),
      ...overrides,
    })
  )
}

async function startSingleUpload(
  result: { current: ReturnType<typeof useCompanyVdr> },
  document: { _id: string; name: string; folder: string },
  fileName: string
) {
  act(() => {
    result.current.startVersionUpload(document as never)
  })
  const file = new File([fileName], fileName, { type: 'application/pdf' })
  await act(async () => {
    await result.current.handleFileSelect({
      target: { files: [file], value: '' },
    } as never)
  })
}

describe('useCompanyVdr domain commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    mockUseQuery.mockReturnValue(documents)
    mockAuthorize.mockImplementation(
      async (_action: string, _target: unknown, input: unknown) => input
    )
    mockBulkUpdate.mockResolvedValue({
      updated: 2,
      revokedGrants: 0,
      legalHoldsPreserved: 0,
    })
    mockMoveOne.mockResolvedValue(true)
    mockRename.mockResolvedValue(true)
  })

  it('routes a single move through the scoped bulk mutation after every filter', async () => {
    const { result } = renderVdr()

    let moved: string = 'FAILED'
    await act(async () => {
      moved = await result.current.moveDocuments(
        ['foreign', 'document-a', 'document-a', 'document-noop', 'document-quarantined'],
        'room_financial'
      )
    })

    expect(moved).toBe('MOVED')
    expect(mockMoveOne).not.toHaveBeenCalled()
    expect(mockBulkUpdate).toHaveBeenCalledWith({
      companyId: 'company-1',
      documentIds: ['document-a'],
      operation: { type: 'MOVE_FOLDER', folder: 'room_financial' },
    })
    expect(mockAuthorize).toHaveBeenCalledWith('DOCUMENT_BULK_UPDATE', 'COMPANY:company-1', {
      companyId: 'company-1',
      documentIds: ['document-a'],
      operation: { type: 'MOVE_FOLDER', folder: 'room_financial' },
    })
  })

  it('reports an all-no-op move as a no-op instead of a failure', async () => {
    const { result } = renderVdr()

    let outcome: string = 'MOVED'
    await act(async () => {
      outcome = await result.current.moveDocuments(['document-a'], 'room_legal')
    })

    expect(outcome).toBe('NOOP')
    expect(mockBulkUpdate).not.toHaveBeenCalled()
    expect(mockMoveOne).not.toHaveBeenCalled()
  })

  it('uses bulk update with only the explicit ordered IDs and the company scope', async () => {
    const { result } = renderVdr()

    act(() => {
      result.current.toggleDocumentSelection('document-noop', true)
    })
    await act(async () => {
      await result.current.moveDocuments(
        ['document-b', 'foreign', 'document-a', 'document-b'],
        'room_financial'
      )
    })

    expect(mockUseQuery).toHaveBeenCalledWith('documents:getByCompany', {
      companyId: 'company-1',
    })
    expect(mockBulkUpdate).toHaveBeenCalledWith({
      companyId: 'company-1',
      documentIds: ['document-b', 'document-a'],
      operation: { type: 'MOVE_FOLDER', folder: 'room_financial' },
    })
    expect(mockAuthorize).toHaveBeenCalledWith('DOCUMENT_BULK_UPDATE', 'COMPANY:company-1', {
      companyId: 'company-1',
      documentIds: ['document-b', 'document-a'],
      operation: { type: 'MOVE_FOLDER', folder: 'room_financial' },
    })
    expect([...result.current.selectedDocumentIds]).toEqual(['document-noop'])
  })

  it('reuses the exact COMPANY query shape for bulk mutation scope', async () => {
    const { result } = renderVdr()

    await act(async () => {
      await result.current.moveDocuments(['document-a', 'document-b'], 'room_marketing')
    })

    expect(mockUseQuery).toHaveBeenCalledWith('documents:getByCompany', {
      companyId: 'company-1',
    })
    expect(mockBulkUpdate).toHaveBeenCalledWith({
      companyId: 'company-1',
      documentIds: ['document-a', 'document-b'],
      operation: { type: 'MOVE_FOLDER', folder: 'room_marketing' },
    })
  })

  it('uses one typed room adapter for the exact COMPANY shape', () => {
    const companyId = 'company-1' as Id<'companies'>
    expect(roomQueryArgs(companyId, { kind: 'COMPANY', id: 'company' })).toEqual({
      companyId: 'company-1',
    })
  })

  it('queues same-target drops, freezes a retarget, cancels losslessly, and confirms atomically', () => {
    const uploadDocument = vi.fn()
    const { result } = renderVdr({ isDemo: true, uploadDocument })
    const first = new File(['one'], 'one.pdf', { type: 'application/pdf' })
    const second = new File(['two'], 'two.pdf', { type: 'application/pdf' })
    const third = new File(['three'], 'three.pdf', { type: 'application/pdf' })

    act(() => {
      expect(result.current.queueForeignFiles([first], 'room_operations')).toMatchObject({
        status: 'QUEUED',
        queuedCount: 1,
      })
      expect(result.current.queueForeignFiles([second], 'room_operations')).toMatchObject({
        status: 'QUEUED',
        queuedCount: 1,
      })
    })
    expect(result.current.folder).toBe('room_operations')
    expect(result.current.uploadQueue.map((entry) => entry.file)).toEqual([first, second])
    expect(result.current.uploadDialogOpen).toBe(true)

    const queueBeforeConfirmation = result.current.uploadQueue
    act(() => {
      expect(result.current.queueForeignFiles([third], 'room_legal')).toEqual({
        status: 'CONFIRMATION_REQUIRED',
        currentFolderId: 'room_operations',
        targetFolderId: 'room_legal',
        fileCount: 1,
      })
      expect(result.current.queueForeignFiles([third], 'room_financial')).toEqual({
        status: 'REJECTED',
        reason: 'PENDING_CONFIRMATION',
      })
    })
    expect(result.current.uploadQueue).toBe(queueBeforeConfirmation)
    expect(result.current.folder).toBe('room_operations')

    act(() => {
      result.current.resetUpload()
    })
    expect(result.current.uploadQueue).toBe(queueBeforeConfirmation)
    expect(result.current.folder).toBe('room_operations')

    act(() => {
      expect(result.current.cancelForeignDrop()).toBe(true)
    })
    expect(result.current.uploadQueue).toBe(queueBeforeConfirmation)
    expect(result.current.folder).toBe('room_operations')
    expect(result.current.confirmForeignDrop()).toEqual({
      status: 'REJECTED',
      reason: 'NO_PENDING_CONFIRMATION',
    })

    act(() => {
      result.current.queueForeignFiles([third], 'room_legal')
      expect(result.current.confirmForeignDrop()).toMatchObject({
        status: 'QUEUED',
        targetFolderId: 'room_legal',
        queuedCount: 1,
      })
    })
    expect(result.current.folder).toBe('room_legal')
    expect(result.current.uploadQueue.map((entry) => entry.file)).toEqual([first, second, third])
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(mockBulkUpdate).not.toHaveBeenCalled()
    expect(mockUpdateDemoDocument).not.toHaveBeenCalled()
  })

  // El scope de subida ya no puede cambiar de sala —hay una por empresa— pero sí
  // de empresa. Una subida vieja que responde después de ese cambio no puede
  // escribir el formulario, el latch ni el flag de la empresa nueva.
  it('ignores a late single upload that no longer owns the upload scope', async () => {
    const resolvers: ((result: unknown) => void)[] = []
    const uploadDocument = vi.fn(
      () => new Promise((resolve) => resolvers.push(resolve as (result: unknown) => void))
    )
    const baseParams = {
      isDemo: false,
      accessMode: 'MANAGE' as const,
      locale: 'es' as const,
      copy: VDR_COPY.es,
      uploadDocument: uploadDocument as never,
    }
    const { result, rerender } = renderHook(
      ({ companyId }: { companyId: string }) => useCompanyVdr({ ...baseParams, companyId }),
      { initialProps: { companyId: 'company-1' } }
    )

    await startSingleUpload(result, { _id: 'document-a', name: 'A.pdf', folder: 'legal' }, 'a.pdf')
    let firstUpload: Promise<unknown> | undefined
    act(() => {
      firstUpload = result.current.handleUpload()
    })

    await act(async () => {
      rerender({ companyId: 'company-2' })
    })

    await startSingleUpload(
      result,
      { _id: 'document-b', name: 'B.pdf', folder: 'operations' },
      'b.pdf'
    )
    act(() => {
      void result.current.handleUpload()
    })
    toastError.mockClear()
    toastSuccess.mockClear()

    await act(async () => {
      resolvers[0]({
        ok: false,
        code: 'REGISTRATION_UNCERTAIN',
        reconciliationRequired: true,
        fileSha256: 'sha-a',
      })
      await firstUpload
    })

    expect(uploadDocument).toHaveBeenCalledTimes(2)
    expect(result.current.singleUploadReconciliationRequired).toBe(false)
    expect(result.current.docName).toBe('B.pdf')
    expect(result.current.selectedFile?.name).toBe('b.pdf')
    expect(result.current.isUploading).toBe(true)
    expect(result.current.uploadDialogOpen).toBe(true)
    expect(toastError).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  // Un link viejo con `room=deal:<id>` sigue circulando. La sala es una por
  // empresa: la URL retirada no puede abrir otro scope ni colar un `dealId` en
  // la consulta.
  it('queries the exact COMPANY shape even from a retired room URL', async () => {
    searchParams = new URLSearchParams('room=deal:deal-1&view=documents')
    const { result } = renderVdr()

    await act(async () => {})

    expect(result.current.activeRoom).toEqual({ kind: 'COMPANY', id: 'company' })
    const lastArgs = mockUseQuery.mock.lastCall?.[1]
    expect(lastArgs).toStrictEqual({ companyId: 'company-1' })
    expect(lastArgs).not.toHaveProperty('dealId')
    expect(mockUseQuery.mock.calls.some(([, args]) => args === 'skip')).toBe(false)
  })

  it('retains the existing 20-file queue policy without starting uploads', () => {
    const uploadDocument = vi.fn()
    const { result } = renderVdr({ isDemo: true, uploadDocument })
    const files = Array.from(
      { length: 22 },
      (_, index) => new File([`${index}`], `${index}.pdf`, { type: 'application/pdf' })
    )

    act(() => {
      expect(result.current.queueForeignFiles(files, 'room_operations')).toEqual({
        status: 'QUEUED',
        targetFolderId: 'room_operations',
        queuedCount: 20,
        droppedOverLimit: 2,
      })
    })

    expect(result.current.uploadQueue).toHaveLength(20)
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('2 archivos exceden el máximo de 20 por tanda.')
  })

  it('rejects foreign drops for read-only rooms and active version replacement', () => {
    const readOnly = renderVdr({ isDemo: true, accessMode: 'READ_ONLY' })
    const file = new File(['one'], 'one.pdf', { type: 'application/pdf' })

    expect(readOnly.result.current.queueForeignFiles([file], 'room_operations')).toEqual({
      status: 'REJECTED',
      reason: 'READ_ONLY',
    })

    const managed = renderVdr({ isDemo: true })
    act(() => {
      managed.result.current.startVersionUpload({
        _id: 'document-a',
        name: 'A.pdf',
        folder: 'legal',
      })
    })
    expect(managed.result.current.queueForeignFiles([file], 'room_operations')).toEqual({
      status: 'REJECTED',
      reason: 'VERSION_REPLACEMENT',
    })
  })

  it('rejects empty, invalid, and in-flight foreign drops at the hook boundary', async () => {
    let finishUpload: ((result: { ok: true; documentId: string }) => void) | undefined
    const uploadDocument = vi.fn(
      () =>
        new Promise<{ ok: true; documentId: string }>((resolve) => {
          finishUpload = resolve
        })
    )
    const { result } = renderVdr({ uploadDocument })
    const first = new File(['one'], 'one.pdf', { type: 'application/pdf' })

    expect(result.current.queueForeignFiles([], 'room_operations')).toEqual({
      status: 'REJECTED',
      reason: 'EMPTY_FILES',
    })
    expect(result.current.queueForeignFiles([first], 'not-a-room')).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_TARGET',
    })
    act(() => {
      result.current.queueForeignFiles([first], 'room_operations')
    })
    let uploadPromise: ReturnType<typeof result.current.handleUpload> | undefined
    act(() => {
      uploadPromise = result.current.handleUpload()
    })

    expect(result.current.queueForeignFiles([first], 'room_operations')).toEqual({
      status: 'REJECTED',
      reason: 'UPLOADING',
    })

    await act(async () => {
      // Mismo chunk aparte: `finishUpload` existe recién cuando la tanda llegó
      // al mapper. El rechazo por `UPLOADING` de arriba ya se afirmó sin él.
      await vi.waitFor(() => expect(finishUpload).toBeDefined())
      finishUpload?.({ ok: true, documentId: 'document-uploaded' })
      await uploadPromise
    })
  })

  it('preserves the full selection when the exact bulk mutation rejects', async () => {
    const { result } = renderVdr()
    act(() => {
      result.current.selectAllFilteredDocuments(['document-a', 'document-b', 'document-noop'], true)
    })
    mockBulkUpdate.mockRejectedValueOnce(new Error('scope changed'))

    let moved: string = 'MOVED'
    await act(async () => {
      moved = await result.current.moveDocuments(['document-a', 'document-b'], 'room_marketing')
    })

    expect(moved).toBe('FAILED')
    expect([...result.current.selectedDocumentIds]).toEqual([
      'document-a',
      'document-b',
      'document-noop',
    ])
    expect(toastError).toHaveBeenCalledWith(
      'No pudimos actualizar la selección. Revisa que todos los documentos sigan en esta sala.'
    )
  })
})
