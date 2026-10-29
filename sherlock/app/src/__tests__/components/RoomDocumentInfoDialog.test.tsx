import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      listVersions: 'documents:listVersions',
    },
  },
}))

import {
  RoomDocumentInfoDialog,
  type RoomDocumentInfoVersionHistory,
  roomSourceLabel,
} from '@/components/documents/shell/RoomDocumentInfoDialog'
import { ROOM_SHELL_COPY } from '@/components/documents/shell/copy'
import type { RoomShellDocument } from '@/lib/documents/room-shell'

const DOCUMENT: RoomShellDocument = {
  id: 'document_financials',
  name: 'Estados financieros 2025.pdf',
  folder: 'room_financial',
  rawFolder: 'room_financial',
  mimeType: 'application/pdf',
  sizeBytes: 4_096,
  versionNumber: 2,
  versionId: 'version_2',
  updatedAt: 1_800_000_000_000,
  accessLevel: 'PRIVATE',
  status: 'READY',
  kind: 'pdf',
  sourceType: 'USER_UPLOAD',
  sourceName: null,
}

const historyAction = (onOpen: (documentId: string) => void): RoomDocumentInfoVersionHistory => ({
  copy: {
    open: 'Historial de versiones',
    unavailable: 'El historial aparece cuando subes tus propios documentos.',
  },
  onOpen,
})

