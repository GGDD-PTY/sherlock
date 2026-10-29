import { expect, test, type Page } from '@playwright/test'

type MetadataExpectation = {
  readonly path: string
  readonly canonicalPath?: string
  readonly locale: 'es'
  readonly title: string
  // Los títulos sociales se comprueban independientemente del template del documento.
  readonly socialTitle?: string
  readonly description: string
}

// El sitio se sirve solo en español ([F] 2026-09-01, DECISIONS): `/en/*`
// responde 308 a `/es`, así que las expectativas en inglés ya no describen
// ninguna página servida.
const metadataExpectations: readonly MetadataExpectation[] = [
  {
    // La home en (public) hereda el template de título de [locale].
    path: '/es',
    locale: 'es',
    title: 'Modelo financiero, teaser, CIM y presentaciones | Sherlock',
    socialTitle: 'Modelo financiero, teaser, CIM y presentaciones | Sherlock',
    description:
      'Sube los documentos de tu empresa y recibe tu modelo financiero, teaser, CIM y presentaciones en un Data Room privado.',
  },
  {
    path: '/es/privacy',
    locale: 'es',
    title: 'Política de Privacidad | Sherlock',
    description:
      'Política de privacidad de Sherlock sobre cómo recopilamos, usamos y protegemos datos personales.',
  },
  {
    path: '/es/help',
    canonicalPath: '/es/ayuda',
    locale: 'es',
    title: 'Ayuda | Sherlock',
    description: 'Escríbele al equipo, vota lo que sigue y lee cómo funciona tu Data Room.',
  },
  {
    path: '/es/terms',
    locale: 'es',
    title: 'Términos y Condiciones | Sherlock',
    description:
      'Términos para la preparación sell-side de Sherlock, los workspaces privados y el acceso controlado de invitados.',
  },
]

async function expectCanonicalPath(page: Page, expectedPath: string) {
  const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute('href')

  expect(canonicalHref).toBeTruthy()
  if (!canonicalHref) return

  expect(new URL(canonicalHref).pathname).toBe(expectedPath)
}

async function expectMetaContent(page: Page, selector: string, expectedContent: string) {
  await expect(page.locator(selector)).toHaveAttribute('content', expectedContent)
}

async function expectOgImage(page: Page) {
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content')

  expect(ogImage).toBeTruthy()
  if (!ogImage) return

  expect(new URL(ogImage).pathname).toBe('/og-image.png')
}

test.describe('Localized metadata', () => {
  for (const metadataCase of metadataExpectations) {
    test(`${metadataCase.path} renders localized social metadata`, async ({ page }) => {
      await page.goto(metadataCase.path)
      await page.waitForLoadState('domcontentloaded')

      await expect(page.locator('html')).toHaveAttribute('lang', metadataCase.locale)
      await expect(page).toHaveTitle(metadataCase.title)
      expect(await page.title()).not.toContain('| Sherlock | Sherlock')

      const canonicalPath = metadataCase.canonicalPath ?? metadataCase.path
      await expect(page).toHaveURL(new RegExp(`${canonicalPath}/?$`))
      await expectCanonicalPath(page, canonicalPath)
      await expectMetaContent(
        page,
        'meta[name="twitter:title"]',
        metadataCase.socialTitle ?? metadataCase.title
      )
      await expectMetaContent(page, 'meta[name="twitter:description"]', metadataCase.description)
      await expectOgImage(page)
    })
  }
})

test.describe('Former marketplace routes metadata', () => {
  test('/es/deals returns 404 like any unknown route', async ({ request }) => {
    const response = await request.get('/es/deals', { maxRedirects: 0 })

    expect(response.status()).toBe(404)
    expect(response.url()).toContain('/deals')
    expect(response.headers()['location']).toBeUndefined()
  })
})
