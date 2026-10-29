import { expect, test } from '@playwright/test'

import { IS_DEMO_AUTH, loginAsDemoUser } from './helpers/auth'
import { selectIntakeFiles, waitForIntakeHydration } from './helpers/landing'

// El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
// responde 308 a `/es` antes de AuthKit, así que la landing se prueba en su
// única cara. El candado del redirect vive en `src/__tests__/proxy.test.ts`.
test.describe('Sell-side intake to preparation workspace', () => {
  test('home presents document intake as the only channel', async ({ page }) => {
    await page.goto('/es')

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Sube tus documentos. Recibe tu modelo financiero.',
      })
    ).toBeVisible()
    await expect(page.getByText('Seleccionar documentos', { exact: true })).toBeVisible()
    // [F] 2026-08-30: copy de cliente sin términos vetados ni features
    // inexistentes. Google Drive no existe y la landing no lo nombra ni como
    // canal pasivo. El MCP del cliente sí existe (`/api/vdr-mcp`) y la landing
    // enlaza a su guía de ayuda a propósito ([F] 2026-09-14).
    await expect(page.getByText(/Google Drive/i)).toHaveCount(0)
    await expect(page.getByTestId('mycroft-upload-dossier')).toBeVisible()
    await expect(page.getByTestId('mycroft-channel-mcp')).toHaveCount(0)
    await expect(page.getByTestId('mycroft-channel-drive')).toHaveCount(0)

    // [F] 2026-09-01 (DECISIONS): la sección de entregables salió con las
    // tarjetas que no llevaban a ninguna parte. Lo que la landing tiene que
    // mostrar antes de tocar nada es el nombre de la empresa junto a la
    // capa de subida.
    await expect(page.getByTestId('mycroft-outputs')).toHaveCount(0)
    await expect(page.getByLabel('Nombre de tu empresa')).toBeVisible()
  })

  test('landing reflows in both themes without hiding its primary action', async ({ page }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/es')

        const select = page
          .getByTestId('mycroft-upload-dossier')
          .getByText('Seleccionar documentos', { exact: true })
        await expect(select).toBeVisible()
        const geometry = await page.evaluate(() => {
          const action = document.querySelector<HTMLButtonElement>(
            '[data-testid="mycroft-upload-dossier"] button'
          )
          if (!action) return null
          const actionRect = action.getBoundingClientRect()
          return {
            actionLeft: actionRect.left,
            actionTop: actionRect.top,
            actionBottom: actionRect.bottom,
            actionRight: actionRect.right,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          }
        })
        expect(geometry).not.toBeNull()
        expect(geometry?.overflow).toBeLessThanOrEqual(1)
        expect(geometry?.actionLeft).toBeGreaterThanOrEqual(0)
        expect(geometry?.actionTop).toBeGreaterThanOrEqual(0)
        expect(geometry?.actionRight).toBeLessThanOrEqual(geometry?.viewportWidth ?? 0)
        expect(geometry?.actionBottom).toBeLessThanOrEqual(geometry?.viewportHeight ?? 0)
      }
    }
  })

  test('landing keyboard path reaches named controls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/es')
    await selectIntakeFiles(page, [
      { name: 'modelo.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('model') },
    ])

    const focusTrail: Array<{
      label: string
      tagName: string
      inputType: string | null
      visible: boolean
    }> = []
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab')
      const focusState = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null
        return {
          label: active?.getAttribute('aria-label') || active?.textContent?.trim() || '',
          tagName: active?.tagName ?? '',
          inputType: active instanceof HTMLInputElement ? active.type : null,
          visible: active?.matches(':focus-visible') ?? false,
        }
      })
      focusTrail.push(focusState)
    }

    // El selector de idioma salió del navbar con la cara única en español
    // ([F] 2026-09-01, DECISIONS): ya no es una parada del recorrido.
    // El enlace del navbar dice «Ayuda y cómo funciona» desde la landing mock B
    // (df2cec555, 2026-09-14); `es.json` conserva «Ayuda» solo para el pie.
    const requiredStops = [
      { label: 'Ayuda y cómo funciona', tagName: 'A' },
      { label: 'Cambiar tema', tagName: 'BUTTON' },
      { label: 'Seleccionar documentos', tagName: 'BUTTON' },
      { label: 'Quitar modelo.xlsx', tagName: 'BUTTON' },
      { label: 'Siguiente', tagName: 'A' },
    ]
    const focusIndices = requiredStops.map(({ label, tagName }) =>
      focusTrail.findIndex((stop) => stop.label === label && stop.tagName === tagName)
    )

    expect(
      focusTrail.findIndex(
        (stop) => stop.label === 'Saltar al contenido principal' && stop.tagName === 'A'
      )
    ).toBeLessThan(focusIndices[0] ?? 0)
    expect(focusIndices.every((index) => index >= 0)).toBe(true)
    for (let index = 1; index < focusIndices.length; index += 1) {
      expect(focusIndices[index]).toBeGreaterThan(focusIndices[index - 1])
    }
    expect(
      focusTrail.some(
        (stop) => stop.label === 'Seleccionar documentos' && stop.inputType === 'file'
      )
    ).toBe(false)
    expect(focusIndices.map((index) => focusTrail[index]?.visible).every(Boolean)).toBe(true)
  })

  test('theme preserves the selection and the route hash across its remount boundary', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/es/#intake')
    await selectIntakeFiles(page, [
      { name: 'modelo.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('model') },
    ])

    // El tema es un grupo de UNA sola eleccion, asi que sus opciones son
    // `menuitemradio` y no `menuitem`: el rol es lo que le dice a la asistiva
    // cual esta activo. Afirmar `aria-checked` aqui es lo que impide que
    // alguien vuelva a un item plano donde el activo solo se veia por color.
    await page.getByRole('button', { name: 'Cambiar tema' }).click()
    await page.getByRole('menuitemradio', { name: 'Oscuro' }).click()
    await expect(page).toHaveURL(/\/es\/?#intake$/)
    await expect(page.getByText('modelo.xlsx')).toBeVisible()

    await page.getByRole('button', { name: 'Cambiar tema' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Oscuro' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.keyboard.press('Escape')
  })

  test('company sees documents, preparation and team in their workspace screens', async ({
    page,
  }) => {
    if (!IS_DEMO_AUTH) return
    await loginAsDemoUser(page, 'company')
    await page.goto('/es/my-company/documents')

    await expect(page.getByRole('heading', { level: 1, name: 'Data Room' })).toBeVisible()
    await expect(page.getByTestId('vdr-room-shell')).toBeVisible()
    // Candado del corte [F] 2026-08-30: sala + preparación + soporte, nada del paquete viejo.
    await expect(page.getByRole('heading', { name: 'Tu paquete de preparación' })).toHaveCount(0)
    await expect(page.locator('[data-testid^="deliverable-card-"]')).toHaveCount(0)

    await page.goto('/es/my-company/preparation')
    await expect(page.getByTestId('room-progress-panel')).toBeVisible()
    await page.goto('/es/my-company/team')
    await expect(page.getByRole('heading', { name: 'Habla con el equipo' })).toBeVisible()
  })

  test('former marketplace URLs return 404 like any unknown route', async ({ request }) => {
    for (const path of ['deals/legacy', 'messages', 'checkout', 'pricing', 'investors']) {
      const response = await request.get(`/es/${path}`, { maxRedirects: 0 })

      expect(response.status(), `/es/${path} should not exist`).toBe(404)
      expect(response.headers()['location']).toBeUndefined()
    }
  })

  test('changed public surfaces do not overflow at 200% and 400% reflow equivalents', async ({
    page,
  }) => {
    for (const { width, scale } of [
      { width: 640, scale: '200%' },
      { width: 320, scale: '400%' },
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/es')
      await waitForIntakeHydration(page)

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      )
      expect(overflow, `${scale} reflow overflow`).toBeLessThanOrEqual(1)

      const assertInViewport = async (locator: ReturnType<typeof page.getByRole>, name: string) => {
        await locator.evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await expect(locator, `${scale}: ${name} visible`).toBeVisible()
        await expect
          .poll(async () => {
            const animatedBounds = await locator.boundingBox()
            return animatedBounds
              ? animatedBounds.x + animatedBounds.width
              : Number.POSITIVE_INFINITY
          }, `${scale}: ${name} settles inside the right edge`)
          .toBeLessThanOrEqual(width + 1)
        const bounds = await locator.boundingBox()
        // El banner de consentimiento se retiró con la analítica cookieless, así
        // que el borde inferior útil vuelve a ser el viewport. Sondear
        // `[role="dialog"]` aquí ya no encuentra el banner: encuentra la hoja
        // del menú de navegación, que arranca en y=0.
        const visibleBottom = await page.evaluate(() => window.innerHeight)
        expect(bounds, `${scale}: ${name} has bounds`).not.toBeNull()
        expect(bounds?.x, `${scale}: ${name} left edge`).toBeGreaterThanOrEqual(0)
        expect(
          (bounds?.x ?? 0) + (bounds?.width ?? 0),
          `${scale}: ${name} right edge`
        ).toBeLessThanOrEqual(width)
        expect(bounds?.y, `${scale}: ${name} top edge`).toBeGreaterThanOrEqual(0)
        expect(
          (bounds?.y ?? 0) + (bounds?.height ?? 0),
          `${scale}: ${name} bottom edge`
        ).toBeLessThanOrEqual(visibleBottom + 1)
      }

      await assertInViewport(page.getByRole('button', { name: 'Abrir menú' }), 'navigation menu')
      await page.getByRole('button', { name: 'Abrir menú' }).click()
      await assertInViewport(page.getByRole('link', { name: 'Ayuda' }), 'support link')
      await assertInViewport(page.getByRole('button', { name: 'Cambiar tema' }), 'theme control')
      await page.keyboard.press('Escape')

      await assertInViewport(
        page
          .getByTestId('mycroft-upload-dossier')
          .getByText('Seleccionar documentos', { exact: true }),
        'primary file selector'
      )
      await selectIntakeFiles(page, [
        { name: 'modelo.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('model') },
      ])
      await assertInViewport(page.getByRole('button', { name: 'Quitar todos' }), 'clear selection')
      await assertInViewport(
        page.getByRole('button', { name: 'Quitar modelo.xlsx' }),
        'remove selected file'
      )
      await assertInViewport(page.getByRole('link', { name: 'Siguiente' }), 'continue action')
    }
  })
})
