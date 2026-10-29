import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/documents/viewers/XlsxViewer', () => ({
  XlsxViewer: (props: {
    workbookId: string
    sheet?: string
    range?: string
    chrome?: { ready?: boolean; onReady?: () => void }
  }) => (
    <div
      data-testid="xlsx-viewer-stub"
      data-workbook-id={props.workbookId}
      data-sheet={props.sheet}
      data-range={props.range}
      data-ready={String(props.chrome?.ready)}
    >
      <button type="button" onClick={() => props.chrome?.onReady?.()}>
        listo
      </button>
    </div>
  ),
}))

vi.mock('@/components/documents/viewers/PdfViewer', () => ({
  PdfViewer: (props: { page?: number }) => (
    <div data-testid="pdf-viewer-stub" data-page={props.page} />
  ),
}))

import { DocumentViewer } from '@/components/documents/viewers/DocumentViewer'

describe('DocumentViewer exact citation navigation', () => {
  it('binds Mog workbook identity, sheet and range to the cited version', () => {
    render(
      <DocumentViewer
        documentId={'document_model' as never}
        versionId={'version_cited' as never}
        fileName="Modelo.xlsx"
        mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        sizeBytes={1}
        viewUrl="/grant/model"
        downloadUrl={null}
        navigate={{ sheet: 'Supuestos', range: 'B11:C14' }}
      />
    )

    expect(screen.getByTestId('xlsx-viewer-stub')).toMatchObject({
      dataset: {
        workbookId: 'vdr://document_model/version_cited',
        sheet: 'Supuestos',
        range: 'B11:C14',
      },
    })
  })

  it('passes the cited PDF page without changing version identity upstream', () => {
    render(
      <DocumentViewer
        documentId={'document_pdf' as never}
        versionId={'version_pdf_cited' as never}
        fileName="Prospecto.pdf"
        mimeType="application/pdf"
        sizeBytes={1}
        viewUrl="/grant/pdf"
        downloadUrl={null}
        navigate={{ page: 27 }}
      />
    )

    expect(screen.getByTestId('pdf-viewer-stub')).toHaveAttribute('data-page', '27')
  })
})

// El marco no ofrece la pantalla completa antes de tiempo, y quien sabe si el
// documento esta en pantalla es el despacho: recibe el `onReady` de los seis
// renderers y devuelve `ready` por el mismo `chrome`.
describe('DocumentViewer readiness', () => {
  function renderModel(viewUrl: string) {
    return (
      <DocumentViewer
        documentId={'document_model' as never}
        versionId={'version_ready' as never}
        fileName="Modelo.xlsx"
        mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        sizeBytes={1}
        viewUrl={viewUrl}
        downloadUrl={null}
      />
    )
  }

  it('turns ready on with the renderer and off again with a new grant', async () => {
    const { rerender } = render(renderModel('/grant/model'))

    expect(screen.getByTestId('xlsx-viewer-stub')).toHaveAttribute('data-ready', 'false')

    await userEvent.click(screen.getByRole('button', { name: 'listo' }))
    expect(screen.getByTestId('xlsx-viewer-stub')).toHaveAttribute('data-ready', 'true')

    // El reintento emite otro permiso: es otra apertura y vuelve a cargar.
    rerender(renderModel('/grant/model_retry'))
    expect(screen.getByTestId('xlsx-viewer-stub')).toHaveAttribute('data-ready', 'false')
  })
})
