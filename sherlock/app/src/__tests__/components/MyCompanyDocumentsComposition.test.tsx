import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseCompanyVdr = vi.hoisted(() => vi.fn())
const mockPeekHandoff = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'EMPTY' as const, files: [], companyName: null }))
)
const mockAckHandoffFiles = vi.hoisted(() => vi.fn(async () => true))
const mockAckHandoffCompanyName = vi.hoisted(() => vi.fn(async () => true))

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string) => key,
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/my-company/documents',
}))
vi.mock('@/hooks/useDirectVdrUpload', () => ({ useDirectVdrUpload: () => vi.fn() }))
vi.mock('@/lib/mycroft/upload-handoff', () => ({
  peekHandoff: mockPeekHandoff,
  ackHandoffFiles: mockAckHandoffFiles,
  ackHandoffCompanyName: mockAckHandoffCompanyName,
}))
vi.mock('@/components/company/vdr/useCompanyVdr', () => ({ useCompanyVdr: mockUseCompanyVdr }))

vi.mock('@/components/documents/shell/RoomShell', () => ({
  RoomShell: () => <section data-testid="room-shell">Room</section>,
}))

vi.mock('@/components/company/vdr/AdminVdrCapabilityContext', () => ({
  AdminVdrCapabilityProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/components/company/vdr/VdrWorkspaceErrorBoundary', () => ({
  VdrWorkspaceErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
  VdrWorkspaceFailure: () => <div>Workspace failed</div>,
}))
vi.mock('@/components/company/vdr/VdrUploadDialog', () => ({ VdrUploadDialog: () => null }))
vi.mock('@/components/company/vdr/VdrDocumentDialogs', () => ({
  VdrDeleteDialog: () => null,
  VdrEditDialog: () => null,
}))
vi.mock('@/components/company/vdr/VdrDocumentVersionsDialog', () => ({
  VdrDocumentVersionsDialog: () => null,
}))
import { MyCompanyDocumentsClient } from '@/components/company/MyCompanyDocumentsClient'

function vdrState(kind: 'COMPANY' | 'DEAL', documents: Array<Record<string, unknown>> = []) {
  const noop = vi.fn()
  return {
    isLoading: false,
    activeRoom: kind === 'COMPANY' ? { kind, id: 'company' } : { kind, id: 'deal_1' },
    activeRoomTitle: kind === 'COMPANY' ? 'Company library' : 'Growth facility',
    activeView: 'overview',
    activeCategory: 'all',
    search: '',
    documents,
    uploadDialogOpen: false,
    fileInputRef: { current: null },
    selectedFile: null,
    uploadQueue: [],
    allowMultipleUpload: true,
    docName: '',
    folder: 'other',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    isUploading: false,
    singleUploadReconciliationRequired: false,
    replacingDocument: null,
    editOpen: false,
    editing: null,
    editName: '',
    editFolder: 'other',
    editAccess: 'NDA_REQUIRED',
    editExpiresAt: '',
    isSavingEdit: false,
    deleteOpen: false,
    deleting: null,
    isDeleting: false,
    versionHistoryDocument: null,
    selectedDocumentIds: new Set<string>(),
    isBulkUpdating: false,
    changeView: noop,
    changeRoom: noop,
    setUploadDialogOpen: noop,
    queueFiles: noop,
    resetUpload: noop,
    handleFileSelect: noop,
    setDocName: noop,
    setFolder: noop,
    setAccessLevel: noop,
    setClassification: noop,
    stopUploads: noop,
    removeQueuedFile: noop,
    handleUpload: noop,
    setActiveCategory: noop,
    setSearch: noop,
    openDocument: noop,
    beginEdit: noop,
    setDeleting: noop,
    startVersionUpload: noop,
    setVersionHistoryDocument: noop,
    toggleDocumentSelection: noop,
    selectAllFilteredDocuments: noop,
    clearDocumentSelection: noop,
    bulkMoveDocuments: noop,
    bulkChangeDisclosure: noop,
    bulkArchiveDocuments: noop,
    setEditOpen: noop,
    setEditName: noop,
    setEditFolder: noop,
    setEditAccess: noop,
    setEditExpiresAt: noop,
    saveEdit: noop,
    setDeleteOpen: noop,
    deleteDocument: noop,
  }
}

