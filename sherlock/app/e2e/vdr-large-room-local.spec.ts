// ============================================================================
// SALA DE 200 DOCUMENTOS CONTRA EL BANCO LOCAL (tarjeta O5-03)
// ============================================================================
// Mide la sala grande con datos REALES del backend Convex local: una empresa
// sembrada con 200 documentos y perfil `desordenado`, abierta por su dueño
// desde `/es/dev-login`. Sin mocks y sin el room sintético del navegador
// (`vdr-large-room-performance.spec.ts` se queda como está y sigue cubriendo
// la ventana sin backend).
//
// Cómo se corre, desde la raíz del worktree:
//
//   PORT=3127 CONVEX_LOCAL_CLOUD_PORT=3470 CONVEX_LOCAL_SITE_PORT=3471 \
//     node sherlock/app/scripts/convex-local.mjs dev   # backend local + next dev
//   E2E_BASE_URL=http://localhost:3127 bun run bench:sala-grande
//
// `E2E_BASE_URL` es la única variable que el bench necesita. La siembra corre
// el CLI de Convex en un subproceso con cwd en `sherlock/app`, y los puertos
// del backend salen de `.convex-local/.convex/local/default/config.json`, que
// el propio `dev:local` escribió: no hay que repetirlos aquí.
//
// La siembra vive en el `beforeAll` y es idempotente: `seedCompany` compara los
// documentos por nombre (`registerMissingSeedDocuments`), así que la segunda
// corrida reusa lo sembrado y no crea nada.
//
// Presupuestos (tarjeta O5-03, no se aflojan): carga de la sala 3 000 ms,
// búsqueda por nombre 1 500 ms, visor de PDF y visor de XLSX 4 000 ms cada
// uno, más los topes de DOM del spec sintético. Una medición sobre su meta
// deja su fila en `no` y rompe el spec; el arreglo es otra tarjeta (O5-04).
// La tabla sale por consola y en
// `~/Developer/sherlock-handoffs/journeys/o5-03-<fecha-hora>.tsv`.
//
// Por qué no entra en `test:e2e*` ni en el gate: usa estado sembrado del
// backend local, que el resto del harness mantiene aislado a propósito
// (`e2e/AGENTS.md`), y necesita un `dev:local` vivo. El script fija
// `PLAYWRIGHT_REUSE_SERVER=true`.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Effect } from 'effect'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { captureDomObservation, expectNoRootOverflow } from './helpers/vdr-large-room'
import { devLogin, waitForHydratedInput } from './helpers/journeys'

const APP_DIR = resolve(process.cwd())
const SEED_SCRIPT = resolve(APP_DIR, 'scripts/convex-local.mjs')
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100'

const COMPANY_NAME = 'Sala Grande Local, S. A.'
const OWNER_EMAIL = 'sala-grande@dev.local'
const DOCUMENT_COUNT = 200

// El perfil `desordenado` abre con ocho anomalías con nombre propio y rellena
// el resto rotando PDF, CSV y XLSX (`convex/_localSeed.ts`). De los 192 de
// relleno, los 64 con índice `% 3 === 1` se llaman «datos N (1).csv»: esa es la
// búsqueda que filtra de verdad. El filtro mira el nombre y nada más
// (`filterRoomDocuments`), así que el 64 no depende de las descripciones.
const SEARCH_TERM = 'datos'
const SEARCH_MATCHES = 64
// Los dos archivos que abre el visor son anomalías, con nombre único en la
// sala: el buscador los deja solos y `toHaveCount(1)` lo comprueba.
const PDF_NAME = 'scan0001.pdf'
const XLSX_NAME = 'final_v3 (2).xlsx'

const ROOM_URL = '/es/my-company/documents?room=company&view=documents&category=all'
const VIEWPORT = { width: 1440, height: 900 } as const
const SEARCH_INPUT = 'input[aria-label="Buscar documentos"]'

const BUDGET_CARGA_MS = 3_000
const BUDGET_BUSQUEDA_MS = 1_500
const BUDGET_VISOR_MS = 4_000

const MAX_RENDERED_DOCUMENTS = 50
const MAX_EXPANDED_DOCUMENTS = 100
const MAX_BOUNDED_DOM_NODES = 7_500

