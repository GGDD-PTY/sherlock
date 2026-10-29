import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomDocumentMoveOutcome } from '@/lib/documents/room-tree-command-state'

const mockGetDownloadUrl = vi.fn()
const toastInfo = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: toastInfo },
}))

vi.mock('convex/react', () => ({
  useMutation: () => mockGetDownloadUrl,
  useQuery: () => [],
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      getDownloadUrl: 'documents:getDownloadUrl',
      getDocumentAccessGrant: 'documents:getDocumentAccessGrant',
    },
  },
}))

vi.mock('@/components/documents/viewers/DocumentViewer', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/documents/viewers/DocumentViewer')
  >('@/components/documents/viewers/DocumentViewer')

  return {
    ...actual,
    DocumentViewer: (props: {
      versionId: string
      viewUrl: string
      fileName: string
      mimeType: string
      downloadUrl?: string | null
      onRetry?: () => void
    }) => (
      <div
        data-testid="room-document-viewer-stub"
        data-version-id={props.versionId}
        data-view-url={props.viewUrl}
        data-file-name={props.fileName}
        data-mime-type={props.mimeType}
        data-download-url={props.downloadUrl ?? ''}
      >
        {props.onRetry ? (
          <button type="button" onClick={props.onRetry}>
            retry renderer
          </button>
        ) : null}
      </div>
    ),
  }
})

const prefetchXlsxSidecar = vi.hoisted(() => vi.fn())

vi.mock('@/components/documents/viewers/xlsxSidecarPrefetch', () => ({
  prefetchXlsxSidecar,
}))

import { ROOM_SHELL_COPY } from '@/components/documents/shell/copy'
import { RoomShell, type RoomShellNavigationHandle } from '@/components/documents/shell/RoomShell'

const DOCUMENTS = [
  {
    _id: 'document_financials',
    name: 'Estados financieros.pdf',
    folder: 'room_financial',
    fileType: 'application/pdf',
    fileSize: 1_024,
    currentVersionNumber: 2,
    currentVersionId: 'version_current',
    publishedVersionId: 'version_current',
    updatedAt: 1_787_587_200_000,
    lifecycleStatus: 'ACTIVE',
  },
]

function roomSourceDocument(id: string, name: string, folder: string): (typeof DOCUMENTS)[number] {
  return { ...DOCUMENTS[0], _id: id, name, folder }
}

const SIX_DOCUMENTS = [
  roomSourceDocument('document_2025', 'Estados financieros 2025.pdf', 'room_financial'),
  roomSourceDocument('document_cash', 'Flujo de caja.xlsx', 'room_financial'),
  roomSourceDocument('document_contract', 'Contrato material.pdf', 'room_legal'),
  roomSourceDocument('document_pact', 'Pacto social.pdf', 'room_legal'),
  roomSourceDocument('document_board', 'Acta de junta.pdf', 'room_corporate'),
  roomSourceDocument('document_registry', 'Registro público.pdf', 'room_corporate'),
]

function issuedRoomGrant(args: {
  url: string
  action?: 'VIEW' | 'DOWNLOAD'
  versionId?: string
  displayName?: string
  detectedMimeType?: string
}) {
  return {
    allowed: true as const,
    url: args.url,
    action: args.action ?? ('VIEW' as const),
    versionId: args.versionId ?? 'version_current',
    displayName: args.displayName ?? 'Estados financieros.pdf',
    detectedMimeType: args.detectedMimeType ?? 'application/pdf',
  }
}

function StatefulRoomShell({
  documents = DOCUMENTS,
}: {
  documents?: typeof DOCUMENTS
} = {}) {
  const [search, setSearch] = useState('')

  return (
    <RoomShell
      locale="es"
      companyName="SAMPLE_HYDRO"
      documents={documents}
      isDemo
      search={search}
      onSearchChange={setSearch}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onNewVersion={vi.fn()}
      onMove={vi.fn().mockResolvedValue(true)}
      onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
      onRenameDocument={vi.fn().mockResolvedValue(true)}
      onQueueForeignFiles={vi.fn()}
      pendingForeignDrop={null}
      onConfirmForeignDrop={vi.fn()}
      onCancelForeignDrop={vi.fn()}
    />
  )
}

function StatefulRealRoomShell({
  onActiveFolderChange,
}: {
  onActiveFolderChange?: (folder: string) => void
} = {}) {
  const [search, setSearch] = useState('')

  return (
    <RoomShell
      locale="es"
      companyName="SAMPLE_HYDRO"
      documents={DOCUMENTS}
      isDemo={false}
      search={search}
      onSearchChange={setSearch}
      onActiveFolderChange={onActiveFolderChange}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onNewVersion={vi.fn()}
      onMove={vi.fn().mockResolvedValue(true)}
      onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
      onRenameDocument={vi.fn().mockResolvedValue(true)}
      onQueueForeignFiles={vi.fn()}
      pendingForeignDrop={null}
      onConfirmForeignDrop={vi.fn()}
      onCancelForeignDrop={vi.fn()}
    />
  )
}

const BULK_DOCUMENTS = [
  ...DOCUMENTS,
  {
    ...DOCUMENTS[0],
    _id: 'document_contract',
    name: 'Contrato material.pdf',
    folder: 'room_legal',
  },
  {
    ...DOCUMENTS[0],
    _id: 'document_board',
    name: 'Acta de junta.pdf',
    folder: 'room_corporate',
  },
]

const PRIVATE_BULK_DOCUMENTS = BULK_DOCUMENTS.map((document) => ({
  ...document,
  accessLevel: 'PRIVATE',
}))

