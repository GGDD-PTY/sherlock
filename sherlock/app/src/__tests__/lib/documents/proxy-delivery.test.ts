import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProxiedDownloadResponse } from '@/lib/documents/proxy-delivery'

// ============================================================================
// LA DESCARGA PROXEADA SALE CON EXTENSIÓN
// ============================================================================
// El grant no trae un nombre de archivo: trae `documentVersions.displayName`,
// que es el TÍTULO del documento, y los uploaders de la sala lo guardan sin
// extensión. En el dry run del 2026-09-04 (H5) el modelo del cliente cayó en
// Descargas como «Modelo financiero v1 - Compania Azucarera La Estrella», sin
// `.xlsx`, y no había con qué abrirlo. La extensión sale del tipo que la misma
// entrega ya resolvió para `Content-Type`.
// ============================================================================

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function stubStorage() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bytes', { status: 200 }))
  )
}

async function disposition(
  download: { fileName?: string | null; fileType?: string | null },
  intent: 'attachment' | 'inline' = 'attachment'
): Promise<string> {
  stubStorage()
  const response = await createProxiedDownloadResponse(
    { downloadUrl: 'https://storage.convex.test/blob', ...download },
    intent
  )
  return response.headers.get('content-disposition') ?? ''
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createProxiedDownloadResponse', () => {
  it('le pone al título del documento la extensión de su tipo', async () => {
    const header = await disposition({
      fileName: 'Modelo financiero v1 - Compania Azucarera La Estrella',
      fileType: XLSX,
    })

    expect(header).toContain(
      'filename="Modelo financiero v1 - Compania Azucarera La Estrella.xlsx"'
    )
    expect(header).toContain(
      "filename*=UTF-8''Modelo%20financiero%20v1%20-%20Compania%20Azucarera%20La%20Estrella.xlsx"
    )
  })

  it('no repite la extensión que el nombre ya trae', async () => {
    const header = await disposition({
      fileName: 'Estados financieros.pdf',
      fileType: 'application/pdf',
    })

    expect(header).toContain('filename="Estados financieros.pdf"')
    expect(header).not.toContain('.pdf.pdf')
  })

  it('también nombra la vista inline y el respaldo sin nombre', async () => {
    expect(
      await disposition({ fileName: 'Teaser', fileType: 'application/pdf' }, 'inline')
    ).toContain('inline; filename="Teaser.pdf"')
    expect(await disposition({ fileName: null, fileType: XLSX })).toContain(
      'filename="documento.xlsx"'
    )
  })

  it('un tipo que la sala no conoce se entrega con el nombre tal cual', async () => {
    const header = await disposition({ fileName: 'Nota', fileType: 'application/octet-stream' })

    expect(header).toContain('filename="Nota"')
  })
})
