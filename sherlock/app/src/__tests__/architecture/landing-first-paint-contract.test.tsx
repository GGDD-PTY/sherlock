// ============================================================================
// PRIMER PAINT DE LA LANDING
// ============================================================================
// El `h1` de la landing es el texto de la promesa y es el elemento LCP. Medido
// el 2026-09-02 en producción pintaba 4.2 s tarde en móvil, de los cuales
// 3.45 s eran render delay puro, por tres cosas que este contrato fija:
//
// 1) `src/app/[locale]/loading.tsx` existía y `loading.tsx` crea un boundary de
//    Suspense en su segmento. El hero no viajaba en el shell: llegaba después,
//    dentro de `<div hidden id="S:0">`, y solo lo revelaba el script
//    `$RC("B:0","S:0")` unos 8 KB más adelante en el stream. El primer paint
//    era un skeleton de tarjetas de dashboard sobre una página de marketing.
//    El skeleton ahora vive en `(app)`, que es donde hay dashboards.
// 2) `posthog-js/react` estaba importado estático solo para tener el Provider,
//    y eso metía los ~70 KiB del SDK en el grafo inicial de CADA página. El
//    import diferido es la única vía; volver al estático tiene que ponerse rojo.
// 3) Las caras de `next/font/local` y su preload. Hasta la tarjeta O2-04 las
//    dos iban sin preload, porque con el CSS servido aparte cada fuente se
//    pedía por dos URLs distintas en producción (la del preload con el `?dpl=`
//    del deployment vivo, la del `@font-face` con el horneado en el CSS). Desde
//    O2-04 el CSS viaja dentro del HTML (`experimental.inlineCss`), así que las
//    dos URLs nacen del mismo deployment, y la cara display SÍ se precarga: con
//    `display: swap` el h1 no pinta hasta que llega Fraunces o vencen los
//    100 ms de bloqueo, y mientras tanto todo lo que baja entra al grafo del
//    LCP. La cara mono se queda sin preload: no pinta el LCP.
//
// El caso de render mira HTML y el resto mira el árbol y el código como texto
// (idioma de `src/__tests__/architecture/`): ni el boundary de ruta de Next ni
// `next/font` corren en vitest, así que la única forma de fijarlos es leyendo
// el árbol y el call site.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  setRequestLocale: vi.fn(),
}))

const SRC_ROOT = path.resolve(__dirname, '..', '..')
const LOCALE_SEGMENT = path.join(SRC_ROOT, 'app', '[locale]')
const PUBLIC_SEGMENT = path.join(LOCALE_SEGMENT, '(public)')
const LOCAL_FONTS_PATH = path.join(SRC_ROOT, 'lib', 'fonts', 'local-fonts.ts')
const NEXT_CONFIG_PATH = path.resolve(SRC_ROOT, '..', 'next.config.ts')
const POSTHOG_PROVIDER_PATH = path.join(SRC_ROOT, 'components', 'providers', 'PostHogProvider.tsx')

// Todo lo que se evalúa para servir `/es`. Un import estático de `posthog-js`
// en cualquiera de estos archivos vuelve a poner el SDK en el grafo inicial.
const LANDING_ROUTE_GRAPH = [
  path.join(LOCALE_SEGMENT, 'layout.tsx'),
  path.join(PUBLIC_SEGMENT, 'layout.tsx'),
  path.join(PUBLIC_SEGMENT, 'page.tsx'),
  path.join(LOCALE_SEGMENT, 'error.tsx'),
  path.join(PUBLIC_SEGMENT, 'error.tsx'),
  path.join(SRC_ROOT, 'components', 'providers', 'PublicShell.tsx'),
  path.join(SRC_ROOT, 'components', 'layout', 'PublicNavbar.tsx'),
  path.join(SRC_ROOT, 'app', 'global-error.tsx'),
  path.join(SRC_ROOT, 'components', 'mycroft', 'MycroftLanding.tsx'),
  path.join(SRC_ROOT, 'components', 'mycroft', 'MycroftLandingPresentation.tsx'),
  path.join(SRC_ROOT, 'lib', 'observability', 'capture-client-exception.ts'),
  path.join(SRC_ROOT, 'lib', 'analytics', 'posthog-sanitize.ts'),
  POSTHOG_PROVIDER_PATH,
]