// Los dos topes de espera son holgados a propósito: si un paso se pasa de su
// meta queremos el número real en la tabla, no un timeout que la deja sin fila.
// El del visor es más largo porque el runtime de Mog baja 41 MB de WASM en el
// primer render (medido en `e2e/vdr-viewers.spec.ts`, que espera 120 s).
const WAIT_SALA_MS = 30_000
const WAIT_VISOR_MS = 120_000

const TSV_DIR = join(homedir(), 'Developer', 'sherlock-handoffs', 'journeys')

type Medicion = {
  readonly paso: string
  readonly ms: number
  readonly meta: number
  readonly ok: boolean
  readonly fallo: string | null
}

/** Corre un paso, lo cronometra y deja su fila en la tabla pase o falle. Un
 *  paso que revienta se anota con su error y el spec sigue: la tarjeta pide
 *  reproducir y reportar cada rotura, no parar en la primera. */
async function mide(
  filas: Medicion[],
  paso: string,
  meta: number,
  accion: () => Promise<void>
): Promise<Medicion> {
  const inicio = Date.now()
  let fallo: string | null = null
  try {
    await accion()
  } catch (error) {
    fallo = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }
  const ms = Date.now() - inicio
  const fila: Medicion = { paso, ms, meta, ok: fallo === null && ms <= meta, fallo }
  filas.push(fila)
  return fila
}

const escribeTabla = Effect.fn('O5-03.escribeTabla')(function* (filas: readonly Medicion[]) {
  const fecha = new Date()
  const dos = (valor: number) => String(valor).padStart(2, '0')
  const sello =
    `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}` +
    `-${dos(fecha.getHours())}${dos(fecha.getMinutes())}${dos(fecha.getSeconds())}`
  const ruta = join(TSV_DIR, `o5-03-${sello}.tsv`)
  const cuerpo = [
    ['paso', 'ms', 'meta', 'ok'].join('\t'),
    ...filas.map((fila) => [fila.paso, fila.ms, fila.meta, fila.ok ? 'si' : 'no'].join('\t')),
  ].join('\n')
  yield* Effect.sync(() => mkdirSync(dirname(ruta), { recursive: true }))
  yield* Effect.sync(() => writeFileSync(ruta, `${cuerpo}\n`, 'utf8'))
  return { ruta, cuerpo }
})

/** Siembra la empresa si no está y devuelve cuántos documentos tiene. El
 *  script imprime el resumen que se lee aquí; el conteo es la prueba de que la
 *  corrida apuntó al backend que sirve la app. */
const siembraLaSala = Effect.fn('O5-03.siembraLaSala')(function* () {
  const puertoApp = new URL(BASE_URL).port || '80'
  const salida = yield* Effect.sync(() =>
    spawnSync(
      process.execPath,
      [
        SEED_SCRIPT,
        'seed:company',
        '--name',
        COMPANY_NAME,
        '--docs',
        String(DOCUMENT_COUNT),
        '--perfil',
        'desordenado',
        '--email',
        OWNER_EMAIL,
      ],
      // `PORT` solo cambia la URL que el script imprime como pista de entrada.
      { cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, PORT: puertoApp } }
    )
  )
  if (salida.status !== 0) {
    return yield* Effect.fail(
      new Error(
        `seed:company salió en ${salida.status}. ¿Está vivo el backend local del ` +
          `worktree? Salida:\n${salida.stdout}${salida.stderr}`
      )
    )
  }
  const leido = /sembrada: (\d+) documentos/.exec(salida.stdout)?.[1]
  if (Number(leido) !== DOCUMENT_COUNT) {
    return yield* Effect.fail(
      new Error(`seed:company reportó ${leido ?? 'nada'} documentos, no ${DOCUMENT_COUNT}`)
    )
  }
  return DOCUMENT_COUNT
})

function shell(page: Page): Locator {
  return page.getByTestId('vdr-room-shell')
}

function resultados(page: Page): Locator {
  return shell(page).getByTestId('room-results')
}

function buscador(page: Page): Locator {
  return shell(page).getByRole('textbox', { name: 'Buscar documentos' })
}

