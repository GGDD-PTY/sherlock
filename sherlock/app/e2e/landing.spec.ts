// ============================================================================
// E2E TEST: LANDING PAGE
// ============================================================================
// Tests básicos para verificar que la landing page carga correctamente.
// Uses the driver abstraction layer - works with both Playwright and agent-browser.
//
// Run with Playwright (default):
//   bun run test:e2e -- e2e/landing.spec.ts
//
// Run with agent-browser:
//   E2E_DRIVER=agent-browser bun run test:e2e -- e2e/landing.spec.ts
// ============================================================================

import { test, expect } from './fixtures/driver-fixture'

test.describe('Landing Page', () => {
  test('should load the landing page', async ({ driver }) => {
    await driver.goto('/')

    // Verificar que el título contiene la marca visible del producto.
    const title = await driver.title()
    expect(title).toMatch(/Sherlock/i)
  })

  test('should display the hero section', async ({ driver }) => {
    await driver.goto('/')

    // Verificar elementos del hero - buscar el main element
    const main = await driver.locator('main')
    expect(await driver.isVisible(main)).toBe(true)
  })

  test('should have navigation links', async ({ driver }) => {
    await driver.goto('/')

    // Verificar navbar
    const navbar = await driver.locator('nav')
    expect(await driver.isVisible(navbar)).toBe(true)

    // Landing mínima ([F] 2026-09-14): la barra pública queda con «Ayuda y cómo
    // funciona» (`common.navbar.helpAndHow`), Tema e Iniciar sesión. «Empieza tu
    // Data Room» salió porque llevaba a la misma página; la sala empieza en la
    // capa de subida de la propia landing.
    const supportLink = await driver.getByRole('link', { name: 'Ayuda y cómo funciona', exact: true })
    expect(await driver.isVisible(supportLink)).toBe(true)
  })

  test('should expose a public access entry point when not authenticated', async ({ driver }) => {
    await driver.goto('/')

    // In demo-auth mode the navbar shows Demo Login; in real-auth mode it shows
    // sign-in/sign-up actions. The public landing also exposes request-access CTAs.
    const accessEntryPoint = await driver.locator(
      // STALE_TEST (decisión de la estación 2026-09-12): la puerta pública es
      // `<a href="/es/sign-in">Iniciar sesión</a>` desde que la barra del sitio
      // dejó de consultar sesión; el selector no la nombraba.
      'a[href*="/sign-in"], a[href*="/dev-login"], a[href*="/sign-up"], button:has-text("Sign In"), button:has-text("Iniciar Sesión"), a:has-text("Request access"), a:has-text("Solicitar acceso")'
    )
    const firstAccessEntryPoint = await driver.first(accessEntryPoint)

    expect(await driver.isVisible(firstAccessEntryPoint)).toBe(true)
  })

  // «Empieza tu Data Room» salió de la barra pública con la landing mínima
  // ([F] 2026-09-14): el botón llevaba a la misma página. El lockup vuelve a
  // la home, que es donde una sala empieza de verdad: en la capa de subida.
  test('should send the lockup link to the landing uploader', async ({ driver }) => {
    await driver.goto('/')

    const homeLink = await driver.getByRole('link', {
      name: 'Inicio de Sherlock',
      exact: true,
    })
    const firstHomeLink = await driver.first(homeLink)
    await driver.click(firstHomeLink)

    await driver.waitForUrl(/\/es\/?$/)

    const uploadDossier = await driver.locator('[data-testid="mycroft-upload-dossier"]')
    expect(await driver.isVisible(await driver.first(uploadDossier))).toBe(true)
  })
})
