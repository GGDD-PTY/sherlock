// ============================================================================
// VDR FILESYSTEM SHELL
// ============================================================================
// Contratos de navegador del shell del data room: centro en blanco, selección
// sin apertura, visor bajo demanda, renombrar / mover / archivar y layout
// redimensionable persistente. Corre en dev-auth con la tienda demo local: no
// toca Convex, storage ni datos de clientes.
// ============================================================================

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'

const ROOM_URL = '/es/my-company/documents'
const LAYOUT_KEY = 'sherlock.vdr.shell.layout.v2'

// Sala sintética de "Andina Solar, S. A." (Panamá, proceso de crédito).
// Datos ficticios: ningún archivo real, ningún cliente real.
// Reutiliza los cuatro ids demo por defecto para que la tienda local los
// REEMPLACE en vez de sumarlos: la sala queda exactamente en estos cuatro.
const ANDINA_SOLAR_DOCUMENTS = [
  {
    id: 'demo_doc_espave_legal_diligence',
    companyId: 'demo_company_001',
    name: 'Pacto social Andina Solar',
    accessLevel: 'PRIVATE',
    classification: 'LEGAL',
    fileType: 'application/pdf',
    folder: 'legal',
    createdAt: '2026-08-01T12:00:00.000Z',
  },
  {
    id: 'demo_doc_espave_source_manifest',
    companyId: 'demo_company_001',
    name: 'Indice de fuentes Andina Solar',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    fileType: 'text/markdown',
    folder: 'data_room_index',
    createdAt: '2026-08-02T12:00:00.000Z',
  },
  {
    id: 'demo_doc_espave_financials',
    companyId: 'demo_company_001',
    name: 'Modelo financiero Andina Solar',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    folder: 'model',
    createdAt: '2026-08-03T12:00:00.000Z',
  },
  {
    id: 'demo_doc_espave_teaser',
    companyId: 'demo_company_001',
    name: 'Teaser de deuda Andina Solar',
    accessLevel: 'PUBLIC',
    classification: 'PUBLIC_TEASER',
    fileType: 'application/pdf',
    folder: 'teaser',
    createdAt: '2026-08-04T12:00:00.000Z',
  },
  {
    id: 'e2e_shell_carta_intencion',
    companyId: 'demo_company_001',
    name: 'Carta de intencion Andina Solar',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: 'other',
    createdAt: '2026-08-05T12:00:00.000Z',
  },
]

async function installAndinaSolarRoom(page: Page) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value)
    },
    { key: 'sherlock.demo.documents.v1', value: JSON.stringify(ANDINA_SOLAR_DOCUMENTS) }
  )
}

async function openRoom(page: Page) {
  await installAndinaSolarRoom(page)
  await loginAsDemoUser(page, 'company')
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
  const shell = page.getByTestId('vdr-room-shell')
  await expect(shell).toBeVisible()
  // El HTML servido se ve antes de hidratar: sin esperar al manejador armado,
  // un click o una tecla caen en el vacío.
  await expect(page.getByTestId('room-tree-resize')).toHaveAttribute('data-resize-ready', 'true')
  return shell
}

function fileRow(page: Page, name: string | RegExp) {
  return page.getByTestId('room-file').filter({ hasText: name })
}

function folderRow(page: Page, folder: string) {
  return page.locator(`[data-testid="room-folder"][data-folder="${folder}"]`)
}

function folderCount(page: Page, folder: string) {
  return page.locator(`[data-testid="room-folder-count"][data-folder="${folder}"]`)
}

async function dropForeignFiles(
  page: Page,
  target: Locator,
  files: ReadonlyArray<{ name: string; type: string; contents: string }>
) {
  const dataTransfer = await page.evaluateHandle((entries) => {
    const transfer = new DataTransfer()
    for (const entry of entries) {
      transfer.items.add(new File([entry.contents], entry.name, { type: entry.type }))
    }
    return transfer
  }, files)

  await target.dispatchEvent('dragenter', { dataTransfer })
  await target.dispatchEvent('dragover', { dataTransfer })
  await target.dispatchEvent('drop', { dataTransfer })
}

