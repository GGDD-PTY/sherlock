import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Synthetic browser contract only: every guest API response is intercepted.
 * Passing this suite is not evidence for live email delivery, WorkOS, Convex,
 * cookies, storage, deployment configuration, or any production provider.
 */
const INVITATION_HANDLE = 'h'.repeat(64)
const CHALLENGE_TOKEN = 'c'.repeat(64)
const GUEST_EMAIL = 'fixture-bff21e9f@example.com'
const OTP_CODE = '481516'
const PRIVATE_REQUEST_MARKERS = [
  'profile_issuer-secret',
  GUEST_EMAIL,
  'https://storage.example/private-file',
  'draft-dashboard-sentinel',
] as const

const pendingGates = [
  'MUTUAL_OPT_IN',
  'HUMAN_MATCH_APPROVAL',
  'NDA',
  'ROOM_GRANT',
] as const

const authorizedRoom = {
  authenticated: true,
  expiresAt: 4_102_444_800_000,
  roomAccessGranted: true,
  requiredGates: [],
  room: { title: 'Expansión regional' },
  documents: [
    {
      name: 'Estados financieros publicados.pdf',
      fileType: 'PDF',
      fileSize: 4_096,
      folder: 'Finanzas',
      classification: 'CONFIDENTIAL',
      downloadable: false,
    },
    {
      name: 'Pacto de accionistas vigente.pdf',
      fileType: 'PDF',
      fileSize: 8_192,
      folder: 'Legal',
      classification: 'LEGAL',
      downloadable: false,
    },
  ],
  documentsTruncated: false,
  downloadDeliveryAvailable: false,
  // This field is transport metadata and is intentionally poisoned. The guest
  // UI must never render it; API/Convex contract tests separately prove the
  // server projection omits real PII and storage locators.
  requestId: PRIVATE_REQUEST_MARKERS.join('__'),
} as const

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  })
}

async function assertNoDownloadSurface(page: Page) {
  await expect(page.getByRole('button', { name: /descargar|download/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /descargar|download/i })).toHaveCount(0)
  await expect(page.locator('a[download]')).toHaveCount(0)
}

async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))
  expect(dimensions.clientWidth).toBe(dimensions.viewportWidth)
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
}