// El shell público y lo que cuelga de él. Ninguno puede tocar Convex, AuthKit
// ni la sesión: eran 23 KB gzip de cliente de Convex más el provider de
// AuthKit bajando en cada visita a la landing para no consultarlos nunca
// (tarjeta O2-06).
const PUBLIC_SHELL_GRAPH = [
  path.join(LOCALE_SEGMENT, 'layout.tsx'),
  path.join(PUBLIC_SEGMENT, 'layout.tsx'),
  path.join(PUBLIC_SEGMENT, 'page.tsx'),
  path.join(PUBLIC_SEGMENT, 'error.tsx'),
  path.join(PUBLIC_SEGMENT, 'not-found.tsx'),
  path.join(SRC_ROOT, 'components', 'providers', 'PublicShell.tsx'),
  path.join(SRC_ROOT, 'components', 'providers', 'SkipToContent.tsx'),
  path.join(SRC_ROOT, 'components', 'layout', 'PublicNavbar.tsx'),
  path.join(SRC_ROOT, 'components', 'mycroft', 'MycroftLanding.tsx'),
  path.join(SRC_ROOT, 'components', 'mycroft', 'MycroftLandingPresentation.tsx'),
]

// Las dos comillas: prettier deja comillas simples, pero un `from "convex/react"`
// pegado a mano se le escapaba al guard y volvía a meter sesión en la landing.
const SESSION_IMPORT_PATTERNS = [
  /from ['"][^'"]*convex\/react['"]/,
  /from ['"][^'"]*@workos-inc\/authkit-nextjs/,
  /useCurrentUser/,
  /ConvexClientProvider/,
  /AuthProvider/,
] as const

// `import type ... from 'posthog-js'` se borra en build; el que pesa es el de
// valor. `import(...)` diferido tampoco cuenta: no entra al grafo inicial.
function staticValueImportsOfPostHog(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => /from\s+'posthog-js(\/react)?'/.test(line))
    .filter((line) => !/^\s*import\s+type\s/.test(line))
    .filter((line) => !/^\s*\/\//.test(line))
}

describe('primer paint de la landing', () => {
  it('sirve el h1 del hero en el HTML del servidor de la ruta, sin fallback de por medio', async () => {
    const { default: HomePage } = await import('@/app/[locale]/(public)/page')

    const html = renderToStaticMarkup(await HomePage({ params: Promise.resolve({ locale: 'es' }) }))

    expect(html).toContain('data-testid="landing-hero-title"')
    expect(html).toContain(esMessages.mycroft.hero.title)
    // El hero es lo primero del documento, no algo que aparece detrás de un
    // skeleton: la página no puede renderizar un fallback como contenido.
    expect(html).not.toContain('data-slot="skeleton"')
    expect(html.indexOf('landing-hero-title')).toBeLessThan(html.indexOf('mycroft-upload-dossier'))
  })

  it('no deja un loading.tsx sobre el shell público', () => {
    // Este es el pin real del boundary: `loading.tsx` es lo que hace que Next
    // envuelva el segmento en Suspense y mande el hero escondido en el stream.
    expect(fs.existsSync(path.join(LOCALE_SEGMENT, 'loading.tsx'))).toBe(false)
    // O2-06 (decisión de la estación 2026-09-12): el skeleton del grupo se
    // retiró. `AppShell` vive en el layout de cada sección, así que un
    // `loading.tsx` de grupo pintaba el esqueleto sin barra ni footer; cada
    // sección conserva el suyo, dentro de su layout.
    expect(fs.existsSync(path.join(LOCALE_SEGMENT, '(app)', 'loading.tsx'))).toBe(false)
    expect(fs.existsSync(path.join(LOCALE_SEGMENT, '(app)', 'admin', 'loading.tsx'))).toBe(true)
  })

  it('no mete el sdk de posthog en el grafo inicial de la landing', () => {
    for (const file of LANDING_ROUTE_GRAPH) {
      const source = fs.readFileSync(file, 'utf8')
      expect(staticValueImportsOfPostHog(source), `${path.basename(file)} importa el SDK`).toEqual(
        []
      )
    }

    const provider = fs.readFileSync(POSTHOG_PROVIDER_PATH, 'utf8')
    // El re-export volvía a arrastrar el módulo entero por la puerta de atrás.
    expect(provider).not.toMatch(/export\s*\{[^}]*usePostHog/)
    // El cliente sí baja, pero diferido y sin `posthog-js/react`: el Provider
    // de esa librería montaba tarde y remontaba el subárbol de la landing.
    expect(provider).toMatch(/import\('posthog-js'\)/)
    expect(provider).not.toMatch(/import\(\s*'posthog-js\/react'/)
  })

  it('sirve el shell público sin convex, sin authkit y sin sesión (tarjeta O2-06)', () => {
    for (const file of PUBLIC_SHELL_GRAPH) {
      const source = fs.readFileSync(file, 'utf8')
      for (const pattern of SESSION_IMPORT_PATTERNS) {
        expect(source, `${path.basename(file)} monta sesión`).not.toMatch(pattern)
      }
    }

    // El grupo `(public)` es lo que separa los dos shells: sin él, los
    // providers vuelven al layout raíz y bajan en la landing otra vez.
    expect(fs.existsSync(path.join(PUBLIC_SEGMENT, 'layout.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(PUBLIC_SEGMENT, 'loading.tsx'))).toBe(false)

    // `/ayuda` monta Convex en su propio layout: votos y la caja de texto.
    // Ese segmento no puede colarse en el grafo de `/es`.
    const ayudaLayout = fs.readFileSync(path.join(PUBLIC_SEGMENT, 'ayuda', 'layout.tsx'), 'utf8')
    expect(ayudaLayout).toMatch(/ConvexClientProvider/)
    const publicLayout = fs.readFileSync(path.join(PUBLIC_SEGMENT, 'layout.tsx'), 'utf8')
    expect(publicLayout).not.toMatch(/ConvexClientProvider/)
    expect(publicLayout).not.toMatch(/AuthProvider/)
  })

  it('no carga el sdk desde la pantalla de error', () => {
    const source = fs.readFileSync(
      path.join(SRC_ROOT, 'lib', 'observability', 'capture-client-exception.ts'),
      'utf8'
    )
    // Ni estático ni diferido: reportar un error no puede bajar 70 KiB durante
    // el LCP. La entrega va por el sink que registra el provider tras el init.
    expect(source).not.toMatch(/import\(\s*'posthog-js/)
    expect(source).toMatch(/registerExceptionSink/)
  })

  it('precarga solo la cara display, la que pinta el h1 (tarjeta O2-04)', () => {
    const source = fs.readFileSync(LOCAL_FONTS_PATH, 'utf8')
    const faces = source.match(/localFont\(\{[\s\S]*?\n\}\)/g) ?? []

    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      // `swap` es lo que deja pintar el hero con Georgia si la fuente tarda;
      // sin él, el h1 quedaría escondido hasta que baje.
      expect(face).toMatch(/display:\s*'swap'/)
      const isDisplayFace = /variable:\s*'--font-display'/.test(face)
      expect(face).toMatch(isDisplayFace ? /preload:\s*true/ : /preload:\s*false/)
    }
  })

  it('sirve el css dentro del html, sin <link> que bloquee el render', () => {
    // Los tres stylesheets del shell costaban 1.2 s de bloqueo y escondían el
    // `@font-face` detrás de un salto de red (Lighthouse móvil, 2026-09-11).
    const config = fs.readFileSync(NEXT_CONFIG_PATH, 'utf8')

    expect(config).toMatch(/inlineCss:\s*true/)
  })
})
