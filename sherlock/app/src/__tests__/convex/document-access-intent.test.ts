// ============================================================================
// VIEW vs DOWNLOAD — resolución pura, independiente del harness de grants
// ============================================================================
// #397 amplió `isInlineViewableDocument` para coincidir con cada renderer del
// visor. Si esta tabla se desincroniza de `mime.ts`, un cliente puede etiquetar
// una descarga real como VIEW (no cuenta en la alarma de extracción) o el
// visor abre un tipo activo en el origen privilegiado. Los casos de grant
// (`downloadAccessIntent.test.ts`) cubren PDF/XLSX felices; no cubren HTML,
// charset, octet-stream ni el disfraz MIME+extensión.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  isInlineViewableDocument,
  resolveDocumentAccessIntent,
} from '../../../convex/_documents/accessIntent'
import { isPreviewableDocument } from '@/components/documents/viewers/mime'

const PREVIEWABLE: Array<{ fileType: string | undefined; name: string }> = [
  { fileType: 'application/pdf', name: 'memo.pdf' },
  { fileType: 'application/pdf; charset=binary', name: 'memo.pdf' },
  { fileType: 'pdf', name: 'memo.pdf' },
  { fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'm.xlsx' },
  { fileType: 'application/vnd.ms-excel.sheet.macroenabled.12', name: 'm.xlsm' },
  {
    fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'm.docx',
  },
  {
    fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    name: 'm.pptx',
  },
  { fileType: 'text/csv', name: 'balance.csv' },
  { fileType: 'image/png', name: 'planta.png' },
  { fileType: 'application/octet-stream', name: 'modelo.xlsx' },
  { fileType: 'binary/octet-stream', name: 'teaser.pdf' },
  { fileType: '', name: 'datos.csv' },
  { fileType: undefined, name: 'deck.pptx' },
]

const FORCED_DOWNLOAD: Array<{ fileType: string | undefined; name: string }> = [
  { fileType: 'text/html', name: 'entregable.html' },
  { fileType: 'text/html', name: 'factura.pdf' },
  { fileType: 'image/svg+xml', name: 'logo.svg' },
  { fileType: 'application/xml', name: 'datos.xml' },
  { fileType: 'application/xhtml+xml', name: 'page.xhtml' },
  { fileType: 'application/vnd.ms-excel', name: 'modelo.xls' },
  { fileType: 'application/msword', name: 'memo.doc' },
  { fileType: 'application/vnd.ms-powerpoint', name: 'deck.ppt' },
  { fileType: 'application/zip', name: 'sala.zip' },
  { fileType: 'application/x-msdownload', name: 'factura.pdf' },
  { fileType: 'application/octet-stream', name: 'entregable.html' },
  { fileType: undefined, name: 'logo.svg' },
  { fileType: undefined, name: 'modelo.xls' },
  { fileType: undefined, name: 'archivo' },
]

describe('isInlineViewableDocument', () => {
  it.each(PREVIEWABLE)('allows VIEW for $fileType $name', (document) => {
    expect(isInlineViewableDocument(document)).toBe(true)
  })

  it.each(FORCED_DOWNLOAD)('refuses VIEW for $fileType $name', (document) => {
    expect(isInlineViewableDocument(document)).toBe(false)
  })
})

describe('resolveDocumentAccessIntent', () => {
  it('defaults unspecified and DOWNLOAD requests to DOWNLOAD even for a PDF', () => {
    const pdf = { fileType: 'application/pdf', name: 'memo.pdf' }
    expect(resolveDocumentAccessIntent(undefined, pdf)).toBe('DOWNLOAD')
    expect(resolveDocumentAccessIntent('DOWNLOAD', pdf)).toBe('DOWNLOAD')
  })

  it('honors VIEW only when the server can actually render inline', () => {
    expect(
      resolveDocumentAccessIntent('VIEW', { fileType: 'application/pdf', name: 'memo.pdf' })
    ).toBe('VIEW')
    expect(
      resolveDocumentAccessIntent('VIEW', { fileType: 'text/html', name: 'entregable.html' })
    ).toBe('DOWNLOAD')
    expect(
      resolveDocumentAccessIntent('VIEW', {
        fileType: 'application/x-msdownload',
        name: 'factura.pdf',
      })
    ).toBe('DOWNLOAD')
  })
})

describe('access intent stays aligned with the viewer dispatch table', () => {
  it.each([...PREVIEWABLE, ...FORCED_DOWNLOAD])(
    'agrees with isPreviewableDocument for $fileType $name',
    (document) => {
      expect(isInlineViewableDocument(document)).toBe(
        isPreviewableDocument(document.fileType, document.name)
      )
    }
  )
})