const MIXED_ACCESS_BULK_DOCUMENTS = BULK_DOCUMENTS.map((document) => ({
  ...document,
  accessLevel: document._id === 'document_financials' ? 'PRIVATE' : 'NDA_REQUIRED',
}))

// Una entrega del equipo no la borra el cliente: el servidor rechaza el lote
// entero, así que la sala la nombra antes de confirmar.
const TEAM_DELIVERABLE_BULK_DOCUMENTS = BULK_DOCUMENTS.map((document) =>
  document._id === 'document_contract'
    ? { ...document, name: 'Presentación de management.pdf', sourceType: 'TEAM_DELIVERABLE' }
    : document
)

function StatefulBulkRoomShell({
  initialSelectedIds = [],
  isUpdating = false,
  documents = BULK_DOCUMENTS,
  locale = 'es',
}: {
  initialSelectedIds?: readonly string[]
  isUpdating?: boolean
  documents?: typeof BULK_DOCUMENTS
  locale?: 'es'
}) {
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds)
  )
  const updateMany = (documentIds: readonly string[], selected: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const documentId of documentIds) {
        if (selected) next.add(documentId)
        else next.delete(documentId)
      }
      return next
    })

  return (
    <RoomShell
      locale={locale}
      companyName="SAMPLE_HYDRO"
      documents={documents}
      isDemo
      search={search}
      onSearchChange={setSearch}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onNewVersion={vi.fn()}
      onMove={vi.fn().mockResolvedValue(true)}
      onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
      onRenameDocument={vi.fn().mockResolvedValue(true)}
      onQueueForeignFiles={vi.fn()}
      pendingForeignDrop={null}
      onConfirmForeignDrop={vi.fn()}
      onCancelForeignDrop={vi.fn()}
      bulkSelection={{
        selectedIds,
        isUpdating,
        onToggle: (documentId, selected) => updateMany([documentId], selected),
        onSelectMany: updateMany,
        onClear: () => setSelectedIds(new Set()),
        onMove: vi.fn().mockResolvedValue('MOVED'),
        onChangeDisclosure: vi.fn().mockResolvedValue(true),
        onArchive: vi.fn().mockResolvedValue(true),
      }}
    />
  )
}

type BulkActionResult = 'success' | 'false' | 'reject' | 'noop'

function BulkDialogHarness({ result = 'success' }: { result?: BulkActionResult }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(['document_financials'])
  )
  const [isUpdating, setIsUpdating] = useState(false)
  const runAction = async () => {
    if (result === 'reject') throw new Error('rejected bulk action')
    if (result === 'false') return false
    setSelectedIds(new Set())
    return true
  }
  const runMove = async (): Promise<RoomDocumentMoveOutcome> => {
    if (result === 'reject') throw new Error('rejected bulk action')
    if (result === 'false') return 'FAILED'
    if (result === 'noop') return 'NOOP'
    setSelectedIds(new Set())
    return 'MOVED'
  }

  return (
    <>
      <button type="button" onClick={() => setIsUpdating(true)}>
        mark updating
      </button>
      <output data-testid="bulk-ledger">{[...selectedIds].join(',') || 'none'}</output>
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={BULK_DOCUMENTS}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
        bulkSelection={{
          selectedIds,
          isUpdating,
          onToggle: vi.fn(),
          onSelectMany: vi.fn(),
          onClear: () => setSelectedIds(new Set()),
          onMove: runMove,
          onChangeDisclosure: runAction,
          onArchive: runAction,
        }}
      />
    </>
  )
}

// «Mover documentos» abre sin destino elegido: confirmar exige escoger uno.
async function chooseBulkDestination(label = '1. Legales') {
  await userEvent.click(screen.getByRole('combobox', { name: 'Carpeta de destino' }))
  await userEvent.click(screen.getByRole('option', { name: label }))
}

const WINDOW_DOCUMENTS = Array.from({ length: 51 }, (_, index) => ({
  ...DOCUMENTS[0],
  _id: `window-document-${index}`,
  name: `Window document ${String(index).padStart(2, '0')}.pdf`,
  folder: 'room_legal',
}))

function ExactVersionCitation({
  navigationRef,
}: {
  navigationRef: RefObject<RoomShellNavigationHandle | null>
}) {
  return (
    <>
      <button
        type="button"
        onClick={() =>
          navigationRef.current?.openSource({
            documentId: 'document_financials' as never,
            versionId: 'version_cited' as never,
            navigate: { page: 12 },
          })
        }
      >
        open exact citation
      </button>
      <button
        type="button"
        onClick={() =>
          navigationRef.current?.openSource({
            documentId: 'document_absent' as never,
            versionId: 'version_absent' as never,
          })
        }
      >
        open missing citation
      </button>
    </>
  )
}