describe('RoomDocumentInfoDialog metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue([])
  })

  it('titles the dialog with the document and lists its metadata behind one explicit action', () => {
    render(
      <RoomDocumentInfoDialog
        copy={ROOM_SHELL_COPY.es}
        locale="es"
        isDemo={false}
        document={DOCUMENT}
        open
        onOpenChange={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: DOCUMENT.name })
    for (const value of [
      '3. Financieros',
      'PDF',
      '4.0 KB',
      'v2',
      'Privado',
      'Revisado y publicado en el Data Room',
    ]) {
      expect(screen.getByText(value), value).toBeVisible()
    }
    expect(dialog).toBeVisible()
  })

  it('closes from Cerrar without touching the room behind it', async () => {
    const onOpenChange = vi.fn()
    render(
      <RoomDocumentInfoDialog
        copy={ROOM_SHELL_COPY.es}
        locale="es"
        isDemo={false}
        document={DOCUMENT}
        open
        onOpenChange={onOpenChange}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('RoomDocumentInfoDialog version history action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue([])
  })

  it('opens history for the exact document it describes', async () => {
    const onOpen = vi.fn()
    render(
      <RoomDocumentInfoDialog
        copy={ROOM_SHELL_COPY.es}
        locale="es"
        isDemo={false}
        document={DOCUMENT}
        open
        onOpenChange={vi.fn()}
        versionHistory={historyAction(onOpen)}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Historial de versiones' }))

    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith('document_financials')
    expect(mockUseQuery).toHaveBeenCalledWith('documents:listVersions', {
      documentId: 'document_financials',
    })
  })

  it('skips the versions query and exposes the caller-owned reason when demo history is disabled', () => {
    const onOpen = vi.fn()
    render(
      <RoomDocumentInfoDialog
        copy={ROOM_SHELL_COPY.es}
        locale="es"
        isDemo
        document={DOCUMENT}
        open
        onOpenChange={vi.fn()}
        versionHistory={historyAction(onOpen)}
      />
    )

    const action = screen.getByRole('button', { name: 'Historial de versiones' })
    expect(action).toBeDisabled()
    expect(action).toHaveAccessibleDescription(
      'El historial aparece cuando subes tus propios documentos.'
    )
    expect(mockUseQuery).toHaveBeenCalledWith('documents:listVersions', 'skip')
    expect(onOpen).not.toHaveBeenCalled()
  })
})

// La procedencia sale del campo `sourceType`. Adivinarla por el nombre del
// archivo etiquetaba como Mycroft cualquier documento del cliente que llevara
// esa palabra, y como «subido por la empresa» todo entregable del equipo cuyo
// nombre no la llevara.
describe('RoomDocumentInfoDialog provenance', () => {
  const copy = ROOM_SHELL_COPY.es

  it('reads the team deliverable from the field, never from the file name', () => {
    expect(roomSourceLabel({ ...DOCUMENT, sourceType: 'TEAM_DELIVERABLE' }, copy)).toBe(
      copy.sourceMycroft
    )
    expect(
      roomSourceLabel({ ...DOCUMENT, name: 'Modelo v1.xlsx', sourceType: 'TEAM_DELIVERABLE' }, copy)
    ).toBe(copy.sourceMycroft)
    expect(
      roomSourceLabel(
        {
          ...DOCUMENT,
          name: 'mycroft-notas.pdf',
          sourceName: 'Mycroft',
          sourceType: 'USER_UPLOAD',
        },
        copy
      )
    ).toBe(copy.sourceUpload)
    expect(roomSourceLabel({ ...DOCUMENT, sourceType: null }, copy)).toBe(copy.sourceUpload)
    expect(roomSourceLabel({ ...DOCUMENT, sourceType: 'PUBLIC_SOURCE' }, copy)).toBe(
      copy.sourcePublic
    )
    expect(roomSourceLabel({ ...DOCUMENT, sourceType: 'SYNTHETIC_DEMO' }, copy)).toBe(
      copy.sourceDemo
    )
  })

  it('renders the provenance line for a team deliverable', () => {
    mockUseQuery.mockReturnValue([])
    render(
      <RoomDocumentInfoDialog
        copy={copy}
        locale="es"
        isDemo={false}
        document={{ ...DOCUMENT, sourceType: 'TEAM_DELIVERABLE' }}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('room-document-info-provenance')).toHaveTextContent(
      copy.sourceMycroft
    )
  })
})

// La nota del equipo viaja en la versión vigente y sale de la misma query que
// el diálogo de versiones: el cliente la lee junto a la procedencia.
describe('RoomDocumentInfoDialog delivery note', () => {
  const copy = ROOM_SHELL_COPY.es
  const version = (overrides: Record<string, unknown>) => ({
    versionId: 'version_1',
    versionNumber: 1,
    publicationStatus: 'SUPERSEDED',
    byteSize: 2_048,
    createdAt: 1_700_000_000_000,
    publishedAt: 1_700_000_000_000,
    isCurrent: false,
    deliveryNote: null,
    ...overrides,
  })

  it('renders the current version note under the provenance line', () => {
    mockUseQuery.mockReturnValue([
      version({
        versionId: 'version_2',
        versionNumber: 2,
        publicationStatus: 'PUBLISHED',
        isCurrent: true,
        deliveryNote: 'Modelo v1 listo para revisión.',
      }),
      version({ deliveryNote: 'Nota de la v1, ya reemplazada.' }),
    ])
    render(
      <RoomDocumentInfoDialog
        copy={copy}
        locale="es"
        isDemo={false}
        document={DOCUMENT}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByText(copy.deliveryNote)).toBeVisible()
    expect(screen.getByTestId('room-document-info-delivery-note')).toHaveTextContent(
      'Modelo v1 listo para revisión.'
    )
    expect(screen.queryByText('Nota de la v1, ya reemplazada.')).not.toBeInTheDocument()
  })

  it('renders nothing when the current version has no note', () => {
    mockUseQuery.mockReturnValue([
      version({ versionId: 'version_2', versionNumber: 2, isCurrent: true }),
    ])
    render(
      <RoomDocumentInfoDialog
        copy={copy}
        locale="es"
        isDemo={false}
        document={DOCUMENT}
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.queryByTestId('room-document-info-delivery-note')).not.toBeInTheDocument()
    expect(screen.queryByText(copy.deliveryNote)).not.toBeInTheDocument()
  })
})
