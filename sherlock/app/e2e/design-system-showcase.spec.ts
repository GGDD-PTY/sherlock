import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

// El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
// responde 308 a `/es`, así que el showcase tiene una sola cara servida.
const showcaseRoute = '/es/design-system'

async function openShowcase(page: Page) {
  const response = await page.goto(showcaseRoute, { waitUntil: 'networkidle' })
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Sistema de diseño' })).toBeVisible()
}

async function tabUntilFocused(page: Page, target: Locator, maximumTabs: number) {
  for (let tabCount = 1; tabCount <= maximumTabs; tabCount += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((element) => element === document.activeElement)) {
      return tabCount
    }
  }

  return 0
}

test.describe('Non-production design-system showcase interactions', () => {
  test('exposes localized landmarks, unique IDs, and a bounded document width', async ({
    page,
  }) => {
    // Given
    await openShowcase(page)

    // When
    const pageStructure = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id)
      return {
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
        language: document.documentElement.lang,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }
    })

    // Then
    await expect(page).toHaveTitle('Sistema de diseño | Sherlock')
    await expect(page.locator('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByTestId('showcase-family')).toHaveCount(6)
    expect(pageStructure.duplicateIds).toEqual([])
    expect(pageStructure.language).toBe('es')
    expect(pageStructure.scrollWidth).toBeLessThanOrEqual(pageStructure.viewportWidth)
  })

  test('activates the skip link with the keyboard', async ({ page }) => {
    // Given
    await openShowcase(page)
    const skipLink = page.getByRole('link', { name: 'Saltar al contenido principal' })

    // When
    // `next dev` monta su portal de devtools como primera parada de tabulación:
    // el skip link tiene que ser el primer control del documento, no el primer
    // `Tab` absoluto del navegador.
    await page.keyboard.press('Tab')
    if (!(await skipLink.evaluate((element) => element === document.activeElement))) {
      await page.keyboard.press('Tab')
    }

    // Then
    await expect(skipLink).toBeFocused()
    await expect(skipLink).toBeVisible()
    expect(
      await skipLink.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const topmostElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        )

        return topmostElement === element || element.contains(topmostElement)
      })
    ).toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#main-content$/)
  })

  test('reaches the interactive button through bounded keyboard traversal', async ({ page }) => {
    // Given
    await openShowcase(page)
    const interactiveButton = page.getByTestId('showcase-button-interactive')

    // When
    const tabCount = await tabUntilFocused(page, interactiveButton, 40)

    // Then
    expect(tabCount).toBeGreaterThan(0)
    await expect(interactiveButton).toBeFocused()
    expect(
      await interactiveButton.evaluate((element) => getComputedStyle(element).boxShadow)
    ).not.toBe('none')
    await page.keyboard.press('Tab')
    await expect(interactiveButton).not.toBeFocused()
  })

  test('moves tabs with ArrowRight and reveals the matching panel', async ({ page }) => {
    // Given
    await openShowcase(page)
    const overviewTab = page.getByRole('tab', { name: 'Resumen' })
    const documentsTab = page.getByRole('tab', { name: 'Documentos' })
    await overviewTab.focus()

    // When
    await page.keyboard.press('ArrowRight')

    // Then
    await expect(documentsTab).toBeFocused()
    await expect(documentsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tabpanel')).toContainText(
      'Este ejemplo sintético no es una oferta'
    )
  })

  test('shows and restores the restrained pointer-press state', async ({ page }) => {
    // Given
    await openShowcase(page)
    const button = page.getByTestId('showcase-button-interactive')
    await button.hover()
    const restingTranslate = await button.evaluate((element) => getComputedStyle(element).translate)
    const box = await button.boundingBox()
    if (box === null) {
      expect(box).not.toBeNull()
      return
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    // When
    await page.mouse.down()

    // Then
    try {
      await expect
        .poll(() => button.evaluate((element) => getComputedStyle(element).translate))
        .toBe('0px 1px')
    } finally {
      await page.mouse.up()
    }
    await expect
      .poll(() => button.evaluate((element) => getComputedStyle(element).translate))
      .toBe(restingTranslate)
  })

  test('suppresses skeleton and pressed-button motion when reduced motion is requested', async ({
    page,
  }) => {
    // Given
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openShowcase(page)
    const skeletons = page.locator('[data-slot="skeleton"]')
    const button = page.getByTestId('showcase-button-interactive')
    await button.hover()
    const box = await button.boundingBox()
    if (box === null) {
      expect(box).not.toBeNull()
      return
    }

    // When
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()

    // Then
    try {
      expect(await skeletons.count()).toBeGreaterThan(0)
      expect(
        await skeletons.evaluateAll((elements) => [
          ...new Set(elements.map((element) => getComputedStyle(element).animationName)),
        ])
      ).toEqual(['none'])
      expect(await button.evaluate((element) => getComputedStyle(element).translate)).toBe('0px')
      expect(
        await button.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).transitionDuration)
        )
      ).toBeLessThanOrEqual(0.001)
    } finally {
      await page.mouse.up()
    }
  })

  test('operates select, menu, toast, and routed detail specimens', async ({ page }) => {
    // Given
    await openShowcase(page)
    const select = page.getByTestId('showcase-select')
    const menu = page.getByTestId('showcase-menu')
    // El corte del marketplace ([F] 2026-08-28) se llevó la ruta `deals`: las
    // familias de estado de ruta que quedan son `company` y `admin`.
    const routedLoading = page.getByTestId('route-loading-company')

    // When
    await select.click()
    await page.getByRole('option', { name: 'Madura' }).click()
    await menu.click()

    // Then
    await expect(select).toContainText('Madura')
    await expect(page.getByRole('menuitem', { name: 'Revisar divulgación' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('showcase-toast').click()
    await expect(page.getByText('Preferencia sintética guardada').last()).toBeVisible()
    await routedLoading.locator('summary').click()
    await expect(routedLoading).toHaveAttribute('open', '')
    await expect(routedLoading.locator('[data-slot="skeleton"]').first()).toBeVisible()
  })

  test('switches theme and keeps the served locale through the showcase controls', async ({
    page,
  }) => {
    // Given
    await page.emulateMedia({ colorScheme: 'light' })
    await openShowcase(page)

    // When
    await page.locator('#showcase-theme-menu-trigger').click()
    await page.getByRole('menuitemradio', { name: 'Oscuro' }).click()

    // Then
    await expect(page.locator('html')).toHaveClass(/dark/)
    // El control de idioma del showcase sigue ofreciendo inglés, pero el sitio
    // se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/design-system`
    // responde 308 y la página vuelve a su única cara.
    await page.locator('#showcase-language-menu-trigger').click()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
    await expect(page).toHaveURL(/\/es\/design-system$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    await expect(page).toHaveTitle('Sistema de diseño | Sherlock')
  })
})
