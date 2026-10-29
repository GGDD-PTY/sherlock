import { expect, test } from '@playwright/test'

import {
  configureJourneyNda,
  devLogin,
  invitationUrlFromEmail,
  inviteJourneyGuest,
  openGuestInvitation,
  JOURNEY_COMPANY_NAME,
  JOURNEY_GOAL_MS,
  JOURNEY_OWNER_EMAIL,
  journeyCompanySlug,
  journeyPdf,
  journeyStamp,
  newVisitorIp,
  otpFromEmail,
  startJourney,
  waitForHydratedInput,
  waitForResendEmail,
} from '../helpers/journeys'

// J4: el invitado. El dueño publica un documento bajo NDA, el equipo ya dejó
// el NDA aprobado, se invita a `delivered+…@resend.dev` y el invitado entra
// con el OTP que el componente de Resend guardó (test mode, sin mock de red).

test.describe('J4 el invitado entra a la sala', () => {
  test.setTimeout(JOURNEY_GOAL_MS.J4 * 3)
  // Playwright no pone tope a una acción: si la pantalla del invitado se queda
  // sin el campo que toca, `fill` espera hasta el timeout del test. Con tope,
  // un banco roto se reporta en 20 s en vez de gastar cuatro minutos y medio.
  test.use({ actionTimeout: 20_000 })

  test('OTP, NDA y la sala en solo lectura', async ({ page, browser }, testInfo) => {
    const journey = startJourney('J4', page)
    // Un invitado y un PDF por empresa, corrida e intento. El slug recortado
    // cabe en el local-part (tope 64). `testInfo.retry` evita que un reintento
    // choque con la invitación vigente que dejó el intento anterior
    // (BUSINESS_INVALID_STATE ACTIVE_INVITATION).
    const DOCUMENT = `j4-publicado-${journeyCompanySlug()}-r${testInfo.retry}-${journeyStamp()}`
    const GUEST_EMAIL = `delivered+j4-${journeyCompanySlug().slice(0, 24)}-${journeyStamp()}-r${testInfo.retry}@resend.dev`

    await journey.step('nda-aprobado', async () => {
      await configureJourneyNda()
    })

    await journey.step('dueño-entra', async () => {
      await devLogin(page, JOURNEY_OWNER_EMAIL, /\/es\/my-company\/documents/)
      await expect(page.getByTestId('vdr-room-shell')).toBeVisible({ timeout: 60_000 })
    })

    await journey.step('publicar-documento', async () => {
      await page.getByRole('button', { name: 'Subir documento' }).click()
      const dialog = page.getByRole('dialog', { name: 'Subir documento' })
      await dialog.getByLabel('Archivo').setInputFiles([journeyPdf(`${DOCUMENT}.pdf`)])
      await dialog.getByRole('button', { name: 'Subir', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Subir documento' })).toHaveCount(0, {
        timeout: 60_000,
      })
      await waitForHydratedInput(page, 'input[aria-label="Buscar documentos"]')
      await page.getByRole('textbox', { name: 'Buscar documentos' }).fill(DOCUMENT)
      await expect(page.getByTestId('room-file').filter({ hasText: DOCUMENT })).toHaveCount(1, {
        timeout: 60_000,
      })
    })

    await journey.step('invitar', async () => {
      await inviteJourneyGuest(GUEST_EMAIL, DOCUMENT)
    })

    const guestContext = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      extraHTTPHeaders: { 'x-forwarded-for': newVisitorIp() },
    })
    const guestPage = await guestContext.newPage()
    journey.watch(guestPage)

    try {
      await journey.step('otp', async () => {
        const invitation = await waitForResendEmail(GUEST_EMAIL, (row) =>
          row.text.includes('vdr-guest#')
        )
        const invitationUrl = invitationUrlFromEmail(invitation)
        await openGuestInvitation(guestPage, invitationUrl, journey)
        await guestPage.getByLabel('Email invitado', { exact: true }).fill(GUEST_EMAIL)
        await guestPage.getByRole('button', { name: 'Enviar código de un solo uso' }).click()
        const otpMail = await waitForResendEmail(GUEST_EMAIL, (row) => /\b\d{6}\b/.test(row.text))
        await guestPage
          .getByLabel('Código de seis dígitos', { exact: true })
          .fill(otpFromEmail(otpMail))
        await guestPage.getByRole('button', { name: 'Verificar email', exact: true }).click()
        await expect(
          guestPage.getByLabel('Nombre completo del firmante', { exact: true })
        ).toBeVisible({ timeout: 60_000 })
      })

      await journey.step('firmar-nda', async () => {
        await guestPage
          .getByLabel('Nombre completo del firmante', { exact: true })
          .fill('Invitado Journeys')
        await guestPage.getByLabel('He leído y acepto este NDA.', { exact: true }).check()
        await guestPage.getByRole('button', { name: 'Aceptar NDA y abrir el Data Room' }).click()
      })

      await journey.step('sala-solo-lectura', async () => {
        await expect(guestPage.getByRole('heading', { name: JOURNEY_COMPANY_NAME })).toBeVisible({
          timeout: 60_000,
        })
        await expect(
          guestPage.getByText(
            'Puedes abrir en pantalla la versión que se te compartió. Cada apertura queda registrada y el equipo puede revocar tu acceso cuando quiera.'
          )
        ).toBeVisible()
        // El «solo lectura» se comprueba con el visor abierto, no con la lista:
        // el control de descarga lo pinta el marco del visor
        // (`ViewerChrome`, `chrome.downloadUrl`) y la sala del invitado lo monta
        // con `downloadUrl: null`. Sin abrir el documento, la cuenta de cero era
        // cero porque el marco no existía todavía.
        await guestPage.getByRole('button', { name: `Abrir documento: ${DOCUMENT}` }).click()
        const viewer = guestPage
          .getByTestId('document-viewer-pdf')
          .or(guestPage.getByTestId('document-viewer-error'))
        await expect(viewer).toBeVisible({ timeout: 60_000 })
        // Y es un `link`, no un `button`: el control es un `<a download>` dentro
        // de un `Button asChild`, con texto en escritorio y con `aria-label` en
        // móvil, los dos «Descargar archivo». La cuenta va sobre la página
        // entera porque ese marco es lo único que pinta una descarga acá.
        await expect(guestPage.getByRole('link', { name: /descargar/i })).toHaveCount(0)
        await expect(guestPage.getByRole('button', { name: /descargar/i })).toHaveCount(0)
      })

      journey.end()
    } finally {
      await guestContext.close()
    }
  })
})