test.describe('VDR filesystem shell', () => {
  test.skip(!IS_DEMO_AUTH, 'Requires demo auth mode')

  test('composes filesystem and canvas with shadcn primitives', async ({ page }) => {
    await openRoom(page)

    await expect(page.getByTestId('room-desktop-layout')).toHaveAttribute(
      'data-slot',
      'resizable-panel-group'
    )
    await expect(page.getByTestId('room-files-sidebar')).toHaveAttribute('data-side', 'left')
    await expect(page.getByTestId('room-files-sidebar')).toHaveAttribute('data-slot', 'sidebar')
    await expect(page.getByTestId('room-canvas')).toHaveAttribute('data-slot', 'resizable-panel')

    const filesPanel = page.getByTestId('room-files-panel')
    const filesWidth = (await filesPanel.boundingBox())?.width ?? 0
    await page.getByTestId('room-tree-resize').focus()
    await page.getByTestId('room-tree-resize').press('ArrowRight')
    await expect
      .poll(async () => (await filesPanel.boundingBox())?.width ?? 0)
      .toBeGreaterThan(filesWidth)
  })

  test('opens on a blank center with the five fixed folders and no file open', async ({ page }) => {
    await openRoom(page)

    await expect(page.getByTestId('room-center-empty')).toBeVisible()
    await expect(page.getByText('Abre un archivo para verlo aquí')).toBeVisible()
    await expect(page.getByTestId('room-document-card')).toHaveCount(0)
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)

    await expect(page.getByTestId('room-folder')).toHaveCount(5)
    for (const label of [
      '1. Legales',
      '2. Corporativos',
      '3. Financieros',
      '4. Operaciones',
      '5. Materiales de mercadeo',
    ]) {
      await expect(page.getByTestId('room-folder').filter({ hasText: label })).toBeVisible()
    }

    // La taxonomía heredada aterriza en la carpeta fija que le corresponde.
    await expect(folderCount(page, 'room_legal')).toHaveText('1')
    await expect(folderCount(page, 'room_financial')).toHaveText('1')
    await expect(folderCount(page, 'room_marketing')).toHaveText('1')
    await expect(folderCount(page, 'room_corporate')).toHaveText('2')
    await expect(folderCount(page, 'room_operations')).toHaveText('0')
  })

  test('selecting a document shows its card without opening it, and Abrir mounts the viewer', async ({
    page,
  }) => {
    await openRoom(page)

    await fileRow(page, 'Teaser de deuda Andina Solar').click()

    const card = page.getByTestId('room-document-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Teaser de deuda Andina Solar')
    await expect(card.getByTestId('room-file-type')).toHaveText('PDF')
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)

    await card.getByRole('button', { name: /^Abrir: /i }).click()
    await expect(page.getByTestId('room-viewer')).toBeVisible()

    await page.getByTestId('room-viewer-close').click()
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)
    await expect(page.getByTestId('room-document-card')).toBeVisible()
  })

  test('keeps three bulk selections through filtering, reports hidden rows, and clears without opening', async ({
    page,
  }) => {
    await openRoom(page)

    for (const name of [
      'Pacto social Andina Solar',
      'Modelo financiero Andina Solar',
      'Teaser de deuda Andina Solar',
    ]) {
      await page.getByRole('checkbox', { name: `Seleccionar ${name}` }).click()
    }

    const bulkBar = page.getByTestId('room-bulk-selection')
    await expect(bulkBar).toContainText('3 seleccionados')
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)

    await page.getByRole('textbox', { name: 'Buscar documentos' }).fill('Pacto social')
    await expect(bulkBar).toContainText('3 seleccionados, 2 fuera de esta vista')

    await bulkBar.getByRole('button', { name: 'Limpiar' }).click()
    await expect(page.getByTestId('room-bulk-selection')).toHaveCount(0)
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)
  })

  test('renames a document from the room and keeps it in the tree', async ({ page }) => {
    await openRoom(page)

    await fileRow(page, 'Pacto social Andina Solar').click()
    await page
      .getByTestId('room-document-card')
      .getByRole('button', { name: /^Renombrar: /i })
      .click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const nameField = dialog.getByLabel(/nombre del documento/i)
    await nameField.fill('Pacto social Andina Solar (2026)')
    await dialog.getByRole('button', { name: /guardar cambios/i }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(fileRow(page, 'Pacto social Andina Solar (2026)')).toBeVisible()
  })

  test('moves a document between fixed folders', async ({ page }) => {
    await openRoom(page)

    await expect(folderCount(page, 'room_operations')).toHaveText('0')
    await fileRow(page, 'Modelo financiero Andina Solar').click()

    await page.getByTestId('room-move-folder').click()
    await page.getByRole('option', { name: '4. Operaciones' }).click()

    await expect(folderCount(page, 'room_operations')).toHaveText('1')
    await expect(folderCount(page, 'room_financial')).toHaveText('0')
    await expect(fileRow(page, 'Modelo financiero Andina Solar')).toBeVisible()
    await expect(page.getByTestId('room-document-card')).toContainText('4. Operaciones')
  })

  test('routes hierarchy gestures through productive VDR commands without opening or granting a file', async ({
    page,
  }) => {
    const reactFailures: string[] = []
    const suspiciousReactFailure =
      /hydrat|did not match|Minified React error|Maximum update depth|Warning: .*React/i
    page.on('console', (message) => {
      if (
        (message.type() === 'error' || message.type() === 'warning') &&
        suspiciousReactFailure.test(message.text())
      ) {
        reactFailures.push(message.text())
      }
    })
    page.on('pageerror', (error) => {
      if (suspiciousReactFailure.test(error.message)) reactFailures.push(error.message)
    })

    const grantFrames: string[] = []
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        if (typeof payload === 'string' && payload.includes('getDocumentAccessGrant')) {
          grantFrames.push(payload)
        }
      })
    })

    await openRoom(page)
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)

    const financialModel = fileRow(page, 'Modelo financiero Andina Solar')
    await financialModel.click()
    const rename = page.getByRole('textbox', {
      name: 'Renombrar Modelo financiero Andina Solar',
    })
    // Bajo `next dev` el click y el F2 del test caen milisegundos después de
    // hidratar; el árbol a veces todavía mueve el foco (StrictMode repite el
    // efecto de reconstrucción) o no tiene armado el renombrado, y la tecla
    // cae en el vacío. Un humano tarda más entre click y tecla. Reenfocar la
    // fila y repetir F2 hasta ver el input es fixture, no producto.
    await expect
      .poll(
        async () => {
          if (await rename.isVisible()) return true
          const focused = await financialModel.evaluate((el) => el === document.activeElement)
          if (!focused) await financialModel.click()
          await page.keyboard.press('F2')
          return rename.isVisible()
        },
        { intervals: [250, 500, 1000], timeout: 15_000 }
      )
      .toBe(true)
    await rename.fill('Modelo financiero Andina Solar final')
    await expect(rename).toHaveValue('Modelo financiero Andina Solar final')
    await page.keyboard.press('Enter')
    await expect(fileRow(page, 'Modelo financiero Andina Solar final')).toBeVisible()

    await expect(rename).toBeHidden()
    const destination = folderRow(page, 'room_operations')
    // A 720px el scroll del destino mueve la fila origen. Resolver el gesto después del scroll.
    await destination.scrollIntoViewIfNeeded()
    await fileRow(page, 'Modelo financiero Andina Solar final').hover()
    await page.mouse.down()
    await destination.hover()
    await destination.hover({ position: { x: 16, y: 16 } })
    await page.mouse.up()
    await expect(folderCount(page, 'room_financial')).toHaveText('0')
    await expect(folderCount(page, 'room_operations')).toHaveText('1')
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)

    await fileRow(page, 'Modelo financiero Andina Solar final').click()
    await page
      .getByTestId('room-document-card')
      .getByRole('button', { name: /^Información: / })
      .click()
    const info = page.getByTestId('room-document-info')
    const history = info.getByRole('button', { name: 'Historial de versiones' })
    await expect(history).toBeVisible()
    await expect(history).toBeDisabled()
    await info.getByRole('button', { name: 'Cerrar' }).click()
    await expect(info).toHaveCount(0)

    await dropForeignFiles(page, folderRow(page, 'room_legal'), [
      { name: 'balance-general-2025.pdf', type: 'application/pdf', contents: 'balance' },
    ])
    const uploadDialog = page.getByRole('dialog', { name: 'Subir documento' })
    await expect(uploadDialog).toContainText('balance-general-2025.pdf')
    await expect(uploadDialog).toContainText('1 archivo seleccionado')

    await dropForeignFiles(page, folderRow(page, 'room_financial'), [
      { name: 'contrato-marco.docx', type: 'application/msword', contents: 'contrato' },
    ])
    const conflict = page.getByRole('dialog', { name: 'Cambiar carpeta de carga' })
    await expect(conflict).toContainText(
      'Ya tienes archivos en 1. Legales. Si continúas, toda la tanda se cargará en 3. Financieros.'
    )
    await conflict.getByRole('button', { name: 'Cambiar carpeta' }).click()

    await expect(uploadDialog).toContainText('balance-general-2025.pdf')
    await expect(uploadDialog).toContainText('contrato-marco.docx')
    await expect(uploadDialog).toContainText('2 archivos seleccionados')

    await page.keyboard.press('Escape')
    await expect(uploadDialog).toHaveCount(0)
    // La sala es una por empresa ([F] 2026-09-17): no hay selector «Sala» que
    // cambiar ni cola que se reinicie al cambiar. La cola cerrada con Escape
    // basta como cierre del gesto.
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)
    expect(grantFrames).toEqual([])
    expect(reactFailures).toEqual([])
  })

  test('archives a document out of the room', async ({ page }) => {
    await openRoom(page)

    await fileRow(page, 'Carta de intencion Andina Solar').click()
    await page
      .getByTestId('room-document-card')
      .getByRole('button', { name: /^Archivar: /i })
      .click()

    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    // El diálogo del cliente dice «Quitar de la sala» ([F] 2026-09-17): quitar es
    // archivar, la base conserva la fila.
    await dialog.getByRole('button', { name: 'Quitar de la sala', exact: true }).click()

    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(fileRow(page, 'Carta de intencion Andina Solar')).toHaveCount(0)
    await expect(page.getByTestId('room-center-empty')).toBeVisible()
  })

  test('resizes the tree with the keyboard and keeps the width after a reload', async ({
    page,
  }) => {
    await openRoom(page)

    const handle = page.getByTestId('room-tree-resize')
    const panel = page.getByTestId('room-files-panel')
    const before = (await panel.boundingBox())?.width ?? 0
    await handle.focus()
    await handle.press('ArrowRight')
    await handle.press('ArrowRight')

    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(before)
    const after = (await panel.boundingBox())?.width ?? 0

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('vdr-room-shell')).toBeVisible()
    await expect(page.getByTestId('room-tree-resize')).toHaveAttribute('data-resize-ready', 'true')
    await expect
      .poll(async () => (await page.getByTestId('room-files-panel').boundingBox())?.width ?? 0)
      .toBeGreaterThan(before)

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY)
    const storedWidth = stored
      ? (JSON.parse(stored) as { treeWidth?: number }).treeWidth
      : undefined
    expect(storedWidth).toBeDefined()
    expect(Math.abs((storedWidth ?? 0) - after)).toBeLessThan(3)
  })

  test('opens the document metadata in a dialog and closes it', async ({ page }) => {
    await openRoom(page)

    await fileRow(page, 'Modelo financiero Andina Solar').click()
    await expect(page.getByTestId('room-document-info')).toHaveCount(0)
    await page
      .getByTestId('room-document-card')
      .getByRole('button', { name: /^Información: /i })
      .click()

    const info = page.getByTestId('room-document-info')
    await expect(info).toBeVisible()
    await expect(info).toContainText('3. Financieros')

    await info.getByRole('button', { name: 'Cerrar' }).click()
    await expect(page.getByTestId('room-document-info')).toHaveCount(0)
    await expect(page.getByTestId('room-document-card')).toBeVisible()
  })

  test('sorting and search stay bounded to the room', async ({ page }) => {
    await openRoom(page)

    const search = page.getByRole('textbox', { name: 'Buscar documentos' })
    await search.pressSequentially('modelo')
    await expect(page.getByTestId('room-file')).toHaveCount(1)
    // Con búsqueda activa la portada cuenta resultados, no documentos
    // (2bc3233bf, plan 10 AU-01, 2026-09-12).
    await expect(page.getByTestId('room-results')).toHaveText('Mostrando 1 de 1 resultado')

    await search.fill('')
    await expect(search).toHaveValue('')
    await expect(page.getByTestId('room-file')).toHaveCount(5)

    await page.getByRole('combobox', { name: 'Orden' }).click()
    await page.getByRole('option', { name: 'Modificado' }).click()
    await expect(page.getByTestId('room-results')).toHaveText('Mostrando 5 de 5 documentos')
  })

  test('selected document yields to no-results and returns after clearing search', async ({
    page,
  }) => {
    await openRoom(page)

    await fileRow(page, 'Teaser de deuda Andina Solar').click()
    await expect(page.getByTestId('room-document-card')).toBeVisible()

    const search = page.getByRole('textbox', { name: 'Buscar documentos' })
    await search.fill('ninguna coincidencia')
    await expect(page.getByTestId('room-center-empty')).toHaveAttribute(
      'data-variant',
      'no-results'
    )
    await expect(page.getByTestId('room-document-card')).toHaveCount(0)

    await page.getByRole('button', { name: 'Limpiar búsqueda' }).first().click()
    await expect(page.getByTestId('room-document-card')).toContainText(
      'Teaser de deuda Andina Solar'
    )
  })
})