function esperaLaVentana(page: Page, visibles: number, total: number): Promise<void> {
  return expect(resultados(page)).toHaveText(`Mostrando ${visibles} de ${total} documentos`, {
    timeout: WAIT_SALA_MS,
  })
}

/** Deja en pantalla la tarjeta del documento que el buscador aísla y devuelve
 *  la acción de abrirlo. El cronómetro empieza en «Abrir», no en la búsqueda. */
async function seleccionaDesdeLaBusqueda(
  page: Page,
  nombre: string,
  pintado: () => Promise<void>
): Promise<() => Promise<void>> {
  await buscador(page).fill(nombre)
  const fila = shell(page).getByTestId('room-file').filter({ hasText: nombre })
  await expect(fila).toHaveCount(1, { timeout: WAIT_SALA_MS })
  await fila.click()
  const tarjeta = shell(page).getByTestId('room-document-card')
  await expect(tarjeta).toBeVisible({ timeout: WAIT_SALA_MS })

  return async () => {
    await tarjeta.getByRole('button', { name: `Abrir: ${nombre}` }).click()
    await pintado()
  }
}

/** Sin sala en pantalla no hay nada más que medir: el resto de los pasos solo
 *  gastaría su espera. La tabla ya tiene la fila que lo explica. Vive fuera del
 *  `test()` porque una condición adentro empuja el pin de
 *  `vitest/no-conditional-in-test`. */
function exigeLaSala(fila: Medicion): void {
  if (fila.fallo === null) return
  throw new Error(`la sala no cargó: ${fila.fallo}`)
}

/** El lienzo del visor de PDF pintó cuando el backing store deja de ser el
 *  default HTML 300x150 y `data-page-count` ya no es 0. Un canvas vacío nace
 *  en 300x150, así que `min(width, height) > 0` pasaba antes del raster. */
async function ladoMenorDelLienzo(page: Page): Promise<number> {
  const lienzo = page.getByTestId('document-viewer-pdf-canvas')
  await expect(lienzo).toBeVisible({ timeout: WAIT_VISOR_MS })
  await expect
    .poll(
      () =>
        lienzo.evaluate((nodo) => {
          if (!(nodo instanceof HTMLCanvasElement)) return 0
          const pageCount = nodo.dataset.pageCount
          const defaultSize = nodo.width === 300 && nodo.height === 150
          if (defaultSize) return 0
          if (pageCount === undefined || pageCount === '0') return 0
          return Math.min(nodo.width, nodo.height)
        }),
      { timeout: WAIT_VISOR_MS }
    )
    .toBeGreaterThan(0)
  return lienzo.evaluate((nodo) => {
    if (!(nodo instanceof HTMLCanvasElement)) return 0
    return Math.min(nodo.width, nodo.height)
  })
}

async function cierraElVisor(page: Page): Promise<void> {
  await page.getByTestId('room-viewer-close').click()
  await expect(page.getByTestId('room-viewer')).toHaveCount(0, { timeout: WAIT_SALA_MS })
}

/** Alto de la página y de los paneles. Fuera del `test()` para no empujar el
 *  pin de `vitest/no-conditional-in-test` con los `instanceof`. */
async function mideAltoDeLaSala(page: Page) {
  return page.evaluate(() => {
    const tree = document.querySelector('[data-testid="room-tree-region"]')
    const sidebar = document.querySelector('[data-testid="room-files-sidebar"]')
    const canvas = document.querySelector('[data-testid="room-canvas"]')
    if (
      !(tree instanceof HTMLElement) ||
      !(sidebar instanceof HTMLElement) ||
      !(canvas instanceof HTMLElement)
    ) {
      throw new Error('faltan el árbol, la barra o el lienzo de la sala')
    }
    return {
      pagina: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      treeClientH: tree.clientHeight,
      treeScrollH: tree.scrollHeight,
      sidebarClientH: sidebar.clientHeight,
      canvasClientH: canvas.clientHeight,
    }
  })
}

