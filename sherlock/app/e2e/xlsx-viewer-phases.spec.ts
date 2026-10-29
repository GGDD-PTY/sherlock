// ============================================================================
// VISOR XLSX — PROGRESO POR FASES (plan del sitio, item B3a)
// ============================================================================
// El libro del modelo tarda decenas de segundos en pintar (PR #490: SAMPLE_HYDRO con 8
// hojas, `openWorkbook` 23,7 s y primer render 27,5 s). El item B3a esta hecho
// cuando ese rato deja de ser mudo: "el texto de progreso cambia al menos dos
// veces" durante una apertura real.
//
// Esta spec lo comprueba sobre el libro de SAMPLE_HYDRO que ya vive en `e2e/fixtures/`,
// no sobre un doble: el banco `/es/dev-viewers` monta el <DocumentViewer/> real
// y la ruta del grant devuelve los bytes del fixture.
//
// Como se mide el cambio de texto. El criterio se comprueba sobre el TIMELINE
// (`data-xlsx-marks`), traducido a copy con la misma tabla que usa el visor: es
// la secuencia de estados por la que pasa el rotulo, y no depende de cuando
// React haga commit. Con el fixture de 10 KB hay marcas separadas por menos de
// un milisegundo (`wasm-ready` y `parsing` son sincronas), y React puede
// resolverlas en un solo commit: contar lo que alcanzo a pintarse ahi seria una
// prueba que aprueba o reprueba segun la maquina.
//
// El MutationObserver del `addInitScript` sigue puesto, pero como TESTIGO: se
// imprime, y solo se exige que lo que se vio sea una subsecuencia de lo que el
// timeline predice. Asi la spec reporta el render real sin depender de el.
//
// Ademas imprime el reparto del tiempo por fase (linea `XLSX_PHASES {...}`),
// leido de `data-xlsx-marks`, que es la misma instrumentacion que sobrevive al
// render final.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { xlsxPhaseMessageKey } from '../src/components/documents/viewers/xlsxPhases'
import esMessages from '../src/messages/es.json'

// El libro sintético de Andina Solar está incluido en el repositorio.
// XLSX_PHASES_WORKBOOK permite usar otro archivo local para pruebas deliberadas.
const FIXTURE_WORKBOOK = join(process.cwd(), 'e2e', 'fixtures', 'andina-solar-modelo.xlsx')
const WORKBOOK = process.env.XLSX_PHASES_WORKBOOK || FIXTURE_WORKBOOK
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const GRANT_URL = '/api/documents/access/grant_phases?token=phases'

/** Fases que el sidecar publica, en orden (`mog-sidecar/src/phases.js`). */
const EXPECTED_PHASES = [
  'boot',
  'bytes-received',
  'wasm-ready',
  'parsing',
  'first-sheet',
  'rendered',
] as const

const COPY = esMessages.vdr.viewer as Record<string, string>

declare global {
  interface Window {
    __sherlockXlsxLabels?: string[]
  }
}

/**
 * Traduce el timeline a la secuencia de rotulos por la que pasa el esqueleto,
 * con la misma tabla del visor. Arranca en `loadingSheets`, que es lo que se
 * pinta mientras bajan los bytes, y se corta en `rendered`, que retira el
 * esqueleto en vez de rotularlo.
 */
function labelsFromMarks(marks: { phase: string }[]): string[] {
  const labels: string[] = []
  const push = (key: string) => {
    const text = COPY[key]
    if (text && labels.at(-1) !== text) labels.push(text)
  }

  push('loadingSheets')
  for (const mark of marks) {
    if (mark.phase === 'rendered' || mark.phase === 'error') break
    push(xlsxPhaseMessageKey(mark.phase as Parameters<typeof xlsxPhaseMessageKey>[0]))
  }
  return labels
}

/** `observed` tiene que ser una subsecuencia de `expected`, en el mismo orden. */
function isSubsequence(observed: string[], expected: string[]): boolean {
  let cursor = 0
  for (const text of observed) {
    cursor = expected.indexOf(text, cursor)
    if (cursor === -1) return false
    cursor += 1
  }
  return true
}