// ============================================================================
// Accesibilidad del shell.
// Contratos que aplican al RoomShell vigente: axe WCAG
// A/AA sobre la superficie viva, foco visible de teclado en el árbol y el
// contrato móvil (toggle de carpetas, tap target 44px, cero overflow, temas).
// ============================================================================

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

async function expectVisibleKeyboardFocus(locator: Locator) {
  await expect(locator).toBeFocused()

  const focus = await locator.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    }
  })

  expect(focus.focusVisible).toBe(true)
  expect(
    (focus.outlineStyle !== 'none' && focus.outlineWidth > 0) || focus.boxShadow !== 'none'
  ).toBe(true)
}

async function expectNoDocumentOverflow(page: Page, context: string) {
  const geometry = await page.evaluate(() => ({
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))

  expect(
    geometry.rootScrollWidth,
    `${context}: documentElement is ${geometry.rootScrollWidth}px wide in a ${geometry.rootClientWidth}px viewport`
  ).toBeLessThanOrEqual(geometry.rootClientWidth)
  expect(
    geometry.bodyScrollWidth,
    `${context}: body is ${geometry.bodyScrollWidth}px wide in a ${geometry.bodyClientWidth}px viewport`
  ).toBeLessThanOrEqual(geometry.bodyClientWidth)
  expect(geometry.rootClientWidth).toBe(geometry.viewportWidth)
}

// Bajo 1024px el shell apila el árbol sobre el lienzo y no monta los handles
// de resize, así que `openRoom` (que espera room-tree-resize) no aplica.
async function openRoomNarrow(page: Page) {
  await installAndinaSolarRoom(page)
  await loginAsDemoUser(page, 'company')
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('vdr-room-shell')).toBeVisible()
  await expect(page.getByTestId('room-tree-toggle')).toBeVisible()
}

