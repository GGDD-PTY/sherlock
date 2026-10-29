import { expect, test, type Locator, type Page } from '@playwright/test'

import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'
import {
  attachSyntheticPerformanceObservation,
  captureDomObservation,
  expectNoRootOverflow,
  installSyntheticLargeRoom,
  SYNTHETIC_VDR_DOCUMENT_COUNT,
  SYNTHETIC_VDR_MATCH_COUNT,
} from './helpers/vdr-large-room'

const ROOM_URL = '/es/my-company/documents?room=company&view=documents&category=all'
const MAX_RENDERED_DOCUMENTS = 50
const MAX_EXPANDED_DOCUMENTS = 100
const MAX_BOUNDED_DOM_NODES = 7_500

function documentShell(page: Page) {
  return page.getByTestId('vdr-room-shell')
}

async function openSyntheticRoom(page: Page, layout: 'desktop' | 'mobile' = 'desktop') {
  await installSyntheticLargeRoom(page)
  await loginAsDemoUser(page, 'company')

  const startedAt = Date.now()
  const response = await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
  expect(response?.status()).toBe(200)

  const shell = documentShell(page)
  await expect(shell.getByTestId('room-results')).toHaveText(
    `Mostrando 50 de ${SYNTHETIC_VDR_DOCUMENT_COUNT} documentos`
  )
  if (layout === 'desktop') {
    // El shell desktop se sirve primero con el snapshot móvil de SSR. El
    // handle confirma que hidrató y adoptó el media query antes de interactuar.
    await expect(page.getByTestId('room-tree-resize')).toHaveAttribute('data-resize-ready', 'true')
  } else {
    // A 390px el layout vertical correcto no monta handles de resize.
    const filesSidebar = shell.getByTestId('room-files-sidebar')
    const canvas = shell.getByTestId('room-canvas')
    await expect(page.getByTestId('room-desktop-layout')).toHaveCount(0)
    await expect(page.getByTestId('room-tree-resize')).toHaveCount(0)
    await expect(filesSidebar).toBeVisible()
    await expect(filesSidebar.getByTestId('room-tree-toggle')).toBeVisible()
    await expect(canvas).toBeVisible()
    await expect
      .poll(async () => {
        const [filesBox, canvasBox] = await Promise.all([
          filesSidebar.boundingBox(),
          canvas.boundingBox(),
        ])
        if (!filesBox || !canvasBox) return false
        return canvasBox.y >= filesBox.y + filesBox.height - 1
      })
      .toBe(true)
  }

  return { shell, initialRenderMs: Date.now() - startedAt }
}

// Con búsqueda activa la portada cuenta resultados, no documentos
// (2bc3233bf, plan 10 AU-01, 2026-09-12).
async function expectDocumentWindow(
  shell: Locator,
  count: number,
  total: number,
  searching = false
) {
  await expect(shell.getByTestId('room-file')).toHaveCount(count)
  await expect(shell.getByTestId('room-results')).toHaveText(
    `Mostrando ${count} de ${total} ${searching ? 'resultados' : 'documentos'}`
  )
}

test.describe('Synthetic issuer VDR large-room behavior', () => {
  test.skip(!IS_DEMO_AUTH, 'Requires isolated demo auth; never run this fixture against production')

  test('keeps 500 documents windowed while load-more, filter and URL state stay bounded', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })

    const { shell, initialRenderMs } = await openSyntheticRoom(page)
    await expectDocumentWindow(shell, MAX_RENDERED_DOCUMENTS, SYNTHETIC_VDR_DOCUMENT_COUNT)

    const initialDom = await captureDomObservation(page)
    expect(initialDom.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)

    const loadMoreStartedAt = Date.now()
    await shell.getByRole('button', { name: 'Cargar 50 documentos más' }).click()
    await expectDocumentWindow(shell, MAX_EXPANDED_DOCUMENTS, SYNTHETIC_VDR_DOCUMENT_COUNT)
    const loadMoreMs = Date.now() - loadMoreStartedAt

    const expandedDom = await captureDomObservation(page)
    expect(expandedDom.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)

    // Las cinco carpetas fijas siguen siendo la estructura visible con 500
    // documentos: la ventana acota las FILAS, nunca la taxonomía.
    await expect(shell.getByTestId('room-folder')).toHaveCount(5)

    const filterStartedAt = Date.now()
    const search = shell.getByRole('textbox', { name: 'Buscar documentos' })
    await search.pressSequentially('needle alpha')
    await expectDocumentWindow(shell, SYNTHETIC_VDR_MATCH_COUNT, SYNTHETIC_VDR_MATCH_COUNT, true)
    const filterMs = Date.now() - filterStartedAt

    await expect
      .poll(() => {
        const url = new URL(page.url())
        return {
          room: url.searchParams.get('room'),
          view: url.searchParams.get('view'),
          category: url.searchParams.get('category'),
          query: url.searchParams.get('q'),
        }
      })
      .toEqual({
        room: 'company',
        view: 'documents',
        category: 'all',
        query: 'needle alpha',
      })

    await page.reload({ waitUntil: 'domcontentloaded' })
    const restoredShell = documentShell(page)
    await expectDocumentWindow(
      restoredShell,
      SYNTHETIC_VDR_MATCH_COUNT,
      SYNTHETIC_VDR_MATCH_COUNT,
      true
    )
    await expect(restoredShell.getByRole('textbox', { name: 'Buscar documentos' })).toHaveValue(
      'needle alpha'
    )

    await attachSyntheticPerformanceObservation(testInfo, {
      initialRenderMs,
      loadMoreMs,
      filterMs,
      initialDomNodes: initialDom.bodyNodes,
      expandedDomNodes: expandedDom.bodyNodes,
      viewport: { width: 1280, height: 900 },
    })
  })

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${viewport.width}px reflows a windowed 500-document room without root overflow`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport)
      const { shell, initialRenderMs } = await openSyntheticRoom(
        page,
        viewport.width >= 1024 ? 'desktop' : 'mobile'
      )
      await expectDocumentWindow(shell, MAX_RENDERED_DOCUMENTS, SYNTHETIC_VDR_DOCUMENT_COUNT)

      const geometry = await expectNoRootOverflow(page, `${viewport.width}px synthetic VDR`)
      expect(geometry.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)

      await attachSyntheticPerformanceObservation(testInfo, {
        initialRenderMs,
        initialDomNodes: geometry.bodyNodes,
        viewport,
      })
    })
  }
})
