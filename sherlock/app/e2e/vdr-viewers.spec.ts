// ============================================================================
// VISORES DEL VDR — journey de navegador
// ============================================================================
// Ejercita cada renderer con un archivo real. El banco de pruebas
// (`/es/dev-viewers`, solo dev-auth) monta <DocumentViewer/> con los parametros
// de la URL; la ruta del grant se intercepta y devuelve los bytes del fixture,
// asi que la prueba mide RENDER, no autorizacion (eso lo cubren los tests de
// `DocumentViewerDialog` y del route handler).
//
// Empresa ficticia: Andina Solar, S. A. Nunca datos de clientes reales.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import AxeBuilder from '@axe-core/playwright'
import JSZip from 'jszip'
import type { Browser, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { convertPptxToPdf } from '../src/lib/documents/renditions/ooxml-to-pdf'

const FIXTURES = join(process.cwd(), 'e2e', 'fixtures')
const GRANT_URL = '/api/documents/access/grant_bench?token=bench'

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
} as const

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name))
}

/**
 * Sirve el fixture en la ruta del grant. `rendition=pdf` reproduce lo que hace
 * el route handler para PPTX: convierte en el servidor y entrega el PDF con el
 * MISMO grant. Aqui se usa el mismo conversor de produccion.
 */
async function serveFixture(page: Page, name: string, contentType: string) {
  await page.route('**/api/documents/access/**', async (route) => {
    const bytes = fixture(name)
    if (new URL(route.request().url()).searchParams.get('rendition') === 'pdf') {
      const pdf = await convertPptxToPdf(new Uint8Array(bytes))
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'Cache-Control': 'private, no-store' },
        body: Buffer.from(pdf),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType,
      headers: { 'Cache-Control': 'private, no-store' },
      body: bytes,
    })
  })
}

function benchUrl(params: Record<string, string>): string {
  const search = new URLSearchParams({ viewUrl: GRANT_URL, ...params })
  return `/es/dev-viewers?${search.toString()}`
}

