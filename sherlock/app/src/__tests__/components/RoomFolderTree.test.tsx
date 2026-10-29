import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ROOM_SHELL_COPY } from '@/components/documents/shell/copy'
import { RoomFolderTree } from '@/components/documents/shell/RoomFolderTree'
import type { RoomDocumentMoveOutcome } from '@/lib/documents/room-tree-command-state'
import type { RoomShellDocument } from '@/lib/documents/room-shell'
import { VDR_SHELL_FOLDER_VALUES } from '@/lib/vdr/document-taxonomy'

function roomDocument(
  id: string,
  name: string,
  folder: string,
  overrides: Partial<RoomShellDocument> = {}
): RoomShellDocument {
  return {
    id,
    name,
    folder,
    rawFolder: folder,
    mimeType: 'application/pdf',
    sizeBytes: 1_024,
    versionNumber: 1,
    versionId: `${id}-version`,
    updatedAt: 1_787_587_200_000,
    accessLevel: 'NDA_REQUIRED',
    status: 'READY',
    kind: 'pdf',
    sourceType: 'USER_UPLOAD',
    sourceName: null,
    ...overrides,
  }
}

const DOCUMENTS = [
  roomDocument('document-ethics', 'Ética corporativa.pdf', 'room_legal'),
  roomDocument('document-pact', 'Pacto social.pdf', 'room_legal'),
  roomDocument('document-model', 'Modelo financiero.xlsx', 'room_financial', {
    kind: 'spreadsheet',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 2_048,
    versionNumber: 3,
  }),
]

function totalsFor(documents: readonly RoomShellDocument[]) {
  return Object.fromEntries(
    VDR_SHELL_FOLDER_VALUES.map((folder) => [
      folder,
      documents.filter((document) => document.folder === folder).length,
    ])
  )
}

function ControlledRoomTree({
  documents = DOCUMENTS,
  locale = 'es',
  onOpen = vi.fn(),
  onMoveDocuments = vi.fn().mockResolvedValue('MOVED'),
  onRenameDocument = vi.fn().mockResolvedValue(true),
  onQueueForeignFiles = vi.fn(),
  bulk = false,
  onSelectMany,
}: {
  documents?: readonly RoomShellDocument[]
  locale?: 'es'
  onOpen?: (document: RoomShellDocument) => void
  onMoveDocuments?: (
    documentIds: readonly string[],
    targetFolderId: string
  ) => Promise<RoomDocumentMoveOutcome>
  onRenameDocument?: (documentId: string, nextName: string) => Promise<boolean>
  onQueueForeignFiles?: (files: readonly File[], targetFolderId: string) => void
  bulk?: boolean
  onSelectMany?: (documentIds: readonly string[], selected: boolean) => void
}) {
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(
    () => new Set(VDR_SHELL_FOLDER_VALUES)
  )
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [bulkSelectedIds, setBulkSelectedIds] = useState<ReadonlySet<string>>(() => new Set())

  const toggleMany = (documentIds: readonly string[], selected: boolean) => {
    onSelectMany?.(documentIds, selected)
    setBulkSelectedIds((current) => {
      const next = new Set(current)
      for (const documentId of documentIds) {
        if (selected) next.add(documentId)
        else next.delete(documentId)
      }
      return next
    })
  }

  return (
    <>
      <div data-testid="selected-document">{selectedDocumentId ?? 'none'}</div>
      <div data-testid="bulk-selected-documents">{[...bulkSelectedIds].join(',') || 'none'}</div>
      <RoomFolderTree
        copy={ROOM_SHELL_COPY[locale]}
        locale={locale}
        documents={documents}
        totals={totalsFor(documents)}
        expandedFolders={expandedFolders}
        onToggleFolder={(folder) =>
          setExpandedFolders((current) => {
            const next = new Set(current)
            if (next.has(folder)) next.delete(folder)
            else next.add(folder)
            return next
          })
        }
        selectedDocumentId={selectedDocumentId}
        bulkSelection={
          bulk
            ? {
                selectedIds: bulkSelectedIds,
                isUpdating: false,
                onToggle: (documentId: string, selected: boolean) =>
                  toggleMany([documentId], selected),
                onSelectMany: toggleMany,
                onClear: vi.fn(),
                onMove: vi.fn().mockResolvedValue(true),
                onChangeDisclosure: vi.fn().mockResolvedValue(true),
                onArchive: vi.fn().mockResolvedValue(true),
              }
            : undefined
        }
        actions={{
          onSelect: (document) => setSelectedDocumentId(document.id),
          onOpen,
          onMoveDocuments,
          onRenameDocument,
          onQueueForeignFiles,
        }}
      />
    </>
  )
}

