// ============================================================================
// CONTRATO DE LOS ASSETS DE LOS VISORES DEL VDR
// ============================================================================
// El sidecar Mog y pdfjs viven FUERA del bundle de Next, en `public/mog/` y
// `public/pdfjs/`. Eso solo funciona si cuatro cosas se mantienen alineadas, y
// las cuatro se rompen en silencio (el síntoma es un 404 servido como HTML que
// el runtime interpreta como WASM):
//
//   1. el proxy deja pasar los prefijos ANTES de cualquier rewrite,
//   2. el `matcher` no los manda al middleware,
//   3. `next.config.ts` emite el CSP completo con `wasm-unsafe-eval` para /mog,
//   4. LAS DOS cadenas de build generan los assets.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIntlMiddleware = vi.fn((_request: NextRequest) => {
  const response = NextResponse.next()
  response.headers.set('x-test-intl-middleware', 'hit')
  return response
})

vi.mock('next-intl/middleware', () => ({
  default: () => mockIntlMiddleware,
}))

vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkit: vi.fn(async () => ({
    session: { user: null },
    headers: new Headers(),
    authorizationUrl: 'http://localhost:3000/login',
  })),
  partitionAuthkitHeaders: () => ({
    requestHeaders: new Headers(),
    responseHeaders: new Headers(),
  }),
  applyResponseHeaders: (response: NextResponse) => response,
}))

const APP_DIR = process.cwd()

async function loadProxy() {
  return import('@/proxy')
}

function source(relativePath: string): string {
  return readFileSync(join(APP_DIR, relativePath), 'utf8')
}