/** Anota cada texto distinto del rotulo del esqueleto, desde antes del primer render. */
async function recordProgressLabels(page: Page) {
  await page.addInitScript(() => {
    window.__sherlockXlsxLabels = []
    const record = () => {
      const node = document.querySelector('[data-testid="document-viewer-frame-loading-label"]')
      const text = node?.textContent?.trim()
      const seen = window.__sherlockXlsxLabels
      if (!text || !seen) return
      if (seen[seen.length - 1] !== text) seen.push(text)
    }
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
}

function parseMarks(serialized: string): { phase: string; at: number }[] {
  return serialized
    .split(' ')
    .filter(Boolean)
    .map((entry) => {
      const [phase, at] = entry.split(':')
      return { phase, at: Number(at) }
    })
}

test.describe('Visor XLSX — esqueleto con fases reales', () => {
  // Los ganchos de tiempo estan gateados: `playwright.config.ts` prende la
  // bandera, y un servidor manual sin ella no puede probar nada.
  test.skip(
    process.env.NEXT_PUBLIC_XLSX_PHASE_MARKS !== 'true',
    'Requiere NEXT_PUBLIC_XLSX_PHASE_MARKS=true en el servidor bajo prueba'
  )

  test('el texto de progreso cambia al menos dos veces y el timeline queda medido', async ({
    page,
  }) => {
    // El runtime de Mog baja 41 MB de WASM antes de leer una sola celda.
    test.setTimeout(180_000)

    await recordProgressLabels(page)
    await page.route('**/api/documents/access/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: XLSX_MIME,
        headers: { 'Cache-Control': 'private, no-store' },
        body: readFileSync(WORKBOOK),
      })
    })

    const search = new URLSearchParams({
      viewUrl: GRANT_URL,
      fileName: 'andina-solar-modelo.xlsx',
      mimeType: XLSX_MIME,
    })
    await page.goto(`/es/dev-viewers?${search.toString()}`)

    // El esqueleto tiene que existir ANTES del libro: si no hubiera espera que
    // narrar, esta prueba no probaria nada.
    await expect(page.getByTestId('document-viewer-frame-loading')).toBeVisible({ timeout: 30_000 })

    const sidecar = page.frameLocator('[data-testid="document-viewer-mog-frame"]')
    await expect(sidecar.locator('canvas').first()).toBeVisible({ timeout: 150_000 })
    await expect(page.getByTestId('document-viewer-frame-loading')).toHaveCount(0, {
      timeout: 150_000,
    })

    const labels = (await page.evaluate(() => window.__sherlockXlsxLabels ?? [])) as string[]
    const marks = parseMarks(
      (await page.getByTestId('document-viewer-mog-frame').getAttribute('data-xlsx-marks')) ?? ''
    )

    const timings = marks.map((mark, index) => ({
      phase: mark.phase,
      atMs: mark.at,
      deltaMs: index === 0 ? mark.at : mark.at - marks[index - 1].at,
    }))
    const expectedLabels = labelsFromMarks(marks)
    console.log(
      `XLSX_PHASES ${JSON.stringify({
        workbook: WORKBOOK === FIXTURE_WORKBOOK ? 'andina-solar-fixture' : WORKBOOK,
        expectedLabels,
        observedLabels: labels,
        timings,
        totalMs: marks.at(-1)?.at ?? null,
      })}`
    )

    // El criterio del item B3a: dos cambios de texto son tres rotulos distintos.
    // Se mide sobre el timeline, que es la secuencia de estados del rotulo y no
    // depende de como React agrupe los commits.
    expect(
      expectedLabels.length,
      `progreso derivado del timeline: ${expectedLabels.join(' -> ')}`
    ).toBeGreaterThanOrEqual(3)
    expect(new Set(expectedLabels).size).toBe(expectedLabels.length)

    // Y lo que de verdad se pinto tiene que ser parte de esa secuencia: si el
    // rotulo mostrara un texto que el timeline no predice, aqui se ve.
    expect(
      isSubsequence(labels, expectedLabels),
      `observado ${labels.join(' -> ')} contra esperado ${expectedLabels.join(' -> ')}`
    ).toBe(true)
    expect(labels[0]).toBe(COPY.loadingSheets)

    // El timeline llega COMPLETO, en orden y con reloj no decreciente.
    //
    // Que el reductor tolere una fase omitida (`xlsxPhases.ts`) y que esta spec
    // las exija todas no es una contradiccion: son garantias distintas para
    // publicos distintos. La del reductor protege al cliente en produccion
    // contra un sidecar que se salte algo. La de aqui protege el producto: si
    // NUESTRO sidecar deja de publicar una fase, el rato mudo vuelve y esa es
    // la razon de ser del item. Aflojar esto a una subsecuencia dejaria caer en
    // silencio `wasm-ready`, `parsing` y `first-sheet`, que es justamente el
    // tramo de 23,7 s donde el esqueleto se quedaba callado.
    //
    // `src/__tests__/architecture/mog-sidecar-phases.test.ts` NO sustituye esta
    // asercion: lee `main.js` como texto y solo prueba que los seis call sites
    // existen en el fuente. Que se alcancen en tiempo de ejecucion (`rendered`
    // vive dentro de `onReady`, `first-sheet` dentro del camino de apertura)
    // solo lo prueba una corrida real como esta.
    expect(marks.map((mark) => mark.phase)).toEqual([...EXPECTED_PHASES])
    for (const [index, mark] of marks.entries()) {
      expect(Number.isFinite(mark.at)).toBe(true)
      if (index > 0) expect(mark.at).toBeGreaterThanOrEqual(marks[index - 1].at)
    }
    await expect(page.getByTestId('document-viewer-mog-frame')).toHaveAttribute(
      'data-xlsx-phase',
      'rendered'
    )
  })
})
