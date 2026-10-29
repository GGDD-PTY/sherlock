// ============================================================================
// PREFETCH DEL SIDECAR MOG DESDE LA SALA
// ============================================================================
// Abrir un libro en frio cuesta ~9,6 s a 20 Mbps: 15 MB de WASM + 2,2 MB de JS
// + 1,3 MB de fuentes que solo empiezan a bajar al pulsar "Abrir". La sala los
// pide como prefetch mientras el cliente mira la lista, guiada por el
// manifiesto que emite el build de Vite del sidecar. Aqui se prueban las dos
// puntas: el plugin que escribe el manifiesto y el helper que lo consume.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MOG_ASSET_MANIFEST_URL,
  prefetchXlsxSidecar,
  resetXlsxSidecarPrefetchForTests,
} from '@/components/documents/viewers/xlsxSidecarPrefetch'
import { mogAssetManifestPlugin, orderForPrefetch } from '../../../../mog-sidecar/vite.config.js'

const MANIFEST = {
  prefetch: [
    '/mog/assets/compute_core_wasm_bg-abc.wasm',
    '/mog/assets/index-def.js',
    '/mog/assets/Carlito-Regular-ghi.ttf',
    // Nada fuera de /mog/assets/ entra al <head>, venga de donde venga.
    'https://evil.example/x.wasm',
    '/mog/assets/../../etc/passwd',
    42,
  ],
}

function prefetchLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll('link[rel="prefetch"]'))
}

/** `Response.json()` resuelve en macrotareas, no en microtareas: se cede el turno. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('prefetchXlsxSidecar', () => {
  beforeEach(() => {
    resetXlsxSidecarPrefetchForTests()
    document.head.innerHTML = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true })
  })

  it('pide el manifiesto y cuelga un <link rel=prefetch> por cada asset del sidecar', async () => {
    prefetchXlsxSidecar()
    await flush()

    expect(fetch).toHaveBeenCalledWith(MOG_ASSET_MANIFEST_URL, { credentials: 'same-origin' })
    expect(prefetchLinks().map((link) => link.getAttribute('href'))).toEqual([
      '/mog/assets/compute_core_wasm_bg-abc.wasm',
      '/mog/assets/index-def.js',
      '/mog/assets/Carlito-Regular-ghi.ttf',
    ])
  })

  it('marca las fuentes como CORS anonimo, que es como las pide el CSS del sidecar', async () => {
    prefetchXlsxSidecar()
    await flush()

    const byHref = Object.fromEntries(
      prefetchLinks().map((link) => [link.getAttribute('href'), link.crossOrigin])
    )
    expect(byHref['/mog/assets/Carlito-Regular-ghi.ttf']).toBe('anonymous')
    expect(byHref['/mog/assets/compute_core_wasm_bg-abc.wasm']).toBeNull()
  })

  it('es idempotente: la segunda llamada no vuelve a pedir nada', async () => {
    prefetchXlsxSidecar()
    prefetchXlsxSidecar()
    await flush()
    prefetchXlsxSidecar()
    await flush()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(prefetchLinks()).toHaveLength(3)
  })

  it('respeta el ahorro de datos del navegador', async () => {
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    })

    prefetchXlsxSidecar()
    await flush()

    expect(fetch).not.toHaveBeenCalled()
    expect(prefetchLinks()).toHaveLength(0)
  })

  it('un manifiesto ausente no rompe la sala', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    )

    expect(() => prefetchXlsxSidecar()).not.toThrow()
    await flush()

    expect(prefetchLinks()).toHaveLength(0)
  })
})

describe('mogAssetManifestPlugin', () => {
  it('ordena primero lo que mas pesa y mas tarde se pide: wasm, js, css, fuentes', () => {
    expect(
      orderForPrefetch([
        'assets/Carlito-Regular-b.ttf',
        'assets/index-d.css',
        'assets/index-a.js',
        'assets/compute_core_wasm_bg-c.wasm',
        'assets/compute_core_wasm-e.js',
        'assets/Caladea-Bold-f.ttf',
      ])
    ).toEqual([
      'assets/compute_core_wasm_bg-c.wasm',
      'assets/compute_core_wasm-e.js',
      'assets/index-a.js',
      'assets/index-d.css',
      'assets/Caladea-Bold-f.ttf',
      'assets/Carlito-Regular-b.ttf',
    ])
  })

  it('emite assets-manifest.json con rutas bajo /mog/ y sin el index.html', () => {
    const emitFile = vi.fn()
    const plugin = mogAssetManifestPlugin()
    plugin.generateBundle.call(
      { emitFile },
      {},
      {
        'index.html': { type: 'asset' },
        'assets/index-a.js': { type: 'chunk' },
        'assets/compute_core_wasm_bg-c.wasm': { type: 'asset' },
      }
    )

    expect(emitFile).toHaveBeenCalledTimes(1)
    const [emitted] = emitFile.mock.calls[0]
    expect(emitted.type).toBe('asset')
    expect(emitted.fileName).toBe('assets-manifest.json')
    expect(JSON.parse(emitted.source)).toEqual({
      prefetch: ['/mog/assets/compute_core_wasm_bg-c.wasm', '/mog/assets/index-a.js'],
    })
  })
})
