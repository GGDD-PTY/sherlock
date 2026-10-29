import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())
const restoreVersion = vi.hoisted(() => vi.fn())
const queryMounts = vi.hoisted(() => ({ current: 0 }))

vi.mock('convex/react', async () => {
  const { useRef } = await import('react')
  return {
    useQuery: (...args: unknown[]) => {
      const isMounted = useRef(false)
      if (!isMounted.current) {
        isMounted.current = true
        queryMounts.current += 1
      }
      return mockUseQuery(...args)
    },
    useMutation: mockUseMutation,
  }
})

describe('VdrDocumentVersionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryMounts.current = 0
    restoreVersion.mockResolvedValue({ restoredVersionId: 'version_3', versionNumber: 3 })
    mockUseMutation.mockReturnValue(restoreVersion)
    mockUseQuery.mockReturnValue([
      {
        versionId: 'version_2',
        versionNumber: 2,
        displayName: 'Modelo financiero',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 2_000_000,
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'NOT_CONFIGURED',
        publicationStatus: 'PUBLISHED',
        createdAt: 1_800_000_000_000,
        publishedAt: 1_800_000_000_000,
        isCurrent: true,
      },
      {
        versionId: 'version_1',
        versionNumber: 1,
        displayName: 'Modelo financiero',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 1_500_000,
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'NOT_CONFIGURED',
        publicationStatus: 'SUPERSEDED',
        createdAt: 1_700_000_000_000,
        publishedAt: 1_700_000_000_000,
        isCurrent: false,
      },
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers retry when document versions do not resolve in 12 seconds', async () => {
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')
    vi.useFakeTimers()
    mockUseQuery.mockImplementation(() => {})

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 2,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('document-versions-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
    const mountsBeforeRetry = queryMounts.current
    fireEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    expect(queryMounts.current).toBeGreaterThan(mountsBeforeRetry)
    expect(screen.queryByTestId('document-versions-load-failure')).not.toBeInTheDocument()
  })

  it('shows integrity evidence and restores old bytes as a new version after confirmation', async () => {
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 2,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('SHA-256 bbbbbbbbbbbbbbbb…')).toBeInTheDocument()
    expect(screen.getByText('Reemplazada')).toBeInTheDocument()
    expect(screen.getAllByText('Antivirus: sin dato').length).toBeGreaterThan(0)
    expect(screen.queryByText('Scan limpio')).not.toBeInTheDocument()
    expect(screen.queryByText(/blob actual/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar como versión nueva' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'El historial actual no se sobrescribe'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar versión' }))

    await waitFor(() => {
      expect(restoreVersion).toHaveBeenCalledWith({
        documentId: 'document_1',
        versionId: 'version_1',
        expectedCurrentVersionNumber: 2,
      })
    })
  })

  // El badge caia al literal crudo del schema para todo lo que no fuera
  // SUPERSEDED: un `DRAFT` en ingles y en mayusculas en las dos caras del sitio.
  // La cuarentena solo la ve un ADMIN, pero sigue siendo texto de cara al
  // usuario y ships en `es` y `en`.
  it('traduce el estado de publicacion en vez de imprimir el literal del schema', async () => {
    mockUseQuery.mockReturnValue([
      {
        versionId: 'version_3',
        versionNumber: 3,
        displayName: 'entregable-sin-firma.bin',
        declaredMimeType: 'application/octet-stream',
        detectedMimeType: 'application/octet-stream',
        byteSize: 1_000,
        sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        signatureKind: 'UNKNOWN',
        verificationStatus: 'QUARANTINED',
        malwareScanStatus: 'PENDING',
        publicationStatus: 'DRAFT',
        createdAt: 1_900_000_000_000,
        publishedAt: undefined,
        isCurrent: false,
      },
    ])
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 2,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('En revisión')).toBeInTheDocument()
    expect(screen.queryByText('DRAFT')).not.toBeInTheDocument()
    expect(screen.getByText('Antivirus: pendiente')).toBeInTheDocument()
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument()
  })

  it('mapea cada estado de antivirus a español y no imprime el literal crudo', async () => {
    mockUseQuery.mockReturnValue([
      {
        versionId: 'version_clean',
        versionNumber: 4,
        displayName: 'Modelo financiero',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 1_000,
        sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        createdAt: 1_900_000_000_000,
        publishedAt: 1_900_000_000_000,
        isCurrent: true,
      },
      {
        versionId: 'version_infected',
        versionNumber: 3,
        displayName: 'Modelo financiero',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 1_000,
        sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'INFECTED',
        publicationStatus: 'SUPERSEDED',
        createdAt: 1_800_000_000_000,
        publishedAt: 1_800_000_000_000,
        isCurrent: false,
      },
      {
        versionId: 'version_failed',
        versionNumber: 2,
        displayName: 'Modelo financiero',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 1_000,
        sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'ERROR',
        publicationStatus: 'SUPERSEDED',
        createdAt: 1_700_000_000_000,
        publishedAt: 1_700_000_000_000,
        isCurrent: false,
      },
    ])
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 4,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('Antivirus: limpio')).toBeInTheDocument()
    expect(screen.getByText('Antivirus: amenaza detectada')).toBeInTheDocument()
    expect(screen.getByText('Antivirus: falló')).toBeInTheDocument()
    expect(screen.queryByText('CLEAN')).not.toBeInTheDocument()
    expect(screen.queryByText('INFECTED')).not.toBeInTheDocument()
    expect(screen.queryByText('ERROR')).not.toBeInTheDocument()
  })

  it('explica el vacío de versionado en tuteo, sin blob', async () => {
    mockUseQuery.mockReturnValue([])
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 1,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('Documento anterior al versionado')).toBeInTheDocument()
    expect(
      screen.getByText('La próxima carga guarda el archivo actual como v1.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Su próxima carga/)).not.toBeInTheDocument()
    expect(screen.queryByText(/blob/)).not.toBeInTheDocument()
  })

  it('no duplica el punto cuando el nombre del documento ya termina en punto', async () => {
    const { VdrDocumentVersionsDialog } =
      await import('@/components/company/vdr/VdrDocumentVersionsDialog')

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Informe anual, S. A.',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 1,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    const description = screen.getByText(/Cada versión conserva su evidencia/)
    expect(description).toHaveTextContent(
      'Informe anual, S. A. Cada versión conserva su evidencia de integridad y estado de publicación.'
    )
    expect(description.textContent).not.toContain('..')
  })
  // La fecha salía de `toLocaleString('es-PA')`, que ordena MM/DD/YYYY y se lee
  // como estadounidense ([F] 2026-09-17, hallazgos del E2E). Ahora usa el mismo
  // formateador que la tabla de actividad del Data Room, para poder cruzar el
  // mismo evento entre las dos pantallas.
  it('fecha las versiones con el formateador compartido, no con el default de es-PA', async () => {
    const { VdrDocumentVersionsDialog } = await import(
      '@/components/company/vdr/VdrDocumentVersionsDialog'
    )

    render(
      <VdrDocumentVersionsDialog
        document={{
          _id: 'document_1',
          name: 'Modelo financiero',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 2,
        }}
        locale="es"
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('15 ene 2027, 03:00:00')).toBeInTheDocument()
    expect(screen.queryByText(/01\/15\/2027/)).not.toBeInTheDocument()
    expect(screen.queryByText(/a\. m\./)).not.toBeInTheDocument()
  })
})
