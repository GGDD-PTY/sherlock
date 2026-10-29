import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { createGuestDocumentResponse } from '@/lib/documents/guest-delivery'

// ============================================================================
// CANDADO: LOS BYTES DEL INVITADO SALEN AISLADOS
// ============================================================================
// El invitado es una contraparte externa, no un miembro de la sala: su
// navegador no debe poder hospedar el PDF en ningún contexto de incrustación,
// ni dejarlo en una caché compartida. El visor consume la ruta con `fetch` +
// `arrayBuffer`, así que estas cabeceras no lo tocan.
//
// Los bytes salen sin sello ([F] 2026-09-04): la invitación y la bitácora son
// la evidencia de a quién se le abrió.
// ============================================================================

const METADATA = {
  documentId: 'doc_selected',
  versionId: 'version_selected',
  invitationId: 'invitation_1',
  guestLabel: 'g***t@example.com',
  fileName: 'Estados financieros.pdf',
}

async function sourcePdf(): Promise<ArrayBuffer> {
  const document = await PDFDocument.create()
  document.addPage([300, 300])
  const bytes = await document.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const response = async () =>
  createGuestDocumentResponse(await sourcePdf(), METADATA, 'request-test')

describe('createGuestDocumentResponse', () => {
  it('delivers the original bytes untouched', async () => {
    // Una sola fuente: pdf-lib sella CreationDate/ModDate con el segundo actual
    // y el largo del PDF cambia de un segundo a otro. La función recibe una
    // copia para que `source` quede intacto si algo mutara el buffer recibido.
    const source = await sourcePdf()

    const delivered = await (
      await createGuestDocumentResponse(source.slice(0), METADATA, 'request-test')
    ).arrayBuffer()

    expect(new Uint8Array(delivered)).toEqual(new Uint8Array(source))
    expect(await PDFDocument.load(delivered).then((pdf) => pdf.getPageCount())).toBe(1)
  })

  it('refuses to be framed anywhere', async () => {
    const headers = (await response()).headers

    expect(headers.get('x-frame-options')).toBe('DENY')
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('ships a content policy that grants the document nothing', async () => {
    const policy = (await response()).headers.get('content-security-policy')

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('sandbox')
  })

  it('keeps the bytes out of every cache and off content sniffing', async () => {
    const headers = (await response()).headers

    expect(headers.get('cache-control')).toContain('no-store')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('content-type')).toBe('application/pdf')
    expect(headers.get('content-disposition')).toContain('inline')
  })
})
