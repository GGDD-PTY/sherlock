import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseMutation = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      getDownloadUrl: 'documents.getDownloadUrl',
      getDocumentAccessGrant: 'documents.getDocumentAccessGrant',
    },
  },
}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.name ? `${key}:${values.name}` : key,
}))

// El diálogo es la frontera de AUTORIZACIÓN: emite el grant y elige la
// intención. Qué renderer abre el archivo lo prueban `document-viewer-mime` y
// el journey Playwright `vdr-viewers.spec.ts` con archivos reales; aquí el
// renderer se sustituye para que el contrato del diálogo quede aislado.
//
// El MARCO sí es el de verdad: la pantalla completa del visor es un
// `fixed inset-0` que el `transform` del `DialogContent` de Radix atrapa, y el
// Esc de salida tiene que ganarle al de Radix. Eso no se prueba contra un
// doble.
vi.mock('@/components/documents/viewers/DocumentViewer', async () => {
  const { ViewerFrame } = await import('@/components/documents/viewers/ViewerChrome')

  return {
    DocumentViewer: (props: {
      fileName: string
      mimeType: string
      viewUrl: string
      downloadUrl: string | null
      versionId: string
      onClose?: () => void
      onExpandedChange?: (expanded: boolean) => void
    }) => (
      <ViewerFrame
        chrome={{
          fileName: props.fileName,
          kind: 'pdf',
          // El doble reemplaza al renderer, asi que el documento ya esta en
          // pantalla: es lo que le abre el boton de pantalla completa.
          ready: true,
          onClose: props.onClose,
          onExpandedChange: props.onExpandedChange,
        }}
      >
        <div
          data-testid="document-viewer-stub"
          data-file-name={props.fileName}
          data-mime-type={props.mimeType}
          data-view-url={props.viewUrl}
          data-download-url={props.downloadUrl ?? ''}
          data-version-id={props.versionId}
        />
      </ViewerFrame>
    ),
  }
})

import { Button } from '@/components/ui/button'
import { DocumentViewerDialog } from '@/components/documents/DocumentViewerDialog'

function issuedGrant(args: {
  url: string
  action?: 'VIEW' | 'DOWNLOAD'
  versionId?: string
  displayName: string
  detectedMimeType: string
}) {
  return {
    allowed: true as const,
    action: args.action ?? ('VIEW' as const),
    versionId: args.versionId ?? 'version_current',
    ...args,
  }
}

