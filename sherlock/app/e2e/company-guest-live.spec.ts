import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// Explicitly opt-in. This journey sends real invitation/OTP emails, records
// acceptance of an already-approved NDA and revokes its one test invitation.
// It never seeds identities, templates, documents or investor infrastructure.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function freshInput(path: string, after: number, validate: (text: string) => boolean) {
  let result = ''
  await expect
    .poll(
      async () => {
        try {
          if ((await stat(path)).mtimeMs < after) return false
          result = (await readFile(path, 'utf8')).trim()
          return validate(result)
        } catch {
          return false
        }
      },
      { timeout: 180000, intervals: [2000] }
    )
    .toBe(true)
  return result
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Required live journey setting: ${name}`)
  return value
}

function maskedEmail(email: string) {
  const [local, domain] = email.trim().toLowerCase().split('@')
  const [name, ...suffix] = domain.split('.')
  return `${local.length <= 1 ? '*' : local[0] + '*'.repeat(Math.min(5, local.length - 1))}@${name.length <= 1 ? '*' : name[0] + '***'}.${suffix.join('.')}`
}

test('company invitation → real OTP → approved NDA → PDF bytes → revocation', async ({
  browser,
}) => {
  test.skip(
    process.env.GUEST_LIVE_ACTIONS_APPROVED !== '1',
    'Requires explicit authority for live invitation, OTP, NDA acceptance and revocation.'
  )
  test.setTimeout(480000)
  const roomUrl = requiredEnv('GUEST_LIVE_ROOM_URL')
  const email = requiredEnv('GUEST_LIVE_EMAIL')
  const fileName = requiredEnv('GUEST_LIVE_PDF_NAME')
  const expectedPdfHash = requiredEnv('GUEST_LIVE_PDF_SHA256')
  const expectedNdaHash = requiredEnv('GUEST_LIVE_NDA_SHA256')
  const signatory = requiredEnv('GUEST_LIVE_SIGNATORY_NAME')
  const invitationFile = requiredEnv('GUEST_LIVE_INVITATION_FILE')
  const otpFile = requiredEnv('GUEST_LIVE_OTP_FILE')
  const ungrantedDocumentId = requiredEnv('GUEST_LIVE_UNGRANTED_DOCUMENT_ID')
  const operator = await browser.newContext({
    storageState: requiredEnv('GUEST_LIVE_OPERATOR_STATE'),
    baseURL: new URL(roomUrl).origin,
  })
  const guest = await browser.newContext({ baseURL: new URL(roomUrl).origin })
  try {
    const ownerPage = await operator.newPage()
    await ownerPage.goto(roomUrl)
    const panel = ownerPage
      .locator('section')
      .filter({ has: ownerPage.locator('#company-guests-heading') })
    await expect(panel.getByRole('heading', { name: 'Invitados', exact: true })).toBeVisible()
    await panel.getByLabel('Email del invitado', { exact: true }).fill(email)
    await panel.getByLabel(fileName, { exact: true }).check()
    const invitedAt = Date.now()
    await panel.getByRole('button', { name: 'Enviar invitación', exact: true }).click()
    await expect(panel.getByText('Invitación enviada.', { exact: true })).toBeVisible()
    const invitationUrl = await freshInput(invitationFile, invitedAt, (text) => {
      try {
        const url = new URL(text)
        return (
          url.origin === new URL(roomUrl).origin &&
          url.pathname === '/es/vdr-guest' &&
          /^[a-zA-Z0-9_-]{32,256}$/.test(url.hash.slice(1))
        )
      } catch {
        return false
      }
    })
    const guestPage = await guest.newPage()
    await guestPage.goto(invitationUrl)
    await guestPage.getByLabel('Email invitado', { exact: true }).fill(email)
    const requestedAt = Date.now()
    await guestPage
      .getByRole('button', { name: 'Enviar código de un solo uso', exact: true })
      .click()
    const otp = await freshInput(otpFile, requestedAt, (text) => /^\d{6}$/.test(text))
    await guestPage.getByLabel('Código de seis dígitos', { exact: true }).fill(otp)
    await guestPage.getByRole('button', { name: 'Verificar email', exact: true }).click()
    await expect(
      guestPage.getByLabel('Nombre completo del firmante', { exact: true })
    ).toBeVisible()
    const ndaResponse = await guestPage.request.get('/api/vdr/guest/nda')
    expect(ndaResponse.status()).toBe(200)
    const { nda } = await ndaResponse.json()
    expect(createHash('sha256').update(nda.content).digest('hex')).toBe(expectedNdaHash)
    expect(nda.contentHash).toBe(expectedNdaHash)
    await expect(guestPage.getByRole('region', { name: nda.title, exact: true })).toHaveText(
      nda.content
    )
    await guestPage.getByLabel('Nombre completo del firmante', { exact: true }).fill(signatory)
    await guestPage.getByLabel('He leído y acepto este NDA.', { exact: true }).check()
    await guestPage.getByRole('button', { name: 'Aceptar NDA y abrir sala', exact: true }).click()
    const open = guestPage.getByRole('button', {
      name: `Abrir documento: ${fileName}`,
      exact: true,
    })
    await expect(open).toBeVisible()
    const delivered = guestPage.waitForResponse((response) =>
      /\/api\/vdr\/guest\/documents\/[a-zA-Z0-9_-]+$/.test(new URL(response.url()).pathname)
    )
    await open.click()
    const pdf = await delivered
    expect(pdf.status()).toBe(200)
    expect(pdf.headers()['content-type']).toBe('application/pdf')
    expect(pdf.headers()['cache-control']).toContain('no-store')
    expect(pdf.headers().location).toBeUndefined()
    const bytes = await pdf.body()
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    // La entrega sella el PDF con la invitacion antes de mandarlo, asi que los
    // bytes ya no son los del archivo subido: eso es justo lo que se exige.
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(expectedPdfHash)
    await expect(guestPage.locator('[data-testid="document-viewer-pdf"] canvas')).toBeVisible()
    await expect(guestPage.getByRole('button', { name: /descargar/i })).toHaveCount(0)
    expect(
      (await guestPage.request.get(`/api/vdr/guest/documents/${ungrantedDocumentId}`)).status()
    ).toBe(403)
    const invitation = panel
      .getByRole('listitem')
      .filter({ hasText: maskedEmail(email) })
      .filter({ has: ownerPage.getByRole('button', { name: 'Revocar acceso', exact: true }) })
    await expect(invitation).toHaveCount(1)
    await invitation.getByRole('button', { name: 'Revocar acceso', exact: true }).click()
    await invitation
      .getByLabel('Motivo de revocación')
      .fill('Controlled guest acceptance journey completed')
    await invitation.getByRole('button', { name: 'Confirmar revocación', exact: true }).click()
    await expect(panel.getByText('Acceso revocado.', { exact: true })).toBeVisible()
    expect((await guestPage.request.get(pdf.url())).status()).toBe(403)
    expect((await guestPage.request.get('/api/vdr/guest/room')).status()).toBe(401)
    await guestPage.reload()
    await expect(
      guestPage.getByRole('button', { name: `Abrir documento: ${fileName}`, exact: true })
    ).toHaveCount(0)
  } finally {
    await guest.close()
    await operator.close()
  }
})
