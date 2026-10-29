import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
// responde 308 a `/es`.
const showcaseRoutes = ['/es/design-system'] as const
const viewports = [
  { height: 900, label: '320px', width: 320 },
  { height: 900, label: '375px', width: 375 },
  { height: 900, label: '768px', width: 768 },
  { height: 900, label: '1280px', width: 1280 },
] as const
const colorSchemes = ['light', 'dark'] as const
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

for (const route of showcaseRoutes) {
  for (const viewport of viewports) {
    for (const colorScheme of colorSchemes) {
      test(`${route} has no WCAG axe violations or horizontal overflow at ${viewport.label} in ${colorScheme} mode`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ colorScheme, viewport })
        const page = await context.newPage()

        try {
          const response = await page.goto(route, { waitUntil: 'networkidle' })
          expect(response?.status(), `${route} must load successfully`).toBe(200)
          await expect(page.locator('main')).toHaveCount(1)
          await expect(
            page.getByRole('region', {
              name: new RegExp(`^${route.startsWith('/es') ? 'Notificaciones' : 'Notifications'} `),
            })
          ).toHaveCount(1)

          const axeResults = await new AxeBuilder({ page }).withTags([...wcagTags]).analyze()
          const violations = axeResults.violations.map(({ help, id, impact, nodes }) => ({
            help,
            id,
            impact,
            nodes: nodes.map(({ failureSummary, target }) => ({ failureSummary, target })),
          }))

          expect(
            axeResults.violations,
            `WCAG violations at ${route} (${viewport.label}, ${colorScheme}): ${JSON.stringify(violations)}`
          ).toEqual([])

          const { scrollWidth, viewportWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          }))

          expect(
            scrollWidth,
            `Horizontal overflow at ${route} (${viewport.label}, ${colorScheme}): ${scrollWidth}px document width exceeds ${viewportWidth}px viewport`
          ).toBeLessThanOrEqual(viewportWidth)
        } finally {
          await context.close()
        }
      })
    }
  }
}

for (const { name, route } of [
  { name: 'Saltar al contenido principal', route: '/es/design-system' },
] as const) {
  test(`${route} keeps its first-focus skip link above the sticky header and has no heading-level skips at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto(route, { waitUntil: 'networkidle' })

    const skipLink = page.getByRole('link', { name })
    // `next dev` monta su portal de devtools como primera parada de tabulación:
    // el skip link tiene que ser el primer control del documento, no el primer
    // `Tab` absoluto del navegador.
    await page.keyboard.press('Tab')
    if (!(await skipLink.evaluate((element) => element === document.activeElement))) {
      await page.keyboard.press('Tab')
    }

    await expect(skipLink).toBeFocused()
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

    const headingLevels = await page.getByRole('heading').evaluateAll((headings) =>
      headings.map((heading) => {
        const explicitLevel = heading.getAttribute('aria-level')
        return explicitLevel === null ? Number(heading.tagName.slice(1)) : Number(explicitLevel)
      })
    )

    expect(headingLevels[0]).toBe(1)
    expect(
      headingLevels.every(
        (level, index) => index === 0 || level <= (headingLevels[index - 1] ?? level) + 1
      )
    ).toBe(true)
  })
}
