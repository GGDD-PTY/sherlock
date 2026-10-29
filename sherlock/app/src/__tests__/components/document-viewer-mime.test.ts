import { describe, expect, it } from 'vitest'

import {
  fileExtension,
  isPreviewableDocument,
  resolveDocumentViewerKind,
} from '@/components/documents/viewers/mime'

describe('resolveDocumentViewerKind', () => {
  it('dispatches every previewable OOXML type by MIME', () => {
    expect(
      resolveDocumentViewerKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'modelo.xlsx'
      )
    ).toBe('xlsx')
    expect(
      resolveDocumentViewerKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'negocio.docx'
      )
    ).toBe('docx')
    expect(
      resolveDocumentViewerKind(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'gerencia.pptx'
      )
    ).toBe('pptx')
    expect(resolveDocumentViewerKind('application/pdf', 'eeff.pdf')).toBe('pdf')
    expect(resolveDocumentViewerKind('image/png', 'parque.png')).toBe('image')
  })

  it('accepts the legacy grant shape that stores the extension in fileType', () => {
    expect(resolveDocumentViewerKind('pdf', 'eeff.pdf')).toBe('pdf')
    expect(resolveDocumentViewerKind('PDF', 'eeff.pdf')).toBe('pdf')
    expect(resolveDocumentViewerKind('application/pdf; charset=binary', 'eeff.pdf')).toBe('pdf')
  })

  it('falls back to the extension only when the MIME is missing or generic', () => {
    expect(resolveDocumentViewerKind(null, 'modelo.xlsx')).toBe('xlsx')
    expect(resolveDocumentViewerKind('', 'eeff.pdf')).toBe('pdf')
    expect(resolveDocumentViewerKind('application/octet-stream', 'gerencia.pptx')).toBe('pptx')
  })

  it('never re-interprets a specific unknown MIME by file name', () => {
    // Un ejecutable renombrado a .pdf no se abre en el visor.
    expect(resolveDocumentViewerKind('application/x-msdownload', 'factura.pdf')).toBe('download')
  })

  it('keeps active content out of the privileged origin', () => {
    expect(resolveDocumentViewerKind('text/html', 'entregable.html')).toBe('download')
    expect(resolveDocumentViewerKind('image/svg+xml', 'logo.svg')).toBe('download')
    expect(resolveDocumentViewerKind(null, 'entregable.html')).toBe('download')
    expect(resolveDocumentViewerKind(null, 'logo.svg')).toBe('download')
    expect(resolveDocumentViewerKind('application/xml', 'datos.xml')).toBe('download')
  })

  it('sends legacy binary Office formats to download instead of a renderer', () => {
    expect(resolveDocumentViewerKind('application/vnd.ms-excel', 'modelo.xls')).toBe('download')
    expect(resolveDocumentViewerKind('application/msword', 'negocio.doc')).toBe('download')
    expect(resolveDocumentViewerKind('application/vnd.ms-powerpoint', 'gerencia.ppt')).toBe(
      'download'
    )
    expect(resolveDocumentViewerKind(null, 'modelo.xls')).toBe('download')
  })

  it('falls back to download for anything unrecognised', () => {
    expect(resolveDocumentViewerKind(null, 'archivo')).toBe('download')
    expect(resolveDocumentViewerKind(null, null)).toBe('download')
    expect(resolveDocumentViewerKind('application/zip', 'sala.zip')).toBe('download')
  })
})

describe('isPreviewableDocument', () => {
  it('mirrors the dispatch table', () => {
    expect(isPreviewableDocument('application/pdf', 'eeff.pdf')).toBe(true)
    expect(isPreviewableDocument('application/zip', 'sala.zip')).toBe(false)
  })
})

describe('fileExtension', () => {
  it('reads the last extension, lowercased', () => {
    expect(fileExtension('Modelo.FINAL.XLSX')).toBe('xlsx')
  })

  it('returns empty for dotfiles and names without an extension', () => {
    expect(fileExtension('.env')).toBe('')
    expect(fileExtension('archivo')).toBe('')
    expect(fileExtension(null)).toBe('')
  })
})