test.describe('Sala de 200 documentos contra el banco local', () => {
  test.skip(
    process.env.PLAYWRIGHT_REUSE_SERVER !== 'true',
    'Este bench reusa el `dev:local` vivo; corre con `bun run bench:sala-grande`.'
  )

  test.describe.configure({ timeout: 8 * 60 * 1000 })

  test.beforeAll(() => {
    Effect.runSync(siembraLaSala())
  })

  test('la sala de 200 documentos cumple su presupuesto de carga, búsqueda y visores', async ({
    page,
  }, testInfo) => {
    const mediciones: Medicion[] = []

    try {
      await page.setViewportSize(VIEWPORT)
      await devLogin(page, OWNER_EMAIL, /\/es\/my-company/)

      // Calentamiento: `next dev` compila la ruta en la primera visita y esa
      // espera no es la sala. Lo que se mide es la segunda navegación.
      await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
      await esperaLaVentana(page, MAX_RENDERED_DOCUMENTS, DOCUMENT_COUNT)

      const carga = await mide(mediciones, 'carga-sala', BUDGET_CARGA_MS, async () => {
        const respuesta = await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
        expect(respuesta?.status()).toBe(200)
        await esperaLaVentana(page, MAX_RENDERED_DOCUMENTS, DOCUMENT_COUNT)
      })
      exigeLaSala(carga)

      // El shell desktop se sirve primero con el snapshot móvil de SSR; el
      // handle confirma que hidrató antes de contar nodos o interactuar.
      await expect(page.getByTestId('room-tree-resize')).toHaveAttribute(
        'data-resize-ready',
        'true',
        { timeout: WAIT_SALA_MS }
      )
      await waitForHydratedInput(page, SEARCH_INPUT)
      await expect(shell(page).getByTestId('room-file')).toHaveCount(MAX_RENDERED_DOCUMENTS)
      const altoInicial = await mideAltoDeLaSala(page)
      console.info(
        [
          ['panel', 'clientH', 'scrollH'].join('\t'),
          ['pagina', String(altoInicial.pagina), String(altoInicial.viewport)].join('\t'),
          ['tree', String(altoInicial.treeClientH), String(altoInicial.treeScrollH)].join('\t'),
        ].join('\n')
      )
      expect(
        altoInicial.pagina,
        `scrollHeight ${altoInicial.pagina}px exceeds the ${VIEWPORT.height}px canvas`
      ).toBeLessThanOrEqual(VIEWPORT.height)
      expect(altoInicial.treeScrollH).toBeGreaterThan(altoInicial.treeClientH)
      const domInicial = await captureDomObservation(page)

      await mide(mediciones, 'busqueda-nombre', BUDGET_BUSQUEDA_MS, async () => {
        await buscador(page).fill(SEARCH_TERM)
        await esperaLaVentana(page, MAX_RENDERED_DOCUMENTS, SEARCH_MATCHES)
      })
      await buscador(page).fill('')
      await esperaLaVentana(page, MAX_RENDERED_DOCUMENTS, DOCUMENT_COUNT)

      // La ventana acota las FILAS, no la taxonomía: cargar más no multiplica
      // el DOM más allá del tope y las cinco carpetas siguen siendo cinco.
      await shell(page).getByRole('button', { name: 'Cargar 50 documentos más' }).click()
      await esperaLaVentana(page, MAX_EXPANDED_DOCUMENTS, DOCUMENT_COUNT)
      await expect(shell(page).getByTestId('room-file')).toHaveCount(MAX_EXPANDED_DOCUMENTS)
      await expect(shell(page).getByTestId('room-folder')).toHaveCount(5)
      const domExpandido = await captureDomObservation(page)

      const abrePdf = await seleccionaDesdeLaBusqueda(page, PDF_NAME, async () => {
        expect(await ladoMenorDelLienzo(page)).toBeGreaterThan(0)
      })
      await mide(mediciones, 'visor-pdf', BUDGET_VISOR_MS, abrePdf)
      await cierraElVisor(page)

      const abreXlsx = await seleccionaDesdeLaBusqueda(page, XLSX_NAME, async () => {
        // El sidecar de Mog es un iframe mismo-origen servido desde /mog/.
        const sidecar = page.frameLocator('[data-testid="document-viewer-mog-frame"]')
        await expect(sidecar.locator('canvas').first()).toBeVisible({ timeout: WAIT_VISOR_MS })
        await expect(page.getByTestId('document-viewer-frame-loading')).toHaveCount(0, {
          timeout: WAIT_VISOR_MS,
        })
      })
      await mide(mediciones, 'visor-xlsx', BUDGET_VISOR_MS, abreXlsx)
      await cierraElVisor(page)

      // El buscador sigue filtrado por el nombre del XLSX y el árbol muestra
      // una sola fila, así que el alto final compararía el panel consigo
      // mismo (498 = 498, medido en O5-05). Se limpia la búsqueda y se espera
      // la ventana de 100 que dejó «Cargar 50 documentos más»: la ventana no
      // se reinicia al filtrar, solo crece.
      await buscador(page).fill('')
      await esperaLaVentana(page, MAX_EXPANDED_DOCUMENTS, DOCUMENT_COUNT)
      await expect(shell(page).getByTestId('room-file')).toHaveCount(MAX_EXPANDED_DOCUMENTS)

      const geometria = await expectNoRootOverflow(page, `${VIEWPORT.width}px sala local de 200`)
      const alto = await mideAltoDeLaSala(page)
      console.info(
        [
          ['panel', 'clientH', 'scrollH'].join('\t'),
          ['pagina', String(alto.pagina), String(alto.viewport)].join('\t'),
          ['tree', String(alto.treeClientH), String(alto.treeScrollH)].join('\t'),
          ['sidebar', String(alto.sidebarClientH), ''].join('\t'),
          ['canvas', String(alto.canvasClientH), ''].join('\t'),
        ].join('\n')
      )
      expect(
        alto.pagina,
        `scrollHeight ${alto.pagina}px exceeds the ${VIEWPORT.height}px canvas`
      ).toBeLessThanOrEqual(VIEWPORT.height)
      expect(alto.treeScrollH).toBeGreaterThan(alto.treeClientH)
      expect(domInicial.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)
      expect(domExpandido.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)
      expect(geometria.bodyNodes).toBeLessThan(MAX_BOUNDED_DOM_NODES)
    } finally {
      // La tabla es el entregable de la tarjeta: se escribe aunque un paso se
      // caiga a media corrida.
      const { ruta, cuerpo } = Effect.runSync(escribeTabla(mediciones))
      console.info(`\n${cuerpo}\n${ruta}`)
      await testInfo.attach('o5-03-sala-200.tsv', {
        path: ruta,
        contentType: 'text/tab-separated-values',
      })
    }

    const rotas = mediciones.filter((fila) => fila.fallo !== null)
    expect(rotas.map((fila) => `${fila.paso}: ${fila.fallo}`)).toEqual([])
    const sobreLaMeta = mediciones.filter((fila) => !fila.ok)
    expect(sobreLaMeta.map((fila) => `${fila.paso}: ${fila.ms} ms > ${fila.meta} ms`)).toEqual([])
    expect(mediciones).toHaveLength(4)
  })

  test('la sala de 200 documentos cabe en 900 px a 1440x900', async ({ page }) => {
    await page.setViewportSize(VIEWPORT)
    await devLogin(page, OWNER_EMAIL, /\/es\/my-company/)
    await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' })
    await esperaLaVentana(page, MAX_RENDERED_DOCUMENTS, DOCUMENT_COUNT)
    await expect(page.getByTestId('room-tree-resize')).toHaveAttribute(
      'data-resize-ready',
      'true',
      { timeout: WAIT_SALA_MS }
    )
    await expect(shell(page).getByTestId('room-file')).toHaveCount(MAX_RENDERED_DOCUMENTS)
    const alto = await mideAltoDeLaSala(page)
    console.info(
      [
        ['panel', 'clientH', 'scrollH'].join('\t'),
        ['pagina', String(alto.pagina), String(alto.viewport)].join('\t'),
        ['tree', String(alto.treeClientH), String(alto.treeScrollH)].join('\t'),
        ['sidebar', String(alto.sidebarClientH), ''].join('\t'),
        ['canvas', String(alto.canvasClientH), ''].join('\t'),
      ].join('\n')
    )
    expect(
      alto.pagina,
      `scrollHeight ${alto.pagina}px exceeds the ${VIEWPORT.height}px canvas`
    ).toBeLessThanOrEqual(VIEWPORT.height)
    expect(alto.treeScrollH).toBeGreaterThan(alto.treeClientH)
  })
})
