import { expect, test } from '@playwright/test'

import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'

test.describe('Admin preparation oversight', () => {
  test.skip(!IS_DEMO_AUTH, 'Requires local dev-auth mode')

  // El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
  // responde 308 a `/es`, así que la cara admin se prueba en su único idioma.
  test('exposes the human-review queue without document contents', async ({ page }) => {
    await loginAsDemoUser(page, 'admin')
    await page.goto('/es/admin/support', { waitUntil: 'domcontentloaded' })

    await expect(
      page.getByRole('heading', { level: 1, name: 'Soporte y Data Rooms por revisar' })
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Cola de Data Rooms por revisar' })
    ).toBeVisible()
    await expect(
      page.getByText(
        'Señales reales de preparación, soporte, evaluaciones y borradores que requieren atención humana.'
      )
    ).toBeVisible()
    await expect(page.getByTestId('admin-support-conversation')).toBeVisible()
  })
})