test.describe('VDR room shell accessibility', () => {
  test.skip(!IS_DEMO_AUTH, 'Requires demo auth mode')

  test('the room surfaces have no detectable WCAG A/AA violations', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openRoom(page)

    const analyze = async (context: string) => {
      const results = await new AxeBuilder({ page })
        .include('[data-testid="vdr-room-shell"]')
        .withTags([...WCAG_TAGS])
        .analyze()
      const violations = results.violations.map(({ help, id, impact, nodes }) => ({
        help,
        id,
        impact,
        nodes: nodes.map(({ failureSummary, target }) => ({ failureSummary, target })),
      }))
      expect(violations, `${context}: ${JSON.stringify(violations)}`).toEqual([])
    }

    await analyze('blank room')

    await fileRow(page, 'Teaser de deuda Andina Solar').click()
    await expect(page.getByTestId('room-document-card')).toBeVisible()
    await analyze('document card')

    await page
      .getByTestId('room-document-card')
      .getByRole('button', { name: /^Información: /i })
      .click()
    await expect(page.getByTestId('room-document-info')).toBeVisible()
    await analyze('document info dialog')
  })

  test('the folder tree exposes roving keyboard focus with a visible indicator', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openRoom(page)

    const treeItems = page.getByTestId('room-tree').getByRole('treeitem')
    const firstFolder = treeItems.first()

    // Entra por modalidad de teclado para que :focus-visible aplique.
    await firstFolder.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expectVisibleKeyboardFocus(firstFolder)

    // Abajo recorre las filas visibles; el indicador viaja con el foco.
    await page.keyboard.press('ArrowDown')
    await expectVisibleKeyboardFocus(treeItems.nth(1))

    // Izquierda colapsa la carpeta expandida; derecha la reabre.
    await firstFolder.focus()
    await expect(firstFolder).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(firstFolder).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(firstFolder).toHaveAttribute('aria-expanded', 'true')
  })

  test('the real room supports Home, End and typeahead without opening a file', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openRoom(page)

    const tree = page.getByTestId('room-tree')
    const firstFolder = folderRow(page, 'room_legal')
    await firstFolder.focus()
    await expect(firstFolder).toBeFocused()

    await page.keyboard.press('End')
    await expect(tree.getByRole('treeitem').last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(firstFolder).toBeFocused()

    await page.keyboard.press('m')
    await expect(tree.getByRole('treeitem', { name: /^Modelo financiero/i }).first()).toBeFocused()
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)
    await expect(page.getByTestId('room-viewer')).toHaveCount(0)
  })

  for (const width of [320, 375] as const) {
    test(`the ${width}px room keeps overflow contained and the folder toggle operable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      await openRoomNarrow(page)

      await expectNoDocumentOverflow(page, `initial room at ${width}px`)

      const toggle = page.getByTestId('room-tree-toggle')
      await expect(toggle).toHaveAttribute('aria-controls', 'room-tree-region')
      await expect(toggle).toHaveCSS('min-height', '44px')
      await expect(page.getByTestId('room-tree').getByRole('treeitem').first()).toHaveCSS(
        'min-height',
        '44px'
      )

      // El HTML servido se ve antes de hidratar: reintenta el toggle hasta que
      // el estado expandido responda (mismo patrón click -> estado del repo).
      await expect(async () => {
        await toggle.click({ timeout: 2_000 }).catch(() => {})
        await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 2_000 })
      }).toPass({ timeout: 15_000 })
      await expect(page.getByTestId('room-tree')).toBeHidden()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('room-tree')).toBeVisible()

      await fileRow(page, 'Teaser de deuda Andina Solar').click()
      await expect(page.getByTestId('room-document-card')).toBeVisible()
      await expectNoDocumentOverflow(page, `selected document at ${width}px`)
    })
  }

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`the 390px room honors ${colorScheme} mode without page overflow`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ colorScheme })
      await page.addInitScript((theme) => localStorage.setItem('theme', theme), colorScheme)

      await openRoomNarrow(page)

      const rootTheme = await page.locator('html').evaluate((element) => ({
        classList: [...element.classList],
        colorScheme: window.getComputedStyle(element).colorScheme,
      }))
      expect(rootTheme.classList).toContain(colorScheme)
      expect(rootTheme.colorScheme).toBe(colorScheme)
      await expectNoDocumentOverflow(page, `${colorScheme} room at 390px`)

      await fileRow(page, 'Teaser de deuda Andina Solar').click()
      await expect(page.getByTestId('room-document-card')).toBeVisible()
      await expectNoDocumentOverflow(page, `${colorScheme} document card at 390px`)
    })
  }
})