// [F] 2026-08-30 retired these blocks; A8 adds scoped guest access without restoring them.
const RETIRED_BLOCKS = [
  'readiness-ladder',
  'intake-inventory',
  'deliverables-workspace',
  'preparation-processing-status',
]

describe('MyCompanyDocumentsClient composition', () => {
  beforeEach(() => {
    mockUseCompanyVdr.mockReset()
    mockPeekHandoff.mockClear()
    mockAckHandoffFiles.mockClear()
    mockAckHandoffCompanyName.mockClear()
  })

  // La sala es un conjunto de pantallas (docs/design-system-vdr.md): la de
  // documentos es el shell y la barra, nada apilado debajo.
  it('renders the shell alone with the screens the page passes', () => {
    mockUseCompanyVdr.mockReturnValue(vdrState('COMPANY'))

    render(
      <MyCompanyDocumentsClient
        companyId="company_1"
        companyName="Issuer One"
        screens={['documents', 'company', 'preparation', 'team']}
      />
    )

    expect(screen.getByTestId('room-shell')).toBeVisible()
    const nav = screen.getByRole('navigation', { name: 'nav.label' })
    expect(within(nav).getAllByRole('link')).toHaveLength(4)
    expect(within(nav).getByRole('link', { name: 'nav.company' })).toHaveAttribute(
      'href',
      '/my-company/company'
    )
    expect(screen.queryByText('Secure preparation workspace')).not.toBeInTheDocument()
    for (const testId of RETIRED_BLOCKS) {
      expect(screen.queryByTestId(testId), testId).not.toBeInTheDocument()
    }
  })

  it('draws no screens bar when the page passes none (the team sees everything in one page)', () => {
    mockUseCompanyVdr.mockReturnValue(vdrState('COMPANY'))

    render(
      <MyCompanyDocumentsClient
        companyId="company_1"
        companyName="Issuer One"
        adminOperator
        screens={[]}
      />
    )

    expect(screen.getByTestId('room-shell')).toBeVisible()
    expect(screen.queryByRole('navigation', { name: 'nav.label' })).not.toBeInTheDocument()
  })

  it('keeps the shell in a deal room', () => {
    mockUseCompanyVdr.mockReturnValue(vdrState('DEAL'))

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Issuer One" />)

    expect(screen.getByTestId('room-shell')).toBeVisible()
  })

  it('keeps company members on the existing read-only document index', () => {
    mockUseCompanyVdr.mockReturnValue(vdrState('COMPANY'))

    render(
      <MyCompanyDocumentsClient
        companyId="company_1"
        companyName="Issuer One"
        accessMode="READ_ONLY"
        screens={['documents', 'company']}
      />
    )

    expect(screen.getByText('Acceso de solo lectura')).toBeVisible()
    expect(screen.queryByTestId('room-shell')).not.toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'nav.label' })
    expect(within(nav).getAllByRole('link')).toHaveLength(1)
  })

  // O5-04-4: el contenedor de la pantalla recorta a 900 px; el índice de
  // miembro tiene que ser su propio scrollport o las filas de más no se ven.
  it('keeps the read-only index as its own scrollport when the list is long', () => {
    mockUseCompanyVdr.mockReturnValue(
      vdrState(
        'COMPANY',
        Array.from({ length: 40 }, (_, index) => ({
          _id: `doc_${String(index)}`,
          name: `Documento ${String(index)}.pdf`,
          folder: 'room_legal',
          accessLevel: 'NDA_REQUIRED',
        }))
      )
    )

    render(
      <MyCompanyDocumentsClient
        companyId="company_1"
        companyName="Issuer One"
        accessMode="READ_ONLY"
        screens={['documents']}
      />
    )

    const index = screen.getByTestId('member-document-index')
    expect(index.className).toContain('overflow-y-auto')
    expect(index.className).toContain('min-h-0')
    expect(index.className).toContain('flex-1')
    expect(within(index).getAllByRole('listitem')).toHaveLength(40)
  })
})
