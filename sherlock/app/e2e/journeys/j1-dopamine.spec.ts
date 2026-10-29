import { expect, test } from '@playwright/test'

import { selectIntakeFiles } from '../helpers/landing'
import {
  JOURNEY_COMPANY_NAME,
  JOURNEY_GOAL_MS,
  JOURNEY_OWNER_EMAIL,
  journeyPdf,
  journeyStamp,
  newVisitorIp,
  startJourney,
  submitDevLogin,
  waitForHydratedInput,
} from '../helpers/journeys'

// J1, el «dopamine hit»: anónimo en la landing, tres documentos, sign-in y la
// sala con los tres ruteados. Contra el backend local real, sin un solo mock.
const DOCUMENTS = ['j1-estados-financieros', 'j1-pacto-social', 'j1-contrato-marco'].map(
  (name) => `${name}-${journeyStamp()}`
)

test.describe('J1 dopamine hit', () => {
  test.setTimeout(JOURNEY_GOAL_MS.J1 * 3)

  test('la landing entrega los tres documentos a la sala del cliente', async ({ page }) => {
    const journey = startJourney('J1', page)
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': newVisitorIp() })

    await journey.step('landing', async () => {
      await page.goto('/es', { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('mycroft-upload-dossier')).toBeVisible()
      await waitForHydratedInput(page, '[data-testid="mycroft-upload-dossier"] input[type="file"]')
    })

    await journey.step('nombre-empresa', async () => {
      await page.getByLabel('Nombre de tu empresa').fill(JOURNEY_COMPANY_NAME)
    })

    await journey.step('soltar-documentos', async () => {
      await selectIntakeFiles(
        page,
        DOCUMENTS.map((stem) => journeyPdf(`${stem}.pdf`))
      )
    })

    await journey.step('continuar', async () => {
      await page.getByRole('link', { name: 'Siguiente' }).click()
      await page.waitForURL(/\/es\/(sign-up|dev-login)/, { timeout: 60_000 })
      await page.waitForURL(/\/es\/dev-login\?returnTo=/, { timeout: 60_000 })
    })

    await journey.step('sign-in', async () => {
      await submitDevLogin(page, JOURNEY_OWNER_EMAIL, /\/es\/my-company\/documents/)
      await expect(page.getByTestId('vdr-room-shell')).toBeVisible({ timeout: 60_000 })
    })

    await journey.step('documentos-ruteados', async () => {
      await expect(page.getByTestId('vdr-room-shell')).toBeVisible({ timeout: 60_000 })
      // La lista del árbol va por ventana (`windowed` en `RoomShell`): con la
      // sala llena, el documento buscado puede no estar en el DOM hasta que el
      // filtro corre, y el filtro no corre hasta que el buscador hidrata.
      await waitForHydratedInput(page, 'input[aria-label="Buscar documentos"]')
      const search = page.getByRole('textbox', { name: 'Buscar documentos' })
      for (const name of DOCUMENTS) {
        await search.fill(name)
        await expect(page.getByTestId('room-file').filter({ hasText: name })).toHaveCount(1, {
          timeout: 60_000,
        })
      }
      await search.fill('')
    })

    journey.end()
    // La meta de J1 incluye cero errores de consola (plan 10/10, sección 6).
    // Los del servidor de desarrollo se cuentan en la tabla pero no son del
    // producto: ver `DEV_SERVER_NOISE` en el helper.
    expect(journey.productConsoleErrors).toEqual([])
  })
})