describe('DocumentViewerDialog', () => {
  beforeEach(() => {
    mockUseMutation.mockReset()
  })

  it('requests an inline grant and hands the PDF to the viewer on open', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue(
      issuedGrant({
        url: '/api/documents/access/grant_1?token=abc',
        displayName: 'Financial model.pdf',
        detectedMimeType: 'application/pdf',
      })
    )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_1"
        name="Financial model.pdf"
        fileType="application/pdf"
        trigger={<Button>view</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view' }))

    await waitFor(() => {
      expect(getDownloadUrl).toHaveBeenCalledWith({ documentId: 'doc_1', action: 'VIEW' })
    })

    const viewer = await screen.findByTestId('document-viewer-stub')
    expect(viewer).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_1?token=abc&disposition=inline'
    )
    expect(viewer).toHaveAttribute('data-mime-type', 'application/pdf')
    // Con vista previa el original no se ofrece como descarga desde el visor.
    expect(viewer).toHaveAttribute('data-download-url', '')
    expect(screen.getByText('viewMode')).toBeInTheDocument()
    // La vista de un PDF ya no lleva marca: el diálogo promete el permiso de un
    // solo uso y el registro de la apertura, no un estampado que no ocurre.
    expect(screen.getByText('viewProtectionFile')).toBeInTheDocument()
    expect(screen.queryByText('viewProtection')).not.toBeInTheDocument()
    expect(screen.queryByText('captureDisclosure')).not.toBeInTheDocument()
  })

  it('requests a VIEW grant for a spreadsheet now that XLSX has a renderer', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue(
      issuedGrant({
        url: '/api/documents/access/grant_x?token=xls',
        versionId: 'ver_7',
        displayName: 'Cap table.xlsx',
        detectedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_xlsx"
        name="Cap table.xlsx"
        fileType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        versionId="ver_7"
        trigger={<Button>view</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view' }))

    await waitFor(() => {
      expect(getDownloadUrl).toHaveBeenCalledWith({
        documentId: 'doc_xlsx',
        versionId: 'ver_7',
        action: 'VIEW',
      })
    })

    const viewer = await screen.findByTestId('document-viewer-stub')
    expect(viewer).toHaveAttribute('data-version-id', 'ver_7')
    expect(screen.getByText('viewMode')).toBeInTheDocument()
  })

  it('describes a PPTX as an audited rendition without claiming a watermark', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue(
      issuedGrant({
        url: '/api/documents/access/grant_pptx?token=pptx',
        displayName: 'Management presentation.pptx',
        detectedMimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
    )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_pptx"
        name="Management presentation.pptx"
        fileType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        trigger={<Button>view pptx</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view pptx' }))
    await screen.findByTestId('document-viewer-stub')

    expect(screen.getByText('renditionDescription')).toBeInTheDocument()
    expect(screen.getByText('renditionProtection')).toBeInTheDocument()
    expect(screen.queryByText('viewProtection')).not.toBeInTheDocument()
    expect(screen.queryByText('captureDisclosure')).not.toBeInTheDocument()
  })

  it('dispatches an exact historical CSV from authorized grant metadata instead of current PDF props', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_csv?token=historical',
      action: 'VIEW',
      versionId: 'version_historical_csv',
      displayName: 'historical-evidence.csv',
      detectedMimeType: 'text/csv',
    })
    mockUseMutation.mockReturnValue(getDocumentAccessGrant)

    render(
      <DocumentViewerDialog
        documentId="doc_cross_mime"
        name="Current prospectus.pdf"
        fileType="application/pdf"
        versionId="version_historical_csv"
        trigger={<Button>view historical csv</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view historical csv' }))

    const viewer = await screen.findByTestId('document-viewer-stub')
    expect(viewer).toHaveAttribute('data-file-name', 'historical-evidence.csv')
    expect(viewer).toHaveAttribute('data-mime-type', 'text/csv')
    expect(viewer).toHaveAttribute('data-version-id', 'version_historical_csv')
    expect(viewer).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_csv?token=historical&disposition=inline'
    )
  })

  it('uses an exact historical DOWNLOAD response even when current props are previewable', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_zip?token=historical',
      action: 'DOWNLOAD',
      versionId: 'version_historical_zip',
      displayName: 'historical-package.zip',
      detectedMimeType: 'application/zip',
    })
    mockUseMutation.mockReturnValue(getDocumentAccessGrant)

    render(
      <DocumentViewerDialog
        documentId="doc_cross_mime_download"
        name="Current prospectus.pdf"
        fileType="application/pdf"
        versionId="version_historical_zip"
        trigger={<Button>view historical zip</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view historical zip' }))

    const viewer = await screen.findByTestId('document-viewer-stub')
    expect(viewer).toHaveAttribute('data-file-name', 'historical-package.zip')
    expect(viewer).toHaveAttribute('data-mime-type', 'application/zip')
    expect(viewer).toHaveAttribute(
      'data-download-url',
      '/api/documents/access/grant_zip?token=historical'
    )
    expect(screen.getByText('downloadMode')).toBeInTheDocument()
  })

  it('falls back to a no-preview download for a format with no renderer', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue(
      issuedGrant({
        url: '/api/documents/access/grant_2?token=xyz',
        action: 'DOWNLOAD',
        versionId: 'ver_zip',
        displayName: 'Sala completa.zip',
        detectedMimeType: 'application/zip',
      })
    )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_2"
        name="Sala completa.zip"
        fileType="application/zip"
        versionId="ver_zip"
        trigger={<Button>view</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view' }))

    // El usuario pide VIEW; el servidor resuelve la versión exacta y la degrada
    // a DOWNLOAD porque no existe renderer para ZIP.
    await waitFor(() => {
      expect(getDownloadUrl).toHaveBeenCalledWith({
        documentId: 'doc_2',
        versionId: 'ver_zip',
        action: 'VIEW',
      })
    })

    const viewer = await screen.findByTestId('document-viewer-stub')
    // Sin disposition=inline (se descarga tal cual) y con la URL de descarga.
    expect(viewer).toHaveAttribute('data-view-url', '/api/documents/access/grant_2?token=xyz')
    expect(viewer).toHaveAttribute('data-download-url', '/api/documents/access/grant_2?token=xyz')
    expect(screen.getByText('downloadMode')).toBeInTheDocument()
    expect(screen.getByText('downloadProtection')).toBeInTheDocument()
    expect(screen.queryByText('captureDisclosure')).not.toBeInTheDocument()
  })

  it('keeps a policy denial inside the dialog without exposing backend copy', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: 'Mensaje interno que no debe presentarse',
    })
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_denied"
        name="Legal.pdf"
        fileType="application/pdf"
        trigger={<Button>view denied</Button>}
      />
    )

    const trigger = screen.getByRole('button', { name: 'view denied' })
    await userEvent.click(trigger)

    const deniedState = await screen.findByTestId('document-viewer-denied')
    expect(deniedState).toHaveAttribute('role', 'alert')
    expect(screen.getByText('deniedTitle')).toBeInTheDocument()
    expect(screen.getByText('deniedDescription')).toBeInTheDocument()
    expect(screen.queryByText('Mensaje interno que no debe presentarse')).not.toBeInTheDocument()
    expect(screen.getByLabelText('documentArea')).toHaveFocus()

    await userEvent.click(within(deniedState).getByRole('button', { name: 'close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('distinguishes an expired document or requirement from a generic denial', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue({
      allowed: false,
      code: 'DENIED_DOCUMENT_EXPIRED',
      message: 'El acceso a este documento ha expirado.',
    })
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_expired"
        name="Expired.pdf"
        fileType="application/pdf"
        trigger={<Button>view expired</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view expired' }))

    expect(await screen.findByTestId('document-viewer-expired')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('expiredTitle')).toBeInTheDocument()
    expect(screen.getByText('expiredDescription')).toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-denied')).not.toBeInTheDocument()
  })

  it('shows a recoverable inline error and requests a fresh grant on retry', async () => {
    const getDownloadUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sensitive provider detail'))
      .mockResolvedValueOnce(
        issuedGrant({
          url: '/api/documents/access/grant_retry?token=fresh',
          displayName: 'Retry.pdf',
          detectedMimeType: 'application/pdf',
        })
      )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_retry"
        name="Retry.pdf"
        fileType="application/pdf"
        trigger={<Button>view retry</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view retry' }))

    expect(await screen.findByTestId('document-viewer-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('errorTitle')).toBeInTheDocument()
    expect(screen.queryByText('Sensitive provider detail')).not.toBeInTheDocument()
    expect(screen.getByLabelText('documentArea')).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: 'retry' }))

    const viewer = await screen.findByTestId('document-viewer-stub')
    expect(viewer).toHaveAttribute(
      'data-view-url',
      '/api/documents/access/grant_retry?token=fresh&disposition=inline'
    )
    expect(getDownloadUrl).toHaveBeenCalledTimes(2)
  })

  // El `DialogContent` de Radix es `fixed` con `translate-x/-y`: ese transform
  // es el bloque contenedor de cualquier `fixed` de adentro, asi que el marco
  // a pantalla completa llena el dialogo y no la ventana mientras el dialogo
  // siga siendo una tarjeta centrada.
  describe('fullscreen inside the dialog', () => {
    async function openPdfDialog() {
      const getDownloadUrl = vi.fn().mockResolvedValue(
        issuedGrant({
          url: '/api/documents/access/grant_fs?token=fs',
          displayName: 'Financial model.pdf',
          detectedMimeType: 'application/pdf',
        })
      )
      mockUseMutation.mockReturnValue(getDownloadUrl)

      render(
        <DocumentViewerDialog
          documentId="doc_fs"
          name="Financial model.pdf"
          fileType="application/pdf"
          trigger={<Button>view fullscreen</Button>}
        />
      )

      await userEvent.click(screen.getByRole('button', { name: 'view fullscreen' }))
      await screen.findByTestId('document-viewer-stub')

      const content = document.querySelector('[data-slot="dialog-content"]')
      if (!(content instanceof HTMLElement)) throw new Error('dialog content is missing')
      return content
    }

    it('keeps the centred card exactly as it is today while the viewer is not expanded', async () => {
      const content = await openPdfDialog()

      expect(content.className).toContain('sm:max-w-6xl')
      expect(content.className).toContain('h-[min(92dvh,56rem)]')
      expect(content.className).not.toContain('h-dvh')
      expect(content.className).toContain('rounded-lg')
    })

    it('gives the window to the viewer when the frame asks for it, and takes it back', async () => {
      const content = await openPdfDialog()

      await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
      expect(content.className).toContain('h-dvh')
      expect(content.className).toContain('w-screen')
      expect(content.className).toContain('sm:max-w-none')
      expect(content.className).not.toContain('sm:max-w-6xl')
      expect(content.className).not.toContain('rounded-lg')

      await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
      expect(content.className).not.toContain('h-dvh')
      expect(content.className).toContain('sm:max-w-6xl')
    })

    it('spends the first Escape on the fullscreen frame instead of dismissing the dialog', async () => {
      const content = await openPdfDialog()

      await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))

      // Radix escucha Escape en CAPTURA sobre `document`; el marco escucha en
      // captura sobre `window`, que va antes en el camino del evento.
      await userEvent.keyboard('{Escape}')
      expect(document.querySelector('[data-slot="dialog-content"]')).toBe(content)
      expect(screen.getByTestId('document-viewer-fullscreen')).toHaveAttribute(
        'aria-pressed',
        'false'
      )
      expect(content.className).not.toContain('h-dvh')

      await userEvent.keyboard('{Escape}')
      expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
    })
  })

  it('ignores a late grant response after the dialog is closed', async () => {
    let resolveGrant: ((value: ReturnType<typeof issuedGrant>) => void) | undefined
    const getDownloadUrl = vi.fn().mockImplementation(
      () =>
        new Promise<ReturnType<typeof issuedGrant>>((resolve) => {
          resolveGrant = resolve
        })
    )
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DocumentViewerDialog
        documentId="doc_late"
        name="Late.pdf"
        fileType="application/pdf"
        trigger={<Button>view late</Button>}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'view late' }))
    expect(screen.getByTestId('document-viewer-loading')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('dialog', { name: 'Late.pdf' })).toHaveAttribute('aria-busy', 'true')

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    resolveGrant?.(
      issuedGrant({
        url: '/api/documents/access/grant_late?token=old',
        displayName: 'Late.pdf',
        detectedMimeType: 'application/pdf',
      })
    )
    await Promise.resolve()

    expect(screen.queryByTestId('document-viewer-stub')).not.toBeInTheDocument()
  })
})
