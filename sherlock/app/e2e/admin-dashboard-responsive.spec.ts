// ============================================================================
// /admin A 375px — la vista general del equipo cabe en un telefono
// ============================================================================
// La pantalla es una franja de consumo con series, una tabla ancha de salas y
// dos listas cortas. El indice de enlaces salio con O1-01: esos destinos viven
// en la barra. Lo que se prueba aca es la ESTRUCTURA por testid, no el copy:
// un cambio de redaccion no puede poner rojo un test de reflow, y una seccion
// que desaparece si tiene que ponerlo.
//
// La tabla de salas trae once columnas: su contenedor scrollea solo. Si ese
// scroll se escapa al documento, el telefono queda con barra horizontal — esa
// es la regresion que este spec existe para atrapar.
//
// UNA sola cara ([F] 2026-09-01, DECISIONS "Sitio solo en espanol"): `/en/*`
// responde 308 al mismo camino en `/es` antes de AuthKit, asi que recorrer los
// dos idiomas rendia cuatro corridas de la MISMA pantalla en espanol y dos
// fallos que no eran de producto. Queda el eje que si cambia el layout: el tema.
// ============================================================================

import { expect, test } from '@playwright/test'
import { loginAsDemoUser } from './helpers/auth'

const COLOR_SCHEMES = ['light', 'dark'] as const

const VIEWPORT_WIDTH = 375

const REGIONS = [
  'admin-overview-usage',
  'admin-overview-series',
  'admin-overview-rooms',
  'admin-overview-alerts',
  'admin-overview-support',
] as const

for (const colorScheme of COLOR_SCHEMES) {
  test(`admin overview reflows at 375px in ${colorScheme}`, async ({ page }) => {
    // Given
    const relativeTimeFallbacks: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('ENVIRONMENT_FALLBACK')) {
        relativeTimeFallbacks.push(message.text())
      }
    })
    page.on('pageerror', (error) => {
      if (error.message.includes('ENVIRONMENT_FALLBACK')) {
        relativeTimeFallbacks.push(error.message)
      }
    })
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: 900 })
    await page.emulateMedia({ colorScheme })
    await page.addInitScript((theme) => localStorage.setItem('theme', theme), colorScheme)
    await loginAsDemoUser(page, 'admin')

    // When
    await page.goto('/es/admin', { waitUntil: 'networkidle' })

    // Then — las cinco secciones de la vista general siguen en pie.
    for (const region of REGIONS) {
      await expect(page.getByTestId(region)).toBeVisible()
    }

    // El unico enlace a los controles de seguridad vive en la cabecera.
    const securityControls = page.getByRole('link', { name: 'Controles de seguridad' })
    await expect(securityControls).toBeVisible()

    const securityRect = await securityControls.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
    expect(securityRect.left).toBeGreaterThanOrEqual(0)
    expect(securityRect.right).toBeLessThanOrEqual(VIEWPORT_WIDTH)

    // La tabla de salas desborda a proposito, pero dentro de su contenedor.
    const roomsTable = page.getByTestId('admin-overview-rooms-table')
    await expect(roomsTable).toBeVisible()
    const roomsOverflow = await roomsTable.evaluate((table) => {
      const container = table.closest('[data-slot="table-container"]')
      if (!container) return null
      return {
        containerWidth: container.getBoundingClientRect().width,
        overflowX: getComputedStyle(container).overflowX,
      }
    })
    expect(roomsOverflow).not.toBeNull()
    expect(roomsOverflow?.overflowX).toBe('auto')
    expect(roomsOverflow?.containerWidth).toBeLessThanOrEqual(VIEWPORT_WIDTH)

    // Cada fila abre la sala de su empresa.
    const roomLink = roomsTable.locator('tbody a[href*="/admin/companies/"]').first()
    await expect(roomLink).toBeVisible()
    await expect(roomLink).toHaveAttribute('href', /\/admin\/companies\/[^/]+\/documents$/)

    // Ninguna de esas anchuras se escapa al documento.
    const documentWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(documentWidths.scroll).toBe(documentWidths.client)

    expect(relativeTimeFallbacks).toEqual([])
  })
}
