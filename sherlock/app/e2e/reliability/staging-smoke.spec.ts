import { expect, test } from '@playwright/test'

import esMessages from '../../src/messages/es.json'

// Rutas públicas vivas. `/es/help` y `/es/roadmap` se fusionaron en `/es/ayuda`
// ([F] 2026-09-01) y responden 308: probarlas aquí solo medía el redirect.
const publicRoutes = ['/', '/es', '/es/ayuda', '/es/privacy', '/es/terms', '/es/legal']

const missingRoutes = ['/es/deals', '/es/companies', '/es/pricing', '/es/investors']

// El enlace del wordmark en la barra pública: contenido de la app que el login
// de Vercel no tiene.
const appHomeLinkName = esMessages.common.navbar.aria.sherlockHome

// Staging vive detrás de Vercel Deployment Protection. Sin el header de bypass
// cada request termina en el login de Vercel. El secreto es el token de
// automatización que el proyecto ya tiene y se lee del entorno. Va solo el header:
// con `x-vercel-set-bypass-cookie` Vercel contesta primero un 307 a la misma URL,
// y los checks con `maxRedirects: 0` verían ese 307 en vez del 404.
// Playwright copia los headers al «Call log» de un request que lanza error, así
// que una corrida fallida puede dejar el secreto en test-results/ y
// playwright-report/ (ignorados por git): se borran después de cada corrida.
const protectionBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()

if (protectionBypassSecret) {
  test.use({
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': protectionBypassSecret,
    },
  })
}

test.beforeEach(async ({ baseURL, page }) => {
  if (!baseURL) {
    throw new Error('E2E_BASE_URL is required for staging smoke')
  }

  const allowedOrigin = new URL(baseURL).origin

  await page.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.protocol.startsWith('http') && requestUrl.origin !== allowedOrigin) {
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
})

test.describe('Staging smoke', () => {
  for (const route of publicRoutes) {
    test(`loads ${route}`, async ({ baseURL, page }) => {
      const response = await page.goto(route)

      expect(response, `${route} should return a document response`).not.toBeNull()
      // El guard de `page.route` no ve un redirect de navegación: sin estas dos
      // aserciones la prueba pasaba sobre el login de Vercel (200, otro origen).
      expect(new URL(page.url()).origin, `${route} should stay on the app origin`).toBe(
        new URL(baseURL!).origin
      )
      expect(response!.status(), `${route} should render the page`).toBe(200)

      await page.waitForLoadState('domcontentloaded')
      await expect(page).toHaveTitle(/Sherlock/)
      await expect(page.getByRole('link', { name: appHomeLinkName })).toBeVisible()
    })
  }

  for (const route of missingRoutes) {
    test(`answers former marketplace URL ${route} with 404`, async ({ request }) => {
      const response = await request.get(route, { maxRedirects: 0 })

      expect(response.status(), `${route} should not exist`).toBe(404)
      expect(response.url()).toContain(route)
      expect(response.headers()['location']).toBeUndefined()
    })
  }

  test('reports healthy app dependencies', async ({ request }) => {
    const response = await request.get('/api/health')

    expect(response.status(), '/api/health should be healthy before private beta').toBe(200)

    const payload = await response.json()
    expect(JSON.stringify(payload)).not.toContain('localhost')
  })
})
