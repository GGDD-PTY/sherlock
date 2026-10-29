import { expect, test } from '@playwright/test'

import { selectIntakeFiles } from './helpers/landing'

test('temporary intake preserves a partial batch, retries it, and keeps the claim target', async ({
  page,
  request,
}) => {
  let sessionReads = 0
  let uploadIntents = 0
  let registrations = 0
  let retryRegistered = false
  const firstDocument = {
    id: 'intake_document_1',
    displayName: 'subido.pdf',
    declaredMimeType: 'application/pdf',
    byteSize: 10,
    inspectionStatus: 'CLEAN',
    claimable: true,
    createdAt: Date.now(),
  }
  const retriedDocument = {
    id: 'intake_document_2',
    displayName: 'fallido.xls',
    declaredMimeType: 'application/vnd.ms-excel',
    byteSize: 9,
    inspectionStatus: 'CLEAN',
    claimable: true,
    createdAt: Date.now() + 1,
  }

  await page.route('**/api/intake/session', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        json: { authorized: true, csrfToken: 'csrf-session', documents: [] },
      })
      return
    }

    sessionReads += 1
    await route.fulfill({
      status: 200,
      json:
        sessionReads === 1
          ? { authorized: false, csrfToken: 'csrf-bootstrap' }
          : {
              authorized: true,
              csrfToken: 'csrf-session',
              accessExpiresAt: Date.now() + 60_000,
              documents: retryRegistered ? [firstDocument, retriedDocument] : [firstDocument],
            },
    })
  })
  await page.route('**/api/intake/support', async (route) => {
    await route.fulfill({ status: 200, json: { messages: [] } })
  })
  await page.route('**/api/intake/uploads', async (route) => {
    uploadIntents += 1
    if (uploadIntents === 2) {
      await route.fulfill({ status: 503, json: { error: 'temporary failure' } })
      return
    }
    await route.fulfill({
      status: 201,
      json: {
        alreadyRegistered: false,
        intentId: `intent_${uploadIntents}`,
        uploadUrl: `https://e2e.convex.cloud/api/storage/upload/${uploadIntents}`,
      },
    })
  })
  await page.route('https://e2e.convex.cloud/**', async (route) => {
    await route.fulfill({ status: 200, json: { storageId: `storage_${uploadIntents}` } })
  })
  await page.route('**/api/intake/uploads/register', async (route) => {
    registrations += 1
    if (registrations === 2) retryRegistered = true
    await route.fulfill({
      status: 200,
      json: {
        registered: true,
        document: registrations === 1 ? firstDocument : retriedDocument,
      },
    })
  })

  // Precompile the dynamic intake route before the browser navigation. Firefox
  // otherwise races a cold Next dev compilation with the top-level transition;
  // production builds do not have that compilation path.
  expect((await request.get('/es/intake')).ok()).toBe(true)
  await page.goto('/es')
  // La analitica del sitio es cookieless y `ConsentBanner` ya no renderiza nada
  // (`src/components/analytics/ConsentBanner.tsx`): no hay banner que despachar
  // antes de subir, y con el se fue la espera implicita de hidratacion que el
  // helper ahora hace explicita.
  await selectIntakeFiles(page, [
    { name: 'subido.pdf', mimeType: 'application/pdf', buffer: Buffer.from('uploaded') },
    {
      name: 'fallido.xls',
      mimeType: 'application/vnd.ms-excel',
      buffer: Buffer.from('retry me'),
    },
  ])
  // Desde 9126fdf1e (landing mock B, 2026-09-14) «Siguiente» exige el nombre de
  // la empresa: sin él la landing muestra `intake.errors.name` y no navega.
  await page.getByLabel('Nombre de tu empresa').fill('Empresa Temporal')
  await page.getByRole('link', { name: 'Siguiente' }).click()

  // [F] 2026-09-01 (DECISIONS): "Siguiente" ya no para en la sala temporal. La
  // landing entrega directo al alta hospedada que aterriza en el VDR del
  // cliente; la sala temporal sigue viva por su propia ruta, y es ahí donde se
  // prueba el reintento del lote parcial. Desde codex/fix2-frontend (2026-09-02)
  // el returnTo lleva la llave del sobre (`?handoff=<uuid>`): la sala reclama
  // los archivos solo si la llave de la URL coincide con la del sobre.
  // Con dev-auth la pagina de sign-up redirige a dev-login por diseno (LESSONS
  // 2026-09-02, d375ffa19); el `loading.tsx` raiz lo escondia tras el streaming
  // hasta #507. Mismo ajuste que 58c3a88da en critical-path.spec.ts. Lo que el
  // caso fija sigue intacto: la llave del sobre viaja dentro del returnTo.
  await expect(page).toHaveURL(
    /\/es\/(sign-up|dev-login)\?returnTo=%2Fes%2Fmy-company%2Fdocuments%3Fhandoff%3D[0-9a-f-]{36}$/
  )
  await page.goto('/es/intake')
  await expect(page.getByText('subido.pdf')).toBeVisible()
  await expect(page.getByText('fallido.xls')).toBeVisible()
  await page.getByRole('button', { name: 'Reintentar fallido.xls' }).click()

  await expect(page.getByRole('button', { name: 'Reintentar fallido.xls' })).toHaveCount(0)
  await expect(page.getByText('fallido.xls')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Crear cuenta y conservar el Data Room' })
  ).toHaveAttribute('href', /returnTo=%2Fes%2Fmy-company%2Fdocuments/)
})