function treeItem(name: string | RegExp) {
  const accessibleName =
    typeof name === 'string' ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : name
  return screen.getByRole('treeitem', { name: accessibleName })
}

function dataTransfer({ files = [], types = [] }: { files?: File[]; types?: string[] } = {}) {
  return {
    files,
    types,
    dropEffect: 'move',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  }
}

describe('RoomFolderTree Headless Tree production contract', () => {
  it('keeps one tab stop and implements the complete APG navigation keys without scrolling', async () => {
    render(<ControlledRoomTree />)

    const tree = screen.getByTestId('room-tree')
    const allItems = within(tree).getAllByRole('treeitem')
    expect(allItems.filter((item) => item.tabIndex === 0)).toHaveLength(1)

    const firstFolder = treeItem('1. Legales')
    const firstFile = treeItem('Ética corporativa.pdf')
    const secondFile = treeItem('Pacto social.pdf')
    firstFolder.focus()

    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(firstFile).toHaveFocus())

    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(secondFile).toHaveFocus())
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(firstFile).toHaveFocus())

    await userEvent.keyboard('{ArrowRight}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(firstFile).toHaveFocus()

    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(firstFolder).toHaveFocus())
    await userEvent.keyboard('{ArrowLeft}')
    expect(firstFolder).toHaveFocus()
    expect(firstFolder).toHaveAttribute('aria-expanded', 'false')

    const keyboardEventWasAllowed = fireEvent.keyDown(firstFolder, {
      key: 'ArrowRight',
      code: 'ArrowRight',
    })
    fireEvent.keyUp(firstFolder, { key: 'ArrowRight', code: 'ArrowRight' })
    expect(keyboardEventWasAllowed).toBe(false)
    await waitFor(() => expect(firstFolder).toHaveAttribute('aria-expanded', 'true'))

    await userEvent.keyboard('{End}')
    await waitFor(() => expect(treeItem('5. Materiales de mercadeo')).toHaveFocus())
    await userEvent.keyboard('{Home}')
    await waitFor(() => expect(firstFolder).toHaveFocus())
  })

  it('expands sibling folders with * and performs accent-insensitive typeahead', async () => {
    render(<ControlledRoomTree />)

    const legal = treeItem('1. Legales')
    const corporate = treeItem('2. Corporativos')
    // Colapsar es el chevrón, no la fila: un click en la carpeta ya solo abre
    // ([F] 2026-09-02, `docs/test-governance.md` -> STALE_TEST).
    await userEvent.click(within(legal).getByTestId('hierarchy-branch-toggle'))
    await userEvent.click(within(corporate).getByTestId('hierarchy-branch-toggle'))
    expect(legal).toHaveAttribute('aria-expanded', 'false')
    expect(corporate).toHaveAttribute('aria-expanded', 'false')

    corporate.focus()
    await userEvent.keyboard('*')
    for (const folder of screen.getAllByTestId('room-folder')) {
      expect(folder).toHaveAttribute('aria-expanded', 'true')
    }

    legal.focus()
    await userEvent.keyboard('e')
    await waitFor(() => expect(treeItem('Ética corporativa.pdf')).toHaveFocus())
  })

  it('selects on one click and opens only through an explicit activation', async () => {
    const onOpen = vi.fn()
    render(<ControlledRoomTree onOpen={onOpen} />)

    const file = treeItem('Modelo financiero.xlsx')
    await userEvent.click(file)

    expect(screen.getByTestId('selected-document')).toHaveTextContent('document-model')
    expect(file).toHaveAttribute('aria-selected', 'true')
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('1 documento seleccionado')

    await userEvent.dblClick(file)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'document-model' }))

    onOpen.mockClear()
    file.focus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'document-model' }))
  })

  it('keeps active row selection separate from the bulk checked set', async () => {
    const onOpen = vi.fn()
    render(<ControlledRoomTree bulk onOpen={onOpen} />)

    const file = treeItem('Modelo financiero.xlsx')
    await userEvent.click(file)

    expect(screen.getByTestId('selected-document')).toHaveTextContent('document-model')
    expect(screen.getByTestId('bulk-selected-documents')).toHaveTextContent('none')
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar Modelo financiero.xlsx' })
    )

    expect(screen.getByTestId('selected-document')).toHaveTextContent('document-model')
    expect(screen.getByTestId('bulk-selected-documents')).toHaveTextContent('document-model')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('computes folder tri-state from loaded eligible children and disables quarantined or archived rows', async () => {
    const documents = [
      roomDocument('eligible-a', 'Contrato A.pdf', 'room_legal'),
      roomDocument('eligible-b', 'Contrato B.pdf', 'room_legal'),
      roomDocument('quarantined', 'Retenido.pdf', 'room_legal', { status: 'QUARANTINED' }),
      roomDocument('archived', 'Archivado.pdf', 'room_legal', { status: 'ARCHIVED' }),
    ]
    render(<ControlledRoomTree bulk documents={documents} />)

    const folderCheckbox = screen.getByRole('checkbox', {
      name: 'Seleccionar documentos cargados de 1. Legales',
    })
    const firstCheckbox = screen.getByRole('checkbox', { name: 'Seleccionar Contrato A.pdf' })

    await userEvent.click(firstCheckbox)
    expect(folderCheckbox).toHaveAttribute('data-state', 'indeterminate')

    await userEvent.click(folderCheckbox)
    expect(folderCheckbox).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('bulk-selected-documents')).toHaveTextContent('eligible-a,eligible-b')
    expect(screen.getByRole('checkbox', { name: /Retenido\.pdf.*cuarentena/i })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Archivado\.pdf.*archivado/i })).toBeDisabled()
  })

  it('sends Ctrl+A and Shift-range through the loaded eligible bulk callback without a UI cap', async () => {
    const documents = Array.from({ length: 51 }, (_, index) =>
      roomDocument(
        `document-${index}`,
        `Documento ${String(index).padStart(2, '0')}.pdf`,
        'room_legal'
      )
    )
    const onSelectMany = vi.fn()
    render(<ControlledRoomTree bulk documents={documents} onSelectMany={onSelectMany} />)

    const first = screen.getByRole('checkbox', { name: 'Seleccionar Documento 00.pdf' })
    const third = screen.getByRole('checkbox', { name: 'Seleccionar Documento 02.pdf' })
    await userEvent.click(first)
    fireEvent.click(third, { shiftKey: true })

    expect(screen.getByTestId('bulk-selected-documents')).toHaveTextContent(
      'document-0,document-1,document-2'
    )

    treeItem('Documento 00.pdf').focus()
    await userEvent.keyboard('{Control>}a{/Control}')

    expect(onSelectMany).toHaveBeenLastCalledWith(
      documents.map((document) => document.id),
      true
    )

    onSelectMany.mockClear()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    expect(onSelectMany).toHaveBeenLastCalledWith(
      documents.map((document) => document.id),
      true
    )
  })

  it('skips disabled rows when Shift-range crosses quarantine', async () => {
    const documents = [
      roomDocument('eligible-a', 'Documento A.pdf', 'room_legal'),
      roomDocument('quarantined', 'Documento B.pdf', 'room_legal', {
        status: 'QUARANTINED',
      }),
      roomDocument('eligible-c', 'Documento C.pdf', 'room_legal'),
    ]
    const onSelectMany = vi.fn()
    render(<ControlledRoomTree bulk documents={documents} onSelectMany={onSelectMany} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar Documento A.pdf' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar Documento C.pdf' }), {
      shiftKey: true,
    })

    expect(onSelectMany).toHaveBeenLastCalledWith(['eligible-a', 'eligible-c'], true)
    expect(screen.getByTestId('bulk-selected-documents')).toHaveTextContent('eligible-a,eligible-c')
    expect(screen.getByRole('checkbox', { name: /Documento B\.pdf.*cuarentena/i })).toBeDisabled()
  })

  it('keeps controlled expansion and focus stable across collapse, filtering and load-more rebuilds', async () => {
    const { rerender } = render(<ControlledRoomTree />)

    const legal = treeItem('1. Legales')
    legal.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(legal).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <ControlledRoomTree
        documents={[...DOCUMENTS, roomDocument('document-extra', 'Anexo legal.pdf', 'room_legal')]}
      />
    )
    await waitFor(() => expect(treeItem('1. Legales')).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByRole('treeitem', { name: 'Anexo legal.pdf' })).not.toBeInTheDocument()
    expect(treeItem('1. Legales')).toHaveFocus()

    await userEvent.keyboard('{ArrowRight}')
    const ethics = treeItem('Ética corporativa.pdf')
    ethics.focus()
    rerender(
      <ControlledRoomTree documents={DOCUMENTS.filter((document) => document !== DOCUMENTS[0])} />
    )

    await waitFor(() => {
      const focused = document.activeElement
      expect(focused).toHaveAttribute('role', 'treeitem')
      expect(focused).toBeInTheDocument()
    })

    const pact = treeItem('Pacto social.pdf')
    pact.focus()
    rerender(
      <ControlledRoomTree
        documents={[
          DOCUMENTS[1],
          DOCUMENTS[2],
          roomDocument('document-loaded', 'Zeta adicional.pdf', 'room_marketing'),
        ]}
      />
    )
    await waitFor(() => expect(treeItem('Pacto social.pdf')).toHaveFocus())
  })

  it('routes an internal single-document drop through the typed move interaction', async () => {
    const onMoveDocuments = vi.fn().mockResolvedValue('MOVED')
    const transfer = dataTransfer()
    render(<ControlledRoomTree onMoveDocuments={onMoveDocuments} />)

    fireEvent.dragStart(treeItem('Modelo financiero.xlsx'), { dataTransfer: transfer })
    fireEvent.dragOver(treeItem('4. Operaciones'), { dataTransfer: transfer })
    fireEvent.drop(treeItem('4. Operaciones'), { dataTransfer: transfer })

    await waitFor(() =>
      expect(onMoveDocuments).toHaveBeenCalledWith(['document-model'], 'room_operations')
    )
  })

  it('moves the checked document group when the dragged row belongs to the bulk selection', async () => {
    const onMoveDocuments = vi.fn().mockResolvedValue('MOVED')
    const transfer = dataTransfer()
    render(<ControlledRoomTree bulk onMoveDocuments={onMoveDocuments} />)

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar Ética corporativa.pdf' })
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar Pacto social.pdf' }))
    fireEvent.dragStart(treeItem('Ética corporativa.pdf'), { dataTransfer: transfer })
    fireEvent.dragOver(treeItem('4. Operaciones'), { dataTransfer: transfer })
    fireEvent.drop(treeItem('4. Operaciones'), { dataTransfer: transfer })

    await waitFor(() =>
      expect(onMoveDocuments).toHaveBeenCalledWith(
        ['document-ethics', 'document-pact'],
        'room_operations'
      )
    )
  })

  it('routes an OS file drop only through the typed foreign-file queue interaction', async () => {
    const onOpen = vi.fn()
    const onMoveDocuments = vi.fn().mockResolvedValue('MOVED')
    const onQueueForeignFiles = vi.fn()
    const files = [new File(['memo'], 'memo.pdf', { type: 'application/pdf' })]
    const transfer = dataTransfer({ files, types: ['Files'] })
    render(
      <ControlledRoomTree
        onOpen={onOpen}
        onMoveDocuments={onMoveDocuments}
        onQueueForeignFiles={onQueueForeignFiles}
      />
    )

    fireEvent.dragOver(treeItem('4. Operaciones'), { dataTransfer: transfer })
    fireEvent.drop(treeItem('4. Operaciones'), { dataTransfer: transfer })

    await waitFor(() => expect(onQueueForeignFiles).toHaveBeenCalledWith(files, 'room_operations'))
    expect(onMoveDocuments).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('routes F2 rename through the typed document rename interaction', async () => {
    const onRenameDocument = vi.fn().mockResolvedValue(true)
    render(<ControlledRoomTree onRenameDocument={onRenameDocument} />)

    const file = treeItem('Pacto social.pdf')
    file.focus()
    fireEvent.keyDown(file, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'Renombrar Pacto social.pdf' })
    fireEvent.change(input, { target: { value: 'Pacto social firmado.pdf' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() =>
      expect(onRenameDocument).toHaveBeenCalledWith('document-pact', 'Pacto social firmado.pdf')
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Documento renombrado: Pacto social firmado.pdf'
    )
  })

  // El caso hermano corría el mismo anuncio en inglés. Retirado el locale, lo
  // que se pinnea es que el anuncio viene del catálogo del llamador y no cae a
  // una cadena inglesa por defecto.
  it('sources assistive announcements from the caller, never from an English default', async () => {
    render(<ControlledRoomTree locale="es" />)

    await userEvent.click(treeItem('Modelo financiero.xlsx'))

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('1 documento seleccionado')
    expect(status).not.toHaveTextContent('1 document selected')
  })
})
