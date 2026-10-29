// ============================================================================
// Las rutas vivas del panel: un h1, la barra marca la activa, sin scroll lateral
// ============================================================================
// D2 ([F] 2026-09-11) dejó ocho rutas vivas y retiró seis; `vdr-requests` salió
// después, con el subsistema de transacciones, y `nda` el mismo día, sin
// página desde la salida de INVESTOR ([F] 2026-09-17). Desde O1-01 la
// barra lateral es el único índice del panel: si deja de marcar la ruta
// activa, el equipo pierde la única pista de dónde está. Las rutas retiradas
// no tienen destino y responden 404.
//
// Las vivas no se escriben acá: salen del catálogo del panel
// (`src/lib/product/admin-routes.ts`), que es la única lista que el registro de
// navegación y este spec leen ([F] 2026-09-17). La de retiradas sí se escribe
// a mano: es un candado anti-regreso, no un catálogo.
// ============================================================================

import { expect, test, type Page } from '@playwright/test'

import { ADMIN_ROUTES } from '@/lib/product/admin-routes'
import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'

// Las URLs conservan el prefijo de locale; el sitio ships solo en español.
const LOCALE_PREFIX = '/es'

const LIVE_ROUTES = ADMIN_ROUTES.map((route) => ({
  path: `${LOCALE_PREFIX}${route.paths[0]}`,
  label: route.nav.label,
}))

const RETIRED_NOT_FOUND = [
  '/es/admin/vdr-requests',
  '/es/admin/nda',
  '/es/admin/users',
  '/es/admin/kyc',
  '/es/admin/analytics',
  '/es/admin/audit-logs',
  '/es/admin/nda-templates',
  '/es/admin/activity',
] as const

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 375, height: 900 },
] as const

// El corte `md` de `useIsMobile`: debajo de él la barra es un Sheet.
const MOBILE_BREAKPOINT = 768

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(widths.scroll).toBe(widths.client)
}

async function expectSidebarMarksActive(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: 'Navegación de administración' })
  // Playwright 1.61 no filtra `getByRole` por `aria-current`, así que se lee el
  // atributo: `aria-current` lo pone AdminSidebar y `data-active` es la señal
  // con la que el bloque sidebar-07 pinta la fila.
  const current = nav.locator('a[aria-current="page"]')
  await expect(current).toHaveCount(1)
  await expect(current).toHaveAccessibleName(label)
  await expect(current).toHaveAttribute('data-active', 'true')
}

// Sin navegador y sin sesión: las dos listas no pueden volver a cruzarse. Una
// ruta retirada que reaparezca en el catálogo vuelve a pintarse en la barra, y
// el 404 de abajo dejaría de probar lo que dice probar.
test('ninguna ruta retirada volvió al catálogo del panel', () => {
  const live = new Set(LIVE_ROUTES.map((route) => route.path))
  expect(RETIRED_NOT_FOUND.filter((path) => live.has(path))).toEqual([])
})

test.describe('Admin routes', () => {
  test.skip(!IS_DEMO_AUTH, 'Requires local dev-auth mode')

  for (const route of LIVE_ROUTES) {
    test(`${route.path} has one h1, marks the sidebar, and does not scroll sideways`, async ({
      page,
    }) => {
      await loginAsDemoUser(page, 'admin')

      for (const viewport of VIEWPORTS) {
        const isMobile = viewport.width < MOBILE_BREAKPOINT
        await page.setViewportSize(viewport)
        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        expect(response?.status()).toBe(200)

        if (isMobile) {
          // `useIsMobile` arranca en false: la columna de escritorio se
          // desmonta recién al hidratar. Medir antes mide otra pantalla.
          await expect(page.locator('[data-slot="sidebar-gap"]')).toHaveCount(0)
        }

        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
        await expectNoHorizontalOverflow(page)

        if (isMobile) {
          await page.getByRole('button', { name: 'Menú de administración' }).click()
        }
        await expectSidebarMarksActive(page, route.label)
      }
    })
  }

  test('retired admin pages respond 404', async ({ page }) => {
    await loginAsDemoUser(page, 'admin')

    for (const path of RETIRED_NOT_FOUND) {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status(), path).toBe(404)
      await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible()
    }
  })
})