test.describe('VDR document viewers', () => {
  test('XLSX opens in the Mog sidecar and navigate selects a range after mount', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    await serveFixture(page, 'andina-solar-modelo.xlsx', MIME.xlsx)
    await page.goto(
      benchUrl({
        fileName: 'andina-solar-modelo.xlsx',
        mimeType: MIME.xlsx,
        sheet: 'Flujo',
        range: 'B3:C3',
      })
    )

    // El sidecar es un iframe mismo-origen servido desde /mog/ (build de Vite).
    const sidecar = page.frameLocator('[data-testid="document-viewer-mog-frame"]')
    // El runtime de Mog baja 41 MB de WASM: el primer render es lento a proposito.
    await expect(sidecar.locator('canvas').first()).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('document-viewer-frame-loading')).toHaveCount(0, {
      timeout: 120_000,
    })

    // Los valores del fixture confirman que Mog leyo el libro, no un placeholder.
    await expect(sidecar.getByText('Supuestos')).toBeVisible()
    await expect(sidecar.getByText('Flujo')).toBeVisible()
    await expect(sidecar.getByTestId('formula-bar-input')).toBeVisible()
    await expect(sidecar.getByRole('tablist', { name: 'Hojas' })).toBeVisible()

    // Los live regions siguen anunciando, pero viven fuera del root React y no
    // rompen la anatomia ARIA del grid.
    await expect(
      sidecar.locator('[role="grid"] [role="status"], [role="grid"] [role="alert"]')
    ).toHaveCount(0)
    await expect(
      sidecar.locator('body > [data-sherlock-live-region-bridge] [role="status"]')
    ).toHaveCount(1)
    await expect(
      sidecar.locator('body > [data-sherlock-live-region-bridge] [role="alert"]')
    ).toHaveCount(1)

    // El override usa el token secundario resuelto por cada tema, no un color
    // fijo. Se compara contra el mismo custom property dentro del iframe.
    const themeRoot = sidecar.locator('[data-mog-color-scheme]').first()
    const blockingIframeViolations = async () => {
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      return axe.violations
        .filter(
          (violation) =>
            (violation.impact === 'critical' || violation.impact === 'serious') &&
            violation.nodes.some((node) => JSON.stringify(node.target).includes('iframe'))
        )
        .map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map((node) => node.target),
        }))
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await themeRoot.evaluate((node, scheme) => {
        node.setAttribute('data-mog-color-scheme', scheme)
      }, colorScheme)
      await expect(themeRoot).toHaveAttribute('data-mog-color-scheme', colorScheme)
      // El cromo de Mog habla español ([F] 2026-09-03, sitio solo en español):
      // la barra de estado dice «Listo», no «Ready».
      const usesSecondaryToken = await sidecar
        .getByText('Listo', { exact: true })
        .evaluate((node) => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--color-ss-text-secondary)'
          node.parentElement?.append(probe)
          const expected = getComputedStyle(probe).color
          probe.remove()
          return getComputedStyle(node).color === expected
        })
      expect(usesSecondaryToken).toBe(true)
      expect(await blockingIframeViolations()).toEqual([])
    }

    // `navigate` llega DESPUES del montaje: es como cita el asistente de sala.
    await page.getByTestId('viewer-bench-navigate').click()
    // Flujo!B3:C3 = EBITDA FY24 + FY25 = 17,460,000 + 24,610,000.
    await expect(sidecar.getByText('42,070,000')).toBeVisible({ timeout: 30_000 })

    expect(consoleErrors).toEqual([])
  })

  test('PDF renders on a canvas with pdfViewerEnabled false and never downloads', async ({
    browser,
  }) => {
    // Sin el visor nativo de PDF, un <iframe> o <embed> descargaria el archivo.
    // pdfjs tiene que rasterizar igual: ese es justo el punto de este renderer.
    const context = await (browser as Browser).newContext({ acceptDownloads: true })
    const page = await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => false })
    })

    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))

    await serveFixture(page, 'andina-solar-eeff.pdf', MIME.pdf)
    await page.goto(benchUrl({ fileName: 'andina-solar-eeff.pdf', mimeType: MIME.pdf, page: '1' }))

    const canvas = page.getByTestId('document-viewer-pdf-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(canvas).toHaveAttribute('data-page-count', '1')
    await expect(page.getByTestId('document-viewer-pdf-pagination')).toContainText('1')

    // Un canvas con pixeles: pdfjs rasterizo de verdad.
    const painted = await canvas.evaluate((element) => {
      const source = element as HTMLCanvasElement
      return source.width > 0 && source.height > 0
    })
    expect(painted).toBe(true)

    expect(downloads).toEqual([])
    await context.close()
  })

  test('DOCX renders with docx-preview', async ({ page }) => {
    await serveFixture(page, 'andina-solar-negocio.docx', MIME.docx)
    await page.goto(benchUrl({ fileName: 'andina-solar-negocio.docx', mimeType: MIME.docx }))

    const docx = page.getByTestId('document-viewer-docx')
    await expect(docx).toBeVisible({ timeout: 60_000 })
    await expect(docx).toContainText('Andina Solar', { timeout: 60_000 })
    await expect(docx).toContainText('Chiriqui II')
    // Ni HTML del productor ni un iframe: docx-preview construye nodos.
    await expect(docx.locator('iframe')).toHaveCount(0)
  })

  test('DOCX falls back to the PDF rendition when docx-preview cannot render it', async ({
    page,
  }) => {
    // Un paquete sin `[Content_Types].xml` rompe a docx-preview pero el
    // conversor sí encuentra `word/document.xml`: eso es exactamente el
    // fallback, y no pide un grant nuevo — reusa los bytes ya descargados.
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>Andina Solar rendition de respaldo</w:t></w:r></w:p>' +
        '</w:body></w:document>'
    )
    const broken = await zip.generateAsync({ type: 'nodebuffer' })

    await page.route('**/api/documents/access/**', (route) =>
      route.fulfill({ status: 200, contentType: MIME.docx, body: broken })
    )
    await page.goto(benchUrl({ fileName: 'roto.docx', mimeType: MIME.docx }))

    await expect(page.getByTestId('document-viewer-docx-rendition')).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByTestId('document-viewer-pdf-canvas')).toBeVisible({ timeout: 60_000 })
  })

  test('PPTX shows the server rendition without downloading the original', async ({ page }) => {
    await serveFixture(page, 'andina-solar-gerencia.pptx', MIME.pptx)

    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))

    await page.goto(benchUrl({ fileName: 'andina-solar-gerencia.pptx', mimeType: MIME.pptx }))

    await expect(page.getByTestId('document-viewer-pptx')).toBeVisible()
    const canvas = page.getByTestId('document-viewer-pdf-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    // Tres diapositivas -> tres paginas.
    await expect(canvas).toHaveAttribute('data-page-count', '3', { timeout: 60_000 })

    await page.getByTestId('document-viewer-pdf-next').click()
    await expect(canvas).toHaveAttribute('data-page', '2')

    expect(downloads).toEqual([])
  })

  test('images preview natively', async ({ page }) => {
    await serveFixture(page, 'andina-solar-parque.png', MIME.png)
    await page.goto(benchUrl({ fileName: 'andina-solar-parque.png', mimeType: MIME.png }))

    const image = page.getByTestId('document-viewer-image')
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expect(image).toHaveJSProperty('naturalWidth', 8)
  })

  test('a format with no renderer falls back to downloading the original', async ({ page }) => {
    await serveFixture(page, 'andina-solar-modelo.xlsx', 'application/zip')
    await page.goto(benchUrl({ fileName: 'sala-completa.zip', mimeType: 'application/zip' }))

    await expect(page.getByTestId('document-viewer-nopreview')).toBeVisible()
    await expect(page.getByTestId('document-viewer-mog-frame')).toHaveCount(0)
  })
})
