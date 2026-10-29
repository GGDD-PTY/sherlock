import { expect, test } from '@playwright/test'

import { loginAsDemoUser } from './helpers/auth'

// El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
// responde 308 a `/es`, así que el navbar solo tiene una cara que probar.
const CASES: ReadonlyArray<{
  readonly locale: 'es'
  readonly menuLabel: string
  readonly role: 'company' | 'admin'
  readonly route: string
  readonly signOutLabel: string
  readonly viewAsLabel?: string
}> = [
  {
    locale: 'es',
    menuLabel: 'Abrir menú',
    role: 'company',
    route: '/es/my-company/documents',
    signOutLabel: 'Cerrar sesión',
  },
  {
    locale: 'es',
    menuLabel: 'Abrir menú',
    role: 'admin',
    route: '/es/admin',
    signOutLabel: 'Cerrar sesión',
    viewAsLabel: 'Ver como...',
  },
]

for (const scenario of CASES) {
  test(`${scenario.role} navbar remains contained and complete at 768px in ${scenario.locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await loginAsDemoUser(page, scenario.role)

    const response = await page.goto(scenario.route, { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)

    const rootGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(rootGeometry).toEqual({ clientWidth: 768, scrollWidth: 768 })

    // La reorganización del navbar ([F] 2026-09-01, `a918e5ec`) dejó cerrar
    // sesión y «Ver como...» dentro del menú, no sueltos en la barra.
    await page.getByRole('button', { exact: true, name: scenario.menuLabel }).click()
    await expect(page.getByRole('button', { name: scenario.signOutLabel })).toBeVisible()

    if (scenario.viewAsLabel) {
      await expect(page.getByRole('button', { name: scenario.viewAsLabel })).toBeVisible()
    }

    const openGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(openGeometry).toEqual({ clientWidth: 768, scrollWidth: 768 })
  })
}

// La campana de avisos vive solo en `desktop-secondary-navigation`, que está
// oculto bajo xl: en teléfono el menú compacto es la única puerta, y la página
// que abre tiene que caber en el ancho más angosto que se sirve. Las dos
// mediciones viven acá porque las dos son del navbar compacto y su destino.
// O6-02: esta suite usa Convex placeholder. Las pestañas con datos se prueban
// contra el backend local en notifications-local.spec.ts.
test('the compact menu reaches Notificaciones and the page fits a 320px body', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await loginAsDemoUser(page, 'company')

  // `networkidle`, como los casos de arriba: con `domcontentloaded` el clic
  // llega antes de la hidratación y el Sheet no abre.
  await page.goto('/es/my-company/documents', { waitUntil: 'networkidle' })
  await page.getByRole('button', { exact: true, name: 'Abrir menú' }).click()

  const notificationsRow = page.getByTestId('compact-notifications-link')
  await expect(notificationsRow).toBeVisible()
  await expect(notificationsRow).toHaveAttribute('href', '/es/notifications')

  await notificationsRow.click()
  await expect(page).toHaveURL(/\/es\/notifications(?:\?.*)?$/)
  await expect(page.getByRole('heading', { name: 'Notificaciones', level: 1 })).toBeVisible()

  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
  console.log('[notifications 320px]', JSON.stringify(geometry))
  expect(geometry.scrollWidth).toBe(geometry.clientWidth)
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
})
