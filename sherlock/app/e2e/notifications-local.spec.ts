import { expect, test } from '@playwright/test'

import { devLogin } from './helpers/journeys'

test('notifications tabs fit at 320px after the local backend resolves the profile', async ({
  page,
}) => {
  const backend = new URL(process.env.NEXT_PUBLIC_CONVEX_URL ?? 'https://placeholder.convex.cloud')
  expect(['127.0.0.1', 'localhost']).toContain(backend.hostname)
  expect(process.env.E2E_DEV_AUTH_USE_SEEDED_CONVEX).toBe('true')
  expect(process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY).toBeTruthy()

  await page.setViewportSize({ width: 320, height: 800 })
  await devLogin(page, 'company@dev.local', /\/es\/my-company\/documents/)
  await page.getByRole('button', { name: 'Abrir menú', exact: true }).click()
  await page.getByTestId('compact-notifications-link').click()
  await expect(page).toHaveURL(/\/es\/notifications(?:\?.*)?$/)
  await expect(page.getByRole('heading', { name: 'Notificaciones', level: 1 })).toBeVisible()

  const tabs = page.getByRole('tablist')
  await expect(tabs).toBeVisible()
  await expect(tabs.getByRole('tab')).toHaveCount(3)

  for (const name of [/Todas/, /Sin leer/, /Leídas/]) {
    const tab = tabs.getByRole('tab', { name })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const geometry = await tabs.evaluate((element) => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      tabs: element.scrollWidth,
      available: element.clientWidth,
    }))
    expect(geometry.page).toBe(320)
    expect(geometry.viewport).toBe(320)
    expect(geometry.body).toBeLessThanOrEqual(320)
    expect(geometry.tabs).toBeLessThanOrEqual(geometry.available)
  }
})
