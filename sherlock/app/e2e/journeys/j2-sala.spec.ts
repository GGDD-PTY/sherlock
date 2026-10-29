import { expect, test } from '@playwright/test'

import {
  devLogin,
  JOURNEY_GOAL_MS,
  JOURNEY_OWNER_EMAIL,
  journeyPdf,
  journeyStamp,
  startJourney,
  waitForHydratedInput,
} from '../helpers/journeys'

// J2: el cliente completa su sala. Abre «Preparación», ve «Te falta», sube lo
// que falta y guarda perfil y teléfono con un solo Guardar.
// La sala guarda el nombre del archivo sin extensión: el .pdf es del archivo,
// el documento se llama como su base.
const MISSING_DOCUMENT = `j2-estados-financieros-${journeyStamp()}`
const CONTACT_PHONE = '+507 6123 4567'

test.describe('J2 el cliente completa su sala', () => {
  test.setTimeout(JOURNEY_GOAL_MS.J2 * 4)

  test('sube lo que falta y guarda su empresa', async ({ page }) => {
    const journey = startJourney('J2', page)

    await journey.step('entrar', async () => {
      await devLogin(page, JOURNEY_OWNER_EMAIL, /\/es\/my-company\/documents/)
      await expect(page.getByTestId('vdr-room-shell')).toBeVisible({ timeout: 60_000 })
    })

    await journey.step('preparacion', async () => {
      await page.getByRole('link', { name: 'Preparación' }).click()
      await page.waitForURL(/\/es\/my-company\/preparation/, { timeout: 60_000 })
      await expect(page.getByTestId('room-progress-panel')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('heading', { name: 'Te falta' })).toBeVisible()
      await expect(page.getByTestId('room-progress-missing').getByRole('listitem')).not.toHaveCount(
        0
      )
    })

    await journey.step('subir-lo-que-falta', async () => {
      await page.getByRole('link', { name: 'Documentos' }).click()
      await page.waitForURL(/\/es\/my-company\/documents/, { timeout: 60_000 })
      await page.getByRole('button', { name: 'Subir documento' }).click()
      const dialog = page.getByRole('dialog', { name: 'Subir documento' })
      await dialog.getByLabel('Archivo').setInputFiles([journeyPdf(`${MISSING_DOCUMENT}.pdf`)])
      await dialog.getByRole('button', { name: 'Subir', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Subir documento' })).toHaveCount(0, {
        timeout: 60_000,
      })
      await waitForHydratedInput(page, 'input[aria-label="Buscar documentos"]')
      await page.getByRole('textbox', { name: 'Buscar documentos' }).fill(MISSING_DOCUMENT)
      await expect(page.getByTestId('room-file').filter({ hasText: MISSING_DOCUMENT })).toHaveCount(
        1,
        { timeout: 60_000 }
      )
    })

    await journey.step('guardar-empresa', async () => {
      await page.getByRole('link', { name: 'Tu empresa' }).click()
      await page.waitForURL(/\/es\/my-company\/company/, { timeout: 60_000 })
      const form = page.getByTestId('company-profile-form')
      await expect(form).toBeVisible({ timeout: 60_000 })
      await form.getByLabel('Descripción corta').fill('Alimentos empacados para el istmo.')
      await form.getByLabel('Teléfono de contacto').fill(CONTACT_PHONE)
      await form.getByRole('button', { name: 'Guardar', exact: true }).click()
      await expect(page.getByText('Guardado', { exact: true })).toBeVisible({ timeout: 60_000 })
    })

    // Un solo Guardar movió el perfil y el teléfono: la preparación ya no lo pide.
    await journey.step('preparacion-al-dia', async () => {
      await page.getByRole('link', { name: 'Preparación' }).click()
      await page.waitForURL(/\/es\/my-company\/preparation/, { timeout: 60_000 })
      await expect(page.getByTestId('room-progress-panel')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText('Dejar un teléfono de contacto')).toHaveCount(0, {
        timeout: 60_000,
      })
    })

    journey.end()
  })
})