test.describe('Synthetic external VDR guest journey', () => {
  test('verifies an opaque fragment into the rich room, navigates by keyboard, and logs out', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })

    let urlAtSessionCheck = ''
    let otpRequestBody: Record<string, unknown> | undefined
    let verifyRequestBody: Record<string, unknown> | undefined
    const observedRequestUrls: string[] = []
    page.on('request', (request) => observedRequestUrls.push(request.url()))

    await page.route('**/api/vdr/guest/session', async (route) => {
      urlAtSessionCheck = page.url()
      await fulfillJson(route, { authenticated: false })
    })
    await page.route('**/api/vdr/guest/otp/request', async (route) => {
      otpRequestBody = route.request().postDataJSON() as Record<string, unknown>
      await fulfillJson(
        route,
        { accepted: true, challengeToken: CHALLENGE_TOKEN, expiresInSeconds: 600 },
        202
      )
    })
    await page.route('**/api/vdr/guest/verify', async (route) => {
      verifyRequestBody = route.request().postDataJSON() as Record<string, unknown>
      await fulfillJson(route, {
        verified: true,
        expiresAt: authorizedRoom.expiresAt,
        roomAccessGranted: false,
      })
    })
    await page.route('**/api/vdr/guest/room', (route) => fulfillJson(route, authorizedRoom))
    await page.route('**/api/vdr/guest/logout', (route) => fulfillJson(route, { loggedOut: true }))

    await page.goto(`/es/vdr-guest?utm_source=private-invite#${INVITATION_HANDLE}`, {
      waitUntil: 'domcontentloaded',
    })

    const emailInput = page.getByLabel('Email invitado')
    await expect(emailInput).toBeVisible()
    expect(new URL(urlAtSessionCheck).pathname).toBe('/es/vdr-guest')
    expect(new URL(urlAtSessionCheck).search).toBe('')
    expect(new URL(urlAtSessionCheck).hash).toBe('')
    await expect(page).toHaveURL(/\/es\/vdr-guest$/)
    await expect(page.locator('body')).not.toContainText(INVITATION_HANDLE)

    await emailInput.fill(GUEST_EMAIL)
    await page.getByRole('button', { name: 'Enviar código de un solo uso' }).click()
    await expect(page.getByLabel('Código de seis dígitos')).toBeVisible()
    expect(otpRequestBody).toEqual({ invitationHandle: INVITATION_HANDLE, email: GUEST_EMAIL })

    await page.getByLabel('Código de seis dígitos').fill(OTP_CODE)
    await page.getByRole('button', { name: 'Verificar email' }).click()

    await expect(page.getByRole('heading', { name: authorizedRoom.room.title })).toBeVisible()
    expect(verifyRequestBody).toEqual({
      invitationHandle: INVITATION_HANDLE,
      challengeToken: CHALLENGE_TOKEN,
      code: OTP_CODE,
    })

    // El índice ES la sala: el panel publicado y el Q&A salieron con el
    // subsistema de transacciones ([F] 2026-09-17), así que no queda un tablist
    // que recorrer, solo la biblioteca agrupada por carpeta.
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.getByText('Estados financieros publicados.pdf').last()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Legal' })).toBeVisible()

    await assertNoDownloadSurface(page)
    for (const marker of [
      INVITATION_HANDLE,
      CHALLENGE_TOKEN,
      OTP_CODE,
      ...PRIVATE_REQUEST_MARKERS,
    ]) {
      await expect(page.locator('body')).not.toContainText(marker)
      expect(observedRequestUrls.join('\n')).not.toContain(marker)
    }
    await expect(page.locator('[href*="storage"], [src*="storage"]')).toHaveCount(0)

    const persistedBrowserState = await page.evaluate(() => ({
      localStorage: { ...window.localStorage },
      sessionStorage: { ...window.sessionStorage },
    }))
    const serializedBrowserState = JSON.stringify(persistedBrowserState)
    expect(serializedBrowserState).not.toContain(INVITATION_HANDLE)
    expect(serializedBrowserState).not.toContain(CHALLENGE_TOKEN)
    expect(serializedBrowserState).not.toContain(GUEST_EMAIL)

    await page.getByRole('button', { name: 'Cerrar sesión segura' }).click()
    await expect(page.getByRole('heading', { name: 'Sesión cerrada' })).toBeVisible()
    await expect(page.getByRole('heading', { name: authorizedRoom.room.title })).toHaveCount(0)
    await assertNoDownloadSurface(page)
  })

  test('keeps a pending-gates session document-free and usable at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/vdr/guest/session', (route) =>
      fulfillJson(route, { authenticated: false })
    )
    await page.route('**/api/vdr/guest/otp/request', (route) =>
      fulfillJson(
        route,
        { accepted: true, challengeToken: CHALLENGE_TOKEN, expiresInSeconds: 600 },
        202
      )
    )
    await page.route('**/api/vdr/guest/verify', (route) =>
      fulfillJson(route, {
        verified: true,
        expiresAt: authorizedRoom.expiresAt,
        roomAccessGranted: false,
      })
    )
    await page.route('**/api/vdr/guest/room', (route) =>
      fulfillJson(route, {
        authenticated: true,
        roomAccessGranted: false,
        requiredGates: pendingGates,
      })
    )

    await page.goto(`/es/vdr-guest#${INVITATION_HANDLE}`, { waitUntil: 'domcontentloaded' })

    await page.getByLabel('Email invitado').fill(GUEST_EMAIL)
    await page.getByRole('button', { name: 'Enviar código de un solo uso' }).click()
    await page.getByLabel('Código de seis dígitos').fill(OTP_CODE)
    await page.getByRole('button', { name: 'Verificar email' }).click()

    await expect(page.getByText('Tu identidad fue confirmada', { exact: true })).toBeVisible()
    for (const gate of [
      'Interés mutuo confirmado',
      'Revisión y aprobación humana',
      'NDA vigente',
      'Permiso explícito de Data Room',
    ]) {
      await expect(page.getByText(gate)).toBeVisible()
    }
    await expect(page.getByText('No se proyectan documentos en esta etapa.')).toBeVisible()
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.getByText('Estados financieros publicados.pdf')).toHaveCount(0)
    await assertNoDownloadSurface(page)
    await assertNoHorizontalOverflow(page)

    const logoutButton = page.getByRole('button', { name: 'Cerrar sesión segura' })
    await logoutButton.focus()
    await expect(logoutButton).toBeFocused()
  })

  test('fails closed when room authorization is revoked after session resolution', async ({
    page,
  }) => {
    await page.route('**/api/vdr/guest/session', (route) =>
      fulfillJson(route, { authenticated: true, roomAccessGranted: false, requiredGates: [] })
    )
    await page.route('**/api/vdr/guest/room', (route) =>
      fulfillJson(route, { authenticated: false }, 401)
    )

    await page.goto('/es/vdr-guest', { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: 'El acceso finalizó' })).toBeVisible()
    await expect(page.getByText(/ya no tiene una autorización activa/i)).toBeVisible()
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.getByText('Estados financieros publicados.pdf')).toHaveCount(0)
    await assertNoDownloadSurface(page)
  })

  test('does not reveal invitation state when the session endpoint denies the read', async ({
    page,
  }) => {
    let roomReads = 0
    await page.route('**/api/vdr/guest/session', (route) =>
      fulfillJson(route, { error: 'Unauthorized' }, 401)
    )
    await page.route('**/api/vdr/guest/room', async (route) => {
      roomReads += 1
      await fulfillJson(route, authorizedRoom)
    })

    await page.goto(`/es/vdr-guest#${INVITATION_HANDLE}`, { waitUntil: 'domcontentloaded' })

    await expect(
      page.getByRole('heading', { name: 'Acceso temporalmente no disponible' })
    ).toBeVisible()
    await expect(page).toHaveURL(/\/es\/vdr-guest$/)
    await expect(page.getByLabel('Email invitado')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(INVITATION_HANDLE)
    await assertNoDownloadSurface(page)
    expect(roomReads).toBe(0)
  })
})
