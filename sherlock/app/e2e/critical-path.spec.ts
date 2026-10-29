// ============================================================================
// E2E TEST: CRITICAL PATH — Core Revenue Flow
// ============================================================================
// Tests the essential user journeys that drive revenue:
//   1. Landing (Mycroft intake home) → document selection
//   2. Retired product routes return 410 Gone
//   3. Auth flows redirect correctly
//   4. API health check responds
//   5. Legal pages load
//
// This spec is explicitly included in `test:e2e:smoke` (package.json) alongside
// e2e/reliability/smoke.spec.ts, and runs merge-blocking in the CI "E2E Smoke
// Test" job (.github/workflows/ci.yml).
// Uses demo auth when BYPASS_AUTH is enabled.
// ============================================================================

import { test, expect } from '@playwright/test'

const defaultLocale = 'es'

// ============================================================================
// 1. LANDING & RETIRED PRICING FLOW
// ============================================================================

test.describe('Critical Path: Sell-side intake', () => {
  test('landing page loads with call-to-action', async ({ page }) => {
    await page.goto(`/${defaultLocale}`)
    await page.waitForLoadState('domcontentloaded')

    // Page should have main content
    const main = page.locator('main')
    await expect(main).toBeVisible()

    await expect(page.getByText('Seleccionar documentos', { exact: true })).toBeVisible()
  })
})

// ============================================================================
// 2. DEAL MARKETPLACE
// ============================================================================
// NOTE (tier b, 2026-07-24): the former "Analysis Pages" block here tested
// /analisis and /valuacion — both removed from the app in T4 (analysis-engine
// de-embed, now external at ~/Developer/financial-engines/). Those
// routes 404 today; trimmed. Backup at
// ~/Developer/sherlock-miscelaneos/tier-b-2026-07-24/.
// ============================================================================

// Las URLs del marketplace no existen ([F] 2026-09-16): responden 404 como
// cualquier ruta desconocida, sin 410 ni 307 al home.
test.describe('Critical Path: former marketplace URLs do not exist', () => {
  for (const segment of ['deals', 'companies', 'investors', 'pricing', 'precios'] as const) {
    test(`${segment} returns 404 like any unknown route`, async ({ request }) => {
      const response = await request.get(`/${defaultLocale}/${segment}`, { maxRedirects: 0 })

      expect(response.status()).toBe(404)
      expect(response.url()).toContain(`/${segment}`)
      expect(response.headers()['location']).toBeUndefined()
    })
  }
})

// ============================================================================
// 3. AUTH FLOWS
// ============================================================================

test.describe('Critical Path: Auth Flows', () => {
  test('sign-in page loads', async ({ page }) => {
    await page.goto(`/${defaultLocale}/sign-in`)
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('sign-in')

    // Page should have content (auth widget or custom form)
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test('sign-up page loads', async ({ page }) => {
    await page.goto(`/${defaultLocale}/sign-up`)
    await page.waitForLoadState('domcontentloaded')

    // Con dev-auth la página de sign-up redirige a dev-login por diseño
    // (LESSONS 2026-09-02, d375ffa19); el loading.tsx raíz lo escondía tras
    // el streaming hasta #507.
    const url = page.url()
    expect(url).toMatch(/sign-up|dev-login/)
  })

  test('protected routes redirect to sign-in', async ({ page }) => {
    // La sala de la empresa es la ruta protegida: `/dashboard` dejó de existir
    // ([F] 2026-09-07 09:00).
    await page.goto(`/${defaultLocale}/my-company/documents`)
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    // Un anónimo nunca se queda en la sala: sign-in, o dev-login cuando el dev-auth está activo.
    expect(url).toMatch(/sign-in|dev-login/)
    expect(url).not.toMatch(/my-company/)
  })
})

// ============================================================================
// 4. API HEALTH
// ============================================================================

test.describe('Critical Path: API Health', () => {
  test('health endpoint responds', async ({ request }) => {
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)

    const data = await response.json()
    // NOTE (tier b, 2026-07-24): /api/health dropped the 8-microservice pings
    // in T9 — the response now only ever reports 'healthy' | 'unhealthy'
    // (convex up/down is the sole check). See src/app/api/health/route.ts.
    expect(['healthy', 'unhealthy']).toContain(data.status)
  })

  test('static pages have security headers', async ({ request }) => {
    const response = await request.get(`/${defaultLocale}`)
    const headers = response.headers()

    // HSTS should be set
    expect(headers['x-content-type-options']).toBe('nosniff')
  })
})

// ============================================================================
// 5. LEGAL PAGES (Required for compliance)
// ============================================================================

test.describe('Critical Path: Legal Pages', () => {
  test('privacy policy loads', async ({ page }) => {
    await page.goto(`/${defaultLocale}/privacy`)
    await page.waitForLoadState('domcontentloaded')

    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible()
  })

  test('terms of service loads', async ({ page }) => {
    await page.goto(`/${defaultLocale}/terms`)
    await page.waitForLoadState('domcontentloaded')

    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible()
  })

  test('help page loads', async ({ page }) => {
    await page.goto(`/${defaultLocale}/help`)
    await page.waitForLoadState('domcontentloaded')

    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible()
  })
})