describe('viewer asset routing', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    delete process.env.BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
  })

  it('bypasses the proxy for the sidecar and pdfjs prefixes', async () => {
    const { isViewerAssetRoute } = await loadProxy()
    expect(isViewerAssetRoute('/mog/index.html')).toBe(true)
    expect(isViewerAssetRoute('/mog/assets/compute_core_wasm_bg-CEDeWido.wasm')).toBe(true)
    expect(isViewerAssetRoute('/mog/assets/index-UVExuV9T.js')).toBe(true)
    expect(isViewerAssetRoute('/pdfjs/pdf.worker.min.mjs')).toBe(true)
    expect(isViewerAssetRoute('/pdfjs/standard_fonts/FoxitSans.pfb')).toBe(true)
  })

  it('does not claim look-alike paths', async () => {
    const { isViewerAssetRoute } = await loadProxy()
    expect(isViewerAssetRoute('/mog')).toBe(false)
    expect(isViewerAssetRoute('/mogul/x')).toBe(false)
    expect(isViewerAssetRoute('/es/mog/index.html')).toBe(false)
    expect(isViewerAssetRoute('/api/documents/access/grant_1')).toBe(false)
  })

  it('runs the bypass as the first check of both proxies', () => {
    const proxy = source('src/proxy.ts')
    for (const entry of [
      'function devProxy(request: NextRequest) {',
      'async function workosProxy(request: NextRequest) {',
    ]) {
      const body = proxy.slice(proxy.indexOf(entry))
      const bypass = body.indexOf('isViewerAssetRoute(pathname)')
      const firstRewrite = body.indexOf('rewriteToLocalizedNotFound')
      expect(bypass).toBeGreaterThan(-1)
      expect(bypass).toBeLessThan(firstRewrite)
    }
  })

  it.each([
    '/mog/index.html',
    '/mog/assets/compute_core_wasm_bg-CEDeWido.wasm',
    '/pdfjs/pdf.worker.min.mjs',
  ])('lets %s through untouched instead of rewriting it to the localized 404', async (pathname) => {
    const { proxy } = await loadProxy()
    const response = await proxy(new NextRequest(`http://localhost:3000${pathname}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
  })

  it('excludes the prefixes and the sidecar extensions from the middleware matcher', () => {
    const matcher = source('src/proxy.ts').slice(
      source('src/proxy.ts').indexOf('export const config')
    )
    expect(matcher).toContain('mog/')
    expect(matcher).toContain('pdfjs/')
    // Extensiones que sirve el sidecar y que el regex original no cubría.
    for (const extension of ['mjs', 'wasm', 'data', 'otf']) {
      expect(matcher).toContain(extension)
    }
  })
})

describe('viewer asset headers', () => {
  const config = source('next.config.ts')

  it('emits the FULL hardened CSP for /mog, not a partial one', () => {
    const block = config.slice(config.indexOf("source: '/mog/:path*'"))
    // Next hace last-wins por clave: un CSP parcial borraría las directivas
    // endurecidas del bloque global en esa ruta.
    expect(block).toContain('cspDirectives')
    expect(block).toContain("frame-ancestors 'self'")
    expect(block).toContain("'wasm-unsafe-eval'")
    expect(block).toContain("{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }")
  })

  it('keeps the /mog block after the global block so it wins', () => {
    expect(config.indexOf("source: '/(.*)'")).toBeLessThan(config.indexOf("source: '/mog/:path*'"))
  })

  it('does not relax wasm-unsafe-eval anywhere else', () => {
    const occurrences = config.split("'wasm-unsafe-eval'").length - 1
    // Una vez en el bloque /mog y una en su comentario explicativo.
    expect(occurrences).toBeLessThanOrEqual(2)
    expect(
      config.slice(
        config.indexOf("source: '/(.*)'"),
        config.indexOf("source: '/api/documents/access/:grantId'")
      )
    ).not.toContain('wasm-unsafe-eval')
  })
})

describe('viewer asset build chains', () => {
  it('generates the assets in both chains, because neither calls the other', () => {
    expect(source('package.json')).toContain(
      'node scripts/build-viewer-assets.mjs && node scripts/quarantine-next-ds-store.mjs && next build'
    )
    expect(source('scripts/vercel-build.sh')).toContain('node scripts/build-viewer-assets.mjs')
    expect(source('scripts/vercel-build.sh')).toContain('test -f public/mog/index.html')
  })

  it('registers the sidecar as a root workspace so no nested install breaks the lockfile', () => {
    const root = JSON.parse(readFileSync(join(APP_DIR, '../../package.json'), 'utf8'))
    expect(root.workspaces).toContain('sherlock/app/mog-sidecar')
  })

  it('keeps the generated output out of git', () => {
    const ignored = source('.gitignore')
    expect(ignored).toContain('/public/mog/')
    expect(ignored).toContain('/public/pdfjs/')
  })
})

describe('untrusted markup stays out of the viewers', () => {
  it('keeps deliverable HTML served as text/plain, never previewed', () => {
    expect(source('src/components/company/DeliverableViewer.tsx')).toContain("HTML: 'text/plain'")
  })

  it('never mounts producer HTML through innerHTML in a viewer', () => {
    for (const file of [
      'src/components/documents/viewers/DocumentViewer.tsx',
      'src/components/documents/viewers/DocxViewer.tsx',
      'src/components/documents/viewers/XlsxViewer.tsx',
      'src/components/documents/viewers/PdfViewer.tsx',
      'src/components/documents/viewers/PptxViewer.tsx',
      'src/components/documents/viewers/ImageViewer.tsx',
    ]) {
      expect(source(file)).not.toContain('dangerouslySetInnerHTML')
      expect(source(file)).not.toContain('.innerHTML')
    }
  })

  it('keeps docx-preview altChunk (embedded HTML) disabled', () => {
    expect(source('src/components/documents/viewers/DocxViewer.tsx')).toContain(
      'experimental: false'
    )
  })

  it('never hands the grant URL to the Mog sidecar', () => {
    const sidecarHost = source('src/components/documents/viewers/XlsxViewer.tsx')
    // El iframe apunta al estático; los bytes viajan por el MessagePort.
    expect(sidecarHost).toContain('src={MOG_SIDECAR_URL}')
    expect(sidecarHost).not.toContain('src={viewUrl}')
    expect(sidecarHost).toContain('new MessageChannel()')
  })
})