function RoomWithCitation() {
  const navigationRef = useRef<RoomShellNavigationHandle | null>(null)
  return (
    <RoomShell
      navigationRef={navigationRef}
      locale="es"
      companyName="SAMPLE_HYDRO"
      documents={DOCUMENTS}
      isDemo={false}
      search=""
      onSearchChange={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onNewVersion={vi.fn()}
      onMove={vi.fn().mockResolvedValue(true)}
      onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
      onRenameDocument={vi.fn().mockResolvedValue(true)}
      onQueueForeignFiles={vi.fn()}
      pendingForeignDrop={null}
      onConfirmForeignDrop={vi.fn()}
      onCancelForeignDrop={vi.fn()}
      coverActions={<ExactVersionCitation navigationRef={navigationRef} />}
    />
  )
}

describe('RoomShell', () => {
  beforeEach(() => {
    mockGetDownloadUrl.mockReset()
  })

  it('renders the foreign-drop conflict and connects confirm and cancel', async () => {
    const onConfirmForeignDrop = vi.fn()
    const onCancelForeignDrop = vi.fn()
    render(
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={DOCUMENTS}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={{
          currentFolderId: 'room_legal',
          targetFolderId: 'room_operations',
        }}
        onConfirmForeignDrop={onConfirmForeignDrop}
        onCancelForeignDrop={onCancelForeignDrop}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Cambiar carpeta de carga' })
    expect(dialog).toHaveTextContent(
      'Ya tienes archivos en 1. Legales. Si continúas, toda la tanda se cargará en 4. Operaciones.'
    )

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cambiar carpeta' }))
    expect(onConfirmForeignDrop).toHaveBeenCalledOnce()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Mantener carpeta actual' }))
    expect(onCancelForeignDrop).toHaveBeenCalledOnce()
  })

  it('opens version history for the selected document from its information dialog', async () => {
    const onOpenVersionHistory = vi.fn()
    render(
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={DOCUMENTS}
        isDemo={false}
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
        onOpenVersionHistory={onOpenVersionHistory}
      />
    )

    await userEvent.click(screen.getByTestId('room-recent-document'))
    await userEvent.click(screen.getByTestId('room-document-info-open'))
    await userEvent.click(screen.getByRole('button', { name: 'Historial de versiones' }))

    expect(onOpenVersionHistory).toHaveBeenCalledOnce()
    expect(onOpenVersionHistory).toHaveBeenCalledWith('document_financials')
    // El historial reemplaza al diálogo: dos capas encima de la ficha no.
    expect(screen.queryByTestId('room-document-info')).not.toBeInTheDocument()
  })

  it('replaces a selected document with no-results and restores it when search clears', async () => {
    render(<StatefulRoomShell />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    expect(screen.getByTestId('room-document-card')).toHaveTextContent('Estados financieros.pdf')

    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar documentos' }), 'ninguno')

    expect(screen.getByTestId('room-center-empty')).toHaveAttribute('data-variant', 'no-results')
    expect(screen.queryByTestId('room-document-card')).not.toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Limpiar búsqueda' })[0])

    expect(screen.getByTestId('room-document-card')).toHaveTextContent('Estados financieros.pdf')
  })

  it('preserves hidden bulk selections, reports the hidden count, clears all, and never opens the viewer', async () => {
    render(<StatefulBulkRoomShell />)

    for (const name of ['Estados financieros.pdf', 'Contrato material.pdf', 'Acta de junta.pdf']) {
      await userEvent.click(screen.getByRole('checkbox', { name: `Seleccionar ${name}` }))
    }

    expect(screen.getByTestId('room-bulk-selection')).toHaveTextContent('3 seleccionados')
    expect(screen.queryByTestId('room-viewer')).not.toBeInTheDocument()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Buscar documentos' }),
      'Estados financieros'
    )
    expect(screen.getByTestId('room-bulk-selection')).toHaveTextContent(
      '3 seleccionados, 2 fuera de esta vista'
    )

    await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
    expect(screen.queryByTestId('room-bulk-selection')).not.toBeInTheDocument()
    expect(screen.queryByTestId('room-viewer')).not.toBeInTheDocument()
  })

  it('counts selections hidden by the 50-row window with truthful view copy', () => {
    render(
      <StatefulBulkRoomShell
        locale="es"
        documents={WINDOW_DOCUMENTS}
        initialSelectedIds={['window-document-50']}
      />
    )

    expect(screen.getByTestId('room-bulk-selection')).toHaveTextContent(
      '1 seleccionado, 1 fuera de esta vista'
    )
  })

  it('opens canonical bulk dialogs and disables every action while updating', async () => {
    const { unmount } = render(
      <StatefulBulkRoomShell initialSelectedIds={['document_financials']} />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    expect(screen.getByRole('dialog', { name: 'Mover documentos' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    await userEvent.click(screen.getByRole('button', { name: 'Divulgación' }))
    expect(screen.getByRole('dialog', { name: 'Cambiar divulgación' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    await userEvent.click(screen.getByRole('button', { name: 'Archivar' }))
    expect(screen.getByRole('alertdialog', { name: '¿Archivar la selección?' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    unmount()

    render(<StatefulBulkRoomShell initialSelectedIds={['document_financials']} isUpdating />)
    for (const name of ['Mover', 'Divulgación', 'Archivar', 'Limpiar']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('preserves selection on cancel, false, or rejection and clears it only on success', async () => {
    const cancelRun = render(<BulkDialogHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Mover documentos' })).not.toBeInTheDocument()
    expect(screen.getByTestId('bulk-ledger')).toHaveTextContent('document_financials')
    cancelRun.unmount()

    const successRun = render(<BulkDialogHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await chooseBulkDestination()
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar movimiento' }))
    await waitFor(() => expect(screen.getByTestId('bulk-ledger')).toHaveTextContent('none'))
    expect(screen.queryByRole('dialog', { name: 'Mover documentos' })).not.toBeInTheDocument()
    successRun.unmount()

    const falseRun = render(<BulkDialogHarness result="false" />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await chooseBulkDestination()
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar movimiento' }))
    expect(screen.getByRole('dialog', { name: 'Mover documentos' })).toBeVisible()
    expect(screen.getByTestId('bulk-ledger')).toHaveTextContent('document_financials')
    falseRun.unmount()

    render(<BulkDialogHarness result="reject" />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await chooseBulkDestination()
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar movimiento' }))
    expect(screen.getByRole('dialog', { name: 'Mover documentos' })).toBeVisible()
    expect(screen.getByTestId('bulk-ledger')).toHaveTextContent('document_financials')
  })

  it('closes the move dialog with localized feedback when nothing has to move', async () => {
    render(<BulkDialogHarness result="noop" />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await chooseBulkDestination('3. Financieros')
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar movimiento' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Mover documentos' })).not.toBeInTheDocument()
    )
    expect(toastInfo).toHaveBeenCalledWith(ROOM_SHELL_COPY.es.bulkMoveNoop)
    expect(screen.getByTestId('bulk-ledger')).toHaveTextContent('document_financials')
  })

  it('opens the move dialog with no destination and confirm turned off', async () => {
    render(<StatefulBulkRoomShell initialSelectedIds={['document_board']} />)

    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))

    const dialog = screen.getByRole('dialog', { name: 'Mover documentos' })
    const destination = within(dialog).getByRole('combobox', { name: 'Carpeta de destino' })
    expect(destination).toHaveTextContent(ROOM_SHELL_COPY.es.bulkDestinationPlaceholder)
    expect(destination).not.toHaveTextContent('1. Legales')
    expect(within(dialog).getByRole('button', { name: 'Confirmar movimiento' })).toBeDisabled()

    await userEvent.click(destination)
    await userEvent.click(screen.getByRole('option', { name: '4. Operaciones' }))

    expect(within(dialog).getByRole('button', { name: 'Confirmar movimiento' })).toBeEnabled()
  })

  it('seeds the disclosure dialog from the selection and keeps confirm off until it changes', async () => {
    render(
      <StatefulBulkRoomShell
        documents={PRIVATE_BULK_DOCUMENTS}
        initialSelectedIds={['document_financials', 'document_contract']}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Divulgación' }))

    const dialog = screen.getByRole('dialog', { name: 'Cambiar divulgación' })
    expect(within(dialog).getByRole('combobox', { name: 'Acceso' })).toHaveTextContent('Privado')
    expect(within(dialog).getByRole('button', { name: 'Confirmar divulgación' })).toBeDisabled()
    expect(
      within(dialog).queryByText(ROOM_SHELL_COPY.es.bulkDeclassifyWarning(2))
    ).not.toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Acceso' }))
    await userEvent.click(screen.getByRole('option', { name: 'NDA de invitado/contraparte' }))

    expect(within(dialog).getByRole('button', { name: 'Confirmar divulgación' })).toBeEnabled()
    expect(within(dialog).getByText(ROOM_SHELL_COPY.es.bulkDeclassifyWarning(2))).toBeVisible()
  })

  it('opens the disclosure dialog with nothing chosen when the selection mixes access levels', async () => {
    render(
      <StatefulBulkRoomShell
        documents={MIXED_ACCESS_BULK_DOCUMENTS}
        initialSelectedIds={['document_financials', 'document_contract']}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Divulgación' }))

    const dialog = screen.getByRole('dialog', { name: 'Cambiar divulgación' })
    expect(within(dialog).getByRole('combobox', { name: 'Acceso' })).toHaveTextContent(
      ROOM_SHELL_COPY.es.bulkAccessPlaceholder
    )
    expect(within(dialog).getByRole('button', { name: 'Confirmar divulgación' })).toBeDisabled()
  })

  it('locks Move and Disclosure dialogs, their selects, and every close path while updating', async () => {
    const moveRun = render(<BulkDialogHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }))
    fireEvent.click(screen.getByText('mark updating'))

    const moveDialog = screen.getByRole('dialog', { name: 'Mover documentos' })
    expect(within(moveDialog).getByRole('combobox', { name: 'Carpeta de destino' })).toBeDisabled()
    expect(within(moveDialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    expect(within(moveDialog).getByRole('button', { name: 'Confirmar movimiento' })).toBeDisabled()
    expect(
      within(moveDialog).queryByRole('button', { name: /cerrar|close/i })
    ).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(moveDialog).toBeVisible()
    fireEvent.pointerDown(document.body)
    expect(moveDialog).toBeVisible()
    moveRun.unmount()

    render(<BulkDialogHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Divulgación' }))
    fireEvent.click(screen.getByText('mark updating'))

    const disclosureDialog = screen.getByRole('dialog', { name: 'Cambiar divulgación' })
    for (const name of ['Acceso', 'Clasificación']) {
      expect(within(disclosureDialog).getByRole('combobox', { name })).toBeDisabled()
    }
    await userEvent.keyboard('{Escape}')
    expect(disclosureDialog).toBeVisible()
  })

  it('keeps the Archive confirmation open across Escape and outside interaction while updating', async () => {
    render(<BulkDialogHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Archivar' }))
    fireEvent.click(screen.getByText('mark updating'))

    const archiveDialog = screen.getByRole('alertdialog', { name: '¿Archivar la selección?' })
    expect(within(archiveDialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    expect(within(archiveDialog).getByRole('button', { name: 'Archivar' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    expect(archiveDialog).toBeVisible()
  })

  it('keeps visible dossier metadata separate from the exact results live region', () => {
    render(<StatefulRoomShell />)

    const coverMetadata = screen.getByTestId('room-cover-metadata')
    expect(coverMetadata).not.toHaveAttribute('role')
    expect(coverMetadata).toHaveTextContent('1 documento')
    expect(coverMetadata).not.toHaveTextContent('Mostrando')

    const results = screen.getByTestId('room-results')
    expect(results).toHaveAttribute('role', 'status')
    expect(results).toHaveClass('sr-only')
    expect(results).toHaveTextContent(/^Mostrando 1 de 1 documento$/)
  })

  it('counts search matches against the unfiltered room total (au-01)', async () => {
    render(<StatefulRoomShell documents={SIX_DOCUMENTS} />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar documentos' }), '2025')

    expect(screen.getByTestId('room-cover-metadata')).toHaveTextContent(
      '1 resultado de 6 documentos'
    )
    expect(screen.getByTestId('room-results')).toHaveTextContent(/^Mostrando 1 de 1 resultado$/)
  })

  it('distinguishes a folder without matches from an empty folder (au-01)', async () => {
    render(<StatefulRoomShell documents={SIX_DOCUMENTS} />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar documentos' }), '2025')

    expect(screen.getAllByText('Sin coincidencias en esta carpeta').length).toBeGreaterThan(0)
    expect(
      screen.queryByText('Suelta aquí un contrato con un cliente, un proveedor o un banco.')
    ).not.toBeInTheDocument()
  })

  it('keeps the unfiltered document count on the cover without a search (au-01)', () => {
    render(<StatefulRoomShell documents={SIX_DOCUMENTS} />)

    expect(screen.getByTestId('room-cover-metadata')).toHaveTextContent('6 documentos')
    expect(screen.getByTestId('room-results')).toHaveTextContent(/^Mostrando 6 de 6 documentos$/)
  })

  it('tells the client when a folder match sits below the loaded window (au-01)', () => {
    const documents = [
      ...Array.from({ length: 55 }, (_, index) =>
        roomSourceDocument(
          `legal-${index}`,
          `Legal ${String(index).padStart(2, '0')}.pdf`,
          'room_legal'
        )
      ),
      roomSourceDocument('financial-below', 'Estados financieros 2025.pdf', 'room_financial'),
      ...Array.from({ length: 4 }, (_, index) =>
        roomSourceDocument(`ops-${index}`, `Ops ${index}.pdf`, 'room_operations')
      ),
    ]
    render(<StatefulRoomShell documents={documents} />)

    const financialCount = document.querySelector(
      '[data-testid="room-folder-count"][data-folder="room_financial"]'
    )
    expect(financialCount).toHaveTextContent('1')
    expect(screen.getByText('1 documento más abajo: carga más para verlo.')).toBeInTheDocument()
    expect(
      screen.queryByText('Suelta aquí los estados financieros de los últimos 3 a 5 años.')
    ).not.toBeInTheDocument()
  })

  it('opens an exact citation through the navigation handle at its cited version and page', async () => {
    mockGetDownloadUrl
      .mockResolvedValueOnce(
        issuedRoomGrant({
          url: '/api/documents/access/grant_exact?token=fresh',
          versionId: 'version_cited',
        })
      )
      .mockResolvedValueOnce(
        issuedRoomGrant({
          url: '/api/documents/access/grant_download?token=fresh',
          action: 'DOWNLOAD',
          versionId: 'version_cited',
        })
      )
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByRole('button', { name: 'open exact citation' }))

    expect(mockGetDownloadUrl).toHaveBeenCalledTimes(1)
    expect(mockGetDownloadUrl).toHaveBeenCalledWith({
      documentId: 'document_financials',
      versionId: 'version_cited',
      action: 'VIEW',
    })
    expect(await screen.findByTestId('room-document-viewer-stub')).toHaveAttribute(
      'data-version-id',
      'version_cited'
    )
    expect(screen.getByTestId('room-viewer')).toHaveAttribute('data-navigate-page', '12')

    await userEvent.click(screen.getByTestId('room-viewer-download'))
    expect(mockGetDownloadUrl).toHaveBeenLastCalledWith({
      documentId: 'document_financials',
      versionId: 'version_cited',
      action: 'DOWNLOAD',
    })

    await userEvent.click(screen.getByTestId('room-viewer-close'))
    expect(screen.queryByTestId('room-viewer')).not.toBeInTheDocument()
  })

  it('renders exact historical CSV metadata instead of the current PDF row metadata', async () => {
    mockGetDownloadUrl.mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_csv?token=historical',
      action: 'VIEW',
      versionId: 'version_cited',
      displayName: 'historical-evidence.csv',
      detectedMimeType: 'text/csv',
    })
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByRole('button', { name: 'open exact citation' }))

    const viewer = await screen.findByTestId('room-document-viewer-stub')
    expect(viewer).toHaveAttribute('data-file-name', 'historical-evidence.csv')
    expect(viewer).toHaveAttribute('data-mime-type', 'text/csv')
    expect(viewer).toHaveAttribute('data-version-id', 'version_cited')
    expect(viewer).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_csv?token=historical&disposition=inline'
    )
  })

  it('renders an exact historical non-previewable response as download', async () => {
    mockGetDownloadUrl.mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_zip?token=historical',
      action: 'DOWNLOAD',
      versionId: 'version_cited',
      displayName: 'historical-package.zip',
      detectedMimeType: 'application/zip',
    })
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByRole('button', { name: 'open exact citation' }))

    const viewer = await screen.findByTestId('room-document-viewer-stub')
    expect(viewer).toHaveAttribute('data-file-name', 'historical-package.zip')
    expect(viewer).toHaveAttribute('data-mime-type', 'application/zip')
    expect(viewer).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_zip?token=historical'
    )
    expect(viewer).toHaveAttribute(
      'data-download-url',
      '/api/documents/access/grant_zip?token=historical'
    )
  })

  it('requests a fresh grant when the mounted renderer retries', async () => {
    mockGetDownloadUrl
      .mockResolvedValueOnce(
        issuedRoomGrant({ url: '/api/documents/access/grant_consumed?token=old' })
      )
      .mockResolvedValueOnce(
        issuedRoomGrant({ url: '/api/documents/access/grant_fresh?token=new' })
      )
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    await userEvent.click(screen.getByRole('button', { name: 'Abrir: Estados financieros.pdf' }))
    expect(await screen.findByTestId('room-document-viewer-stub')).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_consumed?token=old&disposition=inline'
    )

    await userEvent.click(screen.getByRole('button', { name: 'retry renderer' }))

    expect(mockGetDownloadUrl).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('room-document-viewer-stub')).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_fresh?token=new&disposition=inline'
    )
  })

  it('shows a non-disclosing failure when an exact cited version is unavailable', async () => {
    mockGetDownloadUrl.mockResolvedValue(null)
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByRole('button', { name: 'open exact citation' }))

    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('No pudimos preparar el documento. Intenta de nuevo.')
    expect(failure).not.toHaveTextContent('version_cited')
  })

  it('shows the safe unavailable-version failure when a cited document is absent', async () => {
    render(<RoomWithCitation />)

    await userEvent.click(screen.getByRole('button', { name: 'open missing citation' }))

    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('No pudimos preparar el documento. Intenta de nuevo.')
    expect(failure).not.toHaveTextContent('document_absent')
    expect(failure).not.toHaveTextContent('version_absent')
    expect(mockGetDownloadUrl).not.toHaveBeenCalled()
  })

  // Tras el await del grant Safari/iOS tratan window.open como popup y lo
  // bloquean en silencio (soporte SAMPLE_HYDRO 2026-08-27). El helper de entrega ya
  // pinnea el mecanismo; este test pinnea que la sala lo usa.
  it('delivers a DOWNLOAD grant through an anchor click instead of window.open', async () => {
    mockGetDownloadUrl.mockResolvedValue(
      issuedRoomGrant({
        url: '/api/documents/access/grant_dl?token=tok',
        action: 'DOWNLOAD',
      })
    )
    const originalOpen = window.open
    const openSpy = vi.fn()
    window.open = openSpy as unknown as typeof window.open
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    try {
      render(<StatefulRealRoomShell />)
      await userEvent.click(screen.getByTestId('room-recent-document'))
      await userEvent.click(
        screen.getByRole('button', { name: 'Descargar: Estados financieros.pdf' })
      )

      await waitFor(() => {
        expect(mockGetDownloadUrl).toHaveBeenCalledWith({
          documentId: 'document_financials',
          versionId: 'version_current',
          action: 'DOWNLOAD',
        })
      })
      expect(openSpy).not.toHaveBeenCalled()
      expect(click).toHaveBeenCalledTimes(1)
    } finally {
      window.open = originalOpen
      click.mockRestore()
    }
  })

  it('discards an open one-use viewer when filtering hides its selected document', async () => {
    mockGetDownloadUrl.mockResolvedValue(
      issuedRoomGrant({ url: '/api/documents/access/grant_consumed?token=once' })
    )
    render(<StatefulRealRoomShell />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    await userEvent.click(screen.getByRole('button', { name: 'Abrir: Estados financieros.pdf' }))
    expect(await screen.findByTestId('room-document-viewer-stub')).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_consumed?token=once&disposition=inline'
    )

    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar documentos' }), 'ninguno')
    expect(screen.getByTestId('room-center-empty')).toHaveAttribute('data-variant', 'no-results')
    expect(screen.queryByTestId('room-viewer')).not.toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Limpiar búsqueda' })[0])

    expect(screen.getByTestId('room-document-card')).toHaveTextContent('Estados financieros.pdf')
    expect(screen.queryByTestId('room-viewer')).not.toBeInTheDocument()
    expect(mockGetDownloadUrl).toHaveBeenCalledTimes(1)
  })

  // La portada afirma cosas sobre la transacción del cliente. Un mandato que
  // nadie eligió no puede aparecer ahí como si lo hubiera elegido — y tampoco
  // se rellena con un estado de acceso: «Sala activa» contradecía a «Sin
  // activar» en la misma pantalla (auditoría 2026-09-06, F07).
  it('keeps the cover mandate neutral when the client never declared one', () => {
    render(<StatefulRoomShell />)

    expect(screen.queryByTestId('room-cover-mandate')).not.toBeInTheDocument()
    expect(screen.queryByText('Sala activa')).not.toBeInTheDocument()
    expect(screen.getByTestId('room-cover-metadata')).toBeInTheDocument()
  })

  it('does not count optional folders as missing; it names them apart', () => {
    render(<StatefulRoomShell />)

    const missing = screen.getByTestId('room-center-missing')
    expect(missing).not.toHaveTextContent('Operaciones')
    expect(missing).not.toHaveTextContent('mercadeo')
    expect(screen.getByTestId('room-center-optional')).toHaveTextContent(
      'Opcional por ahora: 4. Operaciones y 5. Materiales de mercadeo.'
    )
  })

  it('names the declared mandate when there is one', () => {
    render(
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        companyMandate="DEBT"
        documents={DOCUMENTS}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
      />
    )

    expect(screen.getByTestId('room-cover-mandate')).toHaveTextContent('Mandato de deuda')
  })

  it('treats an UNSET mandate exactly like an absent one', () => {
    render(
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        companyMandate="UNSET"
        documents={DOCUMENTS}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
      />
    )

    expect(screen.queryByTestId('room-cover-mandate')).not.toBeInTheDocument()
  })

  // La metadata del documento se pide por documento ([F] 2026-09-07): el panel
  // derecho salió de la sala y «Información» la abre sobre la ficha.
  it('opens the document metadata in a dialog from the Información action', async () => {
    render(<StatefulRoomShell />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    expect(screen.queryByTestId('room-document-info')).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Información: Estados financieros.pdf' })
    )

    const info = screen.getByRole('dialog', { name: 'Estados financieros.pdf' })
    expect(within(info).getByTestId('room-document-info-provenance')).toHaveTextContent(
      'Subido por la empresa'
    )
    for (const value of ['3. Financieros', 'PDF', '1.0 KB', 'v2', 'NDA']) {
      expect(within(info).getByText(value), value).toBeVisible()
    }

    await userEvent.click(within(info).getByRole('button', { name: 'Cerrar' }))

    expect(screen.queryByTestId('room-document-info')).not.toBeInTheDocument()
  })

  // Al angostar el árbol, el tamaño baja debajo del nombre en vez de
  // desaparecer: antes se ocultaba por ancho de VENTANA, que no tiene nada que
  // ver con lo angosto que esté el panel.
  it('keeps the files tree in a relative overflow panel so the page does not grow with the rows', () => {
    render(<StatefulRoomShell />)

    const region = screen.getByTestId('room-tree-region')
    expect(region.className).toContain('relative')
    expect(region.className).toContain('overflow-y-auto')
    expect(screen.getByTestId('vdr-room-shell').className).toContain('lg:h-full')
    expect(screen.getByTestId('vdr-room-shell').className).toContain('lg:overflow-hidden')
    expect(screen.getByTestId('room-files-sidebar').className).toContain('lg:overflow-hidden')
    expect(screen.getByTestId('room-files-sidebar').className).toContain('lg:h-full')
  })

  it('always shows the file size in the tree, whatever the window width', () => {
    render(<StatefulRoomShell />)

    expect(screen.getByTestId('room-file')).toHaveTextContent('1.0 KB')
  })

  it('hides the zip export in the demo room', () => {
    render(<StatefulRoomShell />)
    expect(screen.queryByTestId('room-zip-export')).not.toBeInTheDocument()
  })

  it('keeps the cover toolbar on one row from xl when both zip buttons are present', async () => {
    render(<StatefulRealRoomShell />)

    await userEvent.click(screen.getByTestId('room-file'))

    expect(screen.getByTestId('room-zip-export')).toBeInTheDocument()
    expect(screen.getByTestId('room-folder-zip-export')).toBeInTheDocument()

    const toolbar = screen.getByTestId('room-cover-toolbar')
    expect(toolbar.className).toContain('xl:flex-nowrap')

    const search = within(toolbar).getByRole('textbox', { name: ROOM_SHELL_COPY.es.search })
    expect(search.className).toContain('xl:flex-1')
    expect(search.className).toContain('xl:min-w-40')
  })

  it('offers the folder zip only once the client stands on a folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala-SAMPLE_HYDRO.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:folder-zip')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      render(<StatefulRealRoomShell />)
      expect(screen.queryByTestId('room-folder-zip-export')).not.toBeInTheDocument()

      await userEvent.click(screen.getByTestId('room-file'))
      await userEvent.click(screen.getByTestId('room-folder-zip-export'))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/vdr/export?locale=es&folder=room_financial', {
          method: 'GET',
          credentials: 'same-origin',
        })
      })
    } finally {
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('hides the folder zip in the demo room', async () => {
    render(<StatefulRoomShell />)

    await userEvent.click(screen.getByTestId('room-file'))

    expect(screen.queryByTestId('room-folder-zip-export')).not.toBeInTheDocument()
  })

  it('reports the folder of the document the client just selected', async () => {
    const onActiveFolderChange = vi.fn()
    render(<StatefulRealRoomShell onActiveFolderChange={onActiveFolderChange} />)

    await userEvent.click(screen.getByTestId('room-file'))

    expect(onActiveFolderChange).toHaveBeenCalledWith('room_financial')
  })

  it('downloads the room zip from the live header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala-SAMPLE_HYDRO.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:room-zip')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      render(<StatefulRealRoomShell />)
      await userEvent.click(screen.getByTestId('room-zip-export'))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/vdr/export?locale=es', {
          method: 'GET',
          credentials: 'same-origin',
        })
      })
    } finally {
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

describe('RoomShell prefetch del sidecar Mog', () => {
  const SPREADSHEET = {
    ...DOCUMENTS[0],
    _id: 'document_model',
    name: 'Modelo financiero.xlsx',
    fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }

  function shell(documents: typeof DOCUMENTS, isDemo: boolean) {
    return (
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={documents}
        isDemo={isDemo}
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
      />
    )
  }

  beforeEach(() => {
    prefetchXlsxSidecar.mockClear()
  })

  it('calienta la cache del sidecar en cuanto la sala lista una hoja de calculo', () => {
    render(shell([...DOCUMENTS, SPREADSHEET], false))

    expect(prefetchXlsxSidecar).toHaveBeenCalledTimes(1)
  })

  it('no baja 18 MB si la sala no tiene ningun libro', () => {
    render(shell(DOCUMENTS, false))

    expect(prefetchXlsxSidecar).not.toHaveBeenCalled()
  })

  it('en la demo sin bytes no hay visor que calentar', () => {
    render(shell([...DOCUMENTS, SPREADSHEET], true))

    expect(prefetchXlsxSidecar).not.toHaveBeenCalled()
  })

  // Red de seguridad: si el cliente llegó al documento antes de que el efecto
  // de la lista corriera, apuntar «Abrir» ya empieza a bajar el sidecar.
  it('calienta la cache al apuntar el boton Abrir de un libro', async () => {
    render(shell([...DOCUMENTS, SPREADSHEET], false))

    await userEvent.click(screen.getByRole('button', { name: /Modelo financiero/ }))
    prefetchXlsxSidecar.mockClear()
    await userEvent.hover(screen.getByRole('button', { name: `Abrir: ${SPREADSHEET.name}` }))

    expect(prefetchXlsxSidecar).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// BORRADO PERMANENTE
// ============================================================================
// «Archivar» saca el documento de la sala y conserva los bytes; «Borrar» los
// destruye. Por eso la fila nunca llama al manejador de golpe: abre una
// confirmación que nombra el documento y dice qué se pierde. Sin `onPurge` la
// sala no ofrece la acción (demo de solo lectura), y «Archivar» sigue igual.
// ============================================================================
describe('RoomShell borrado permanente', () => {
  function PurgeRoomShell({ onPurge }: { onPurge?: (documentId: string) => void }) {
    return (
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={DOCUMENTS}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onPurge={onPurge}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
      />
    )
  }

  function BulkPurgeRoomShell({
    onPurge,
    selectedIds = ['document_financials', 'document_contract'],
    documents = BULK_DOCUMENTS,
  }: {
    onPurge: () => Promise<boolean>
    selectedIds?: readonly string[]
    documents?: typeof BULK_DOCUMENTS
  }) {
    return (
      <RoomShell
        locale="es"
        companyName="SAMPLE_HYDRO"
        documents={documents}
        isDemo
        search=""
        onSearchChange={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onNewVersion={vi.fn()}
        onMove={vi.fn().mockResolvedValue(true)}
        onMoveDocuments={vi.fn().mockResolvedValue('MOVED')}
        onRenameDocument={vi.fn().mockResolvedValue(true)}
        onQueueForeignFiles={vi.fn()}
        pendingForeignDrop={null}
        onConfirmForeignDrop={vi.fn()}
        onCancelForeignDrop={vi.fn()}
        bulkSelection={{
          selectedIds: new Set(selectedIds),
          isUpdating: false,
          onToggle: vi.fn(),
          onSelectMany: vi.fn(),
          onClear: vi.fn(),
          onMove: vi.fn().mockResolvedValue('MOVED'),
          onChangeDisclosure: vi.fn().mockResolvedValue(true),
          onArchive: vi.fn().mockResolvedValue(true),
          onPurge,
        }}
      />
    )
  }

  it('abre la confirmación de la fila y sólo entonces borra', async () => {
    const onPurge = vi.fn()
    render(<PurgeRoomShell onPurge={onPurge} />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    await userEvent.click(screen.getByRole('button', { name: 'Borrar: Estados financieros.pdf' }))

    const dialog = screen.getByRole('alertdialog', { name: '¿Borrar «Estados financieros.pdf»?' })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveTextContent(
      'Se borra de forma permanente con todas sus versiones. No se puede deshacer.'
    )
    expect(onPurge).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Borrar' }))

    expect(onPurge).toHaveBeenCalledWith('document_financials')
  })

  it('no borra nada si se cancela la confirmación', async () => {
    const onPurge = vi.fn()
    render(<PurgeRoomShell onPurge={onPurge} />)

    await userEvent.click(screen.getByTestId('room-recent-document'))
    await userEvent.click(screen.getByRole('button', { name: 'Borrar: Estados financieros.pdf' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onPurge).not.toHaveBeenCalled()
  })

  it('no ofrece borrar cuando la sala no trae el manejador', async () => {
    render(<PurgeRoomShell />)

    await userEvent.click(screen.getByTestId('room-recent-document'))

    expect(
      screen.getByRole('button', { name: 'Archivar: Estados financieros.pdf' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Borrar: Estados financieros.pdf' })
    ).not.toBeInTheDocument()
  })

  it('confirma el borrado del lote desde la barra de selección', async () => {
    const onPurge = vi.fn().mockResolvedValue(true)
    render(<BulkPurgeRoomShell onPurge={onPurge} />)

    await userEvent.click(
      within(screen.getByTestId('room-bulk-selection')).getByRole('button', {
        name: 'Borrar',
      })
    )

    const dialog = screen.getByRole('alertdialog', { name: '¿Borrar 2 documentos?' })
    expect(dialog).toBeVisible()
    expect(onPurge).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Borrar' }))

    expect(onPurge).toHaveBeenCalledTimes(1)
  })

  it('nombra la entrega del equipo y apaga el confirmar del lote', async () => {
    const onPurge = vi.fn().mockResolvedValue(true)
    render(<BulkPurgeRoomShell onPurge={onPurge} documents={TEAM_DELIVERABLE_BULK_DOCUMENTS} />)

    await userEvent.click(
      within(screen.getByTestId('room-bulk-selection')).getByRole('button', { name: 'Borrar' })
    )

    const dialog = screen.getByRole('alertdialog', { name: '¿Borrar 2 documentos?' })
    expect(dialog).toHaveTextContent(
      ROOM_SHELL_COPY.es.bulkPurgeTeamDeliverable(['Presentación de management.pdf'])
    )
    expect(within(dialog).getByRole('button', { name: 'Borrar' })).toBeDisabled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Borrar' }))
    expect(onPurge).not.toHaveBeenCalled()
  })

  // «¿Borrar 1 documentos?» es lo que salía interpolando el conteo a secas.
  it('nombra el caso de uno solo sin contarlo', async () => {
    render(
      <BulkPurgeRoomShell
        onPurge={vi.fn().mockResolvedValue(true)}
        selectedIds={['document_financials']}
      />
    )

    await userEvent.click(
      within(screen.getByTestId('room-bulk-selection')).getByRole('button', { name: 'Borrar' })
    )

    expect(screen.getByRole('alertdialog', { name: '¿Borrar este documento?' })).toBeVisible()
  })
})
