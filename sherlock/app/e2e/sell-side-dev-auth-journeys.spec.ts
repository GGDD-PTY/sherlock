import { expect, test, type Page } from '@playwright/test'

import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'

const fatalErrorPattern =
  /Application error|Internal Server Error|Unhandled Runtime Error|Runtime Error|Something went wrong|Algo sali[oó] mal|This page could not be found/i

async function expectHealthyPage(page: Page) {
  await expect(page.locator('body')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(fatalErrorPattern)
}

test.describe('WorkOS-shaped sell-side journeys (dev-auth evidence)', () => {
  test.setTimeout(120_000)
  test.skip(!IS_DEMO_AUTH, 'Requires local dev-auth mode')

  test('company enters the durable preparation workspace without marketplace detours', async ({
    page,
  }) => {
    await loginAsDemoUser(page, 'company')
    await page.goto('/es/my-company/documents', { waitUntil: 'domcontentloaded' })

    await expectHealthyPage(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Data Room' })).toBeVisible()
    await expect(page.getByTestId('vdr-room-shell')).toBeVisible()
    // Candado del corte [F] 2026-08-30: el paquete de preparación viejo no vuelve.
    await expect(page.locator('[data-testid^="deliverable-card-"]')).toHaveCount(0)

    for (const retiredHref of ['/es/deals', '/es/portfolio', '/es/messages']) {
      await expect(page.locator(`a[href="${retiredHref}"]`)).toHaveCount(0)
    }

    await page.goto('/es/my-company/preparation')
    await expect(page.getByTestId('room-progress-panel')).toBeVisible()
    await page.goto('/es/my-company/team')
    await expect(page.getByRole('heading', { name: 'Habla con el equipo' })).toBeVisible()
  })

  test('company workspace reflows without overflow at supported widths', async ({ page }) => {
    await loginAsDemoUser(page, 'company')

    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      )
      expect(overflow).toBeLessThanOrEqual(1)
      await expect(page.getByRole('heading', { level: 1, name: 'Data Room' })).toBeVisible()
    }
  })

  test('admin reaches the preparation queue and support boundary', async ({ page }) => {
    await loginAsDemoUser(page, 'admin')
    await page.goto('/es/admin/support', { waitUntil: 'domcontentloaded' })

    await expectHealthyPage(page)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Soporte y Data Rooms por revisar' })
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Cola de Data Rooms por revisar' })
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Conversaciones de soporte' })).toBeVisible()
    await expect(page.getByTestId('admin-support-conversation')).toBeVisible()
  })
})
