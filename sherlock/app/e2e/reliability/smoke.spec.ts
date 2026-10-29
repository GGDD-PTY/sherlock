import { test, expect } from '../fixtures/driver-fixture'
import { defaultLocale, locales } from '../../src/i18n/config'

const IS_DEMO_AUTH =
  process.env.BYPASS_AUTH === 'true' || process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true'
const E2E_SERVER_MODE = process.env.E2E_SERVER_MODE ?? (IS_DEMO_AUTH ? 'dev' : 'start')

test.describe('Browser Reliability Smoke', () => {
  test('redirects root request to the localized experience', async ({ driver }) => {
    await driver.goto('/')
    await driver.waitForLoadState('domcontentloaded')

    const currentUrl = await driver.currentUrl()
    expect(currentUrl).not.toMatch(/\/$/)
    expect(locales.some((locale) => currentUrl.endsWith(`/${locale}`))).toBe(true)
  })

  test('loads localized landing page', async ({ driver }) => {
    await driver.goto(`/${defaultLocale}`)
    await driver.waitForLoadState('domcontentloaded')

    const currentUrl = await driver.currentUrl()
    expect(currentUrl).toContain(`/${defaultLocale}`)

    // Estructura real de la landing, no solo una URL o un título no vacíos.
    // Ambas aserciones van por rol (snapshot de accesibilidad) porque el
    // driver agent-browser no resuelve selectores CSS descendientes.
    const nav = await driver.first(await driver.getByRole('navigation'))
    expect(await driver.isVisible(nav)).toBe(true)

    // El h1 se ubica por testid, no por copy: el titular del hero cambia con
    // cada corte de texto y el smoke solo debe probar que la estructura existe.
    const heroHeading = await driver.getByTestId('landing-hero-title')
    expect(await driver.isVisible(heroHeading)).toBe(true)
  })

  test('former marketplace URLs return 404 like any unknown route', async ({ request }) => {
    const response = await request.get(`/${defaultLocale}/deals`, { maxRedirects: 0 })

    expect(response.status()).toBe(404)
    expect(response.url()).toContain('/deals')
    expect(response.headers()['location']).toBeUndefined()
  })

  test('loads the sign-in entry page', async ({ driver }) => {
    await driver.goto(`/${defaultLocale}/sign-in`)
    await driver.waitForLoadState('domcontentloaded')

    const currentUrl = await driver.currentUrl()
    if (IS_DEMO_AUTH) {
      expect(currentUrl).toMatch(/\/(sign-in|dev-login)/)
    } else {
      expect(currentUrl).toContain('/sign-in')
    }

    const title = await driver.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test('loads the demo auth entry when bypass auth is enabled', async ({ driver }) => {
    test.skip(
      !(IS_DEMO_AUTH && E2E_SERVER_MODE === 'dev'),
      'Demo auth smoke only applies in dev server mode with bypass auth enabled'
    )

    await driver.goto(`/${defaultLocale}/dev-login`)
    await driver.waitForLoadState('domcontentloaded')

    const currentUrl = await driver.currentUrl()
    expect(currentUrl).toContain('/dev-login')

    const title = await driver.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test('loads the demo company preparation room without hydration errors', async ({ page }) => {
    test.skip(
      !(IS_DEMO_AUTH && E2E_SERVER_MODE === 'dev' && process.env.E2E_DRIVER !== 'agent-browser'),
      'Hydration smoke uses Playwright page in demo dev mode'
    )

    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') {
        pageErrors.push(message.text())
      }
    })

    await page.goto('/es/dev-login?as=company')
    await page.waitForLoadState('domcontentloaded')
    await page.goto('/es/my-company/documents')
    await page.waitForLoadState('networkidle')

    expect(pageErrors.filter((error) => /hydration|uncaught error/i.test(error))).toEqual([])
  })
})
