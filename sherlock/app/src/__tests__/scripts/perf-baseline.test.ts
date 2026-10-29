// ============================================================================
// perf:baseline — funciones puras
// ============================================================================
// El script lee `.next`; aquí se prueba solo la parte que no toca disco: cómo
// se recorta el manifest de cliente, cómo se cruzan las fronteras con el bundle
// de servidor y cómo se suman los chunks por ruta.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  BUDGETS,
  collectRouteChunks,
  findRenderedBoundaries,
  median,
  parseClientReferenceManifest,
  sumChunkSizes,
  type ClientReferenceManifest,
} from '../../../scripts/perf-baseline'

const LANDING = '/abs/src/components/mycroft/MycroftLanding.tsx'
const NAVBAR = '/abs/src/components/layout/Navbar.tsx'
const ADMIN_ONLY = '/abs/src/components/admin/AdminCompaniesClient.tsx'

const manifest: ClientReferenceManifest = {
  clientModules: {
    [LANDING]: {
      chunks: [
        '2668',
        'static/chunks/2668-abc.js',
        '4711',
        'static/chunks/app/%5Blocale%5D/page-def.js',
      ],
    },
    [`${NAVBAR}#Navbar`]: {
      chunks: ['2668', 'static/chunks/2668-abc.js', '3818', 'static/chunks/3818-convex.js'],
    },
    [ADMIN_ONLY]: {
      chunks: ['9999', 'static/chunks/9999-admin.js'],
    },
  },
}

// El bundle de servidor de la landing nombra la landing y el navbar del layout,
// nunca el cliente de admin.
const serverSources = [
  `registerClientReference(function(){},${JSON.stringify(LANDING)},"MycroftLanding")`,
  `registerClientReference(function(){},${JSON.stringify(NAVBAR)},"Navbar")`,
]

describe('perf:baseline — manifest de cliente', () => {
  it('recorta el objeto JSON de la ruta pedida sin ejecutar el archivo', () => {
    const source =
      'globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});' +
      `globalThis.__RSC_MANIFEST["/[locale]/page"]=${JSON.stringify({ clientModules: manifest.clientModules, ssrModuleMapping: {} })}`

    const parsed = parseClientReferenceManifest(source, '/[locale]/page')

    expect(Object.keys(parsed.clientModules)).toEqual(Object.keys(manifest.clientModules))
  })

  it('falla claro cuando el archivo no trae la ruta', () => {
    expect(() => parseClientReferenceManifest('globalThis.__RSC_MANIFEST={}', '/x/page')).toThrow(
      /no trae la ruta \/x\/page/
    )
  })
})

describe('perf:baseline — chunks por ruta', () => {
  it('solo cuenta las fronteras que el bundle de servidor nombra', () => {
    const boundaries = findRenderedBoundaries(serverSources, manifest)

    // La función devuelve las fronteras ordenadas (recibo determinista):
    // `layout/Navbar` va antes que `mycroft/MycroftLanding`.
    expect(boundaries).toEqual([`${NAVBAR}#Navbar`, LANDING])
    expect(boundaries).not.toContain(ADMIN_ONLY)
  })

  it('suma runtime compartido más chunks de las fronteras, sin repetir y decodificado', () => {
    const { boundaries, files } = collectRouteChunks({
      serverSources,
      manifest,
      rootMainFiles: ['static/chunks/webpack-1.js', 'static/chunks/main-app-2.js'],
    })

    expect(boundaries).toHaveLength(2)
    expect(files).toEqual([
      'static/chunks/2668-abc.js',
      'static/chunks/3818-convex.js',
      'static/chunks/app/[locale]/page-def.js',
      'static/chunks/main-app-2.js',
      'static/chunks/webpack-1.js',
    ])
    // Los ids numéricos que alternan con los archivos no son chunks.
    expect(files.some((file) => /^\d+$/.test(file))).toBe(false)
    expect(files).not.toContain('static/chunks/9999-admin.js')
  })

  it('suma crudo y gzip con un lector inyectado', () => {
    const small = 'export const b = 1\n'
    const contents: Record<string, string> = { 'a.js': 'a'.repeat(4096), 'b.js': small }
    const { rawBytes, gzipBytes } = sumChunkSizes(['a.js', 'b.js'], (file) =>
      Buffer.from(contents[file] ?? '')
    )

    expect(rawBytes).toBe(4096 + small.length)
    expect(gzipBytes).toBeGreaterThan(0)
    expect(gzipBytes).toBeLessThan(rawBytes)
  })
})

describe('perf:baseline — presupuesto y mediana', () => {
  it('fija los presupuestos gzip por superficie decididos el 2026-09-06', () => {
    expect(BUDGETS).toEqual({
      // Landing revisada a 290 KB el 2026-09-07: guardia sobre los 282 KB
      // medidos, no meta de recorte ([F] 2026-09-07 01:04).
      landing: 290 * 1024,
      signIn: 300 * 1024,
      companyRoom: 450 * 1024,
      adminRoom: 500 * 1024,
      pdfViewer: 400 * 1024,
      xlsxViewer: 2400 * 1024,
    })
  })

  it('calcula la mediana con muestras pares, impares y vacías', () => {
    expect(median([300, 100, 200])).toBe(200)
    expect(median([100, 400])).toBe(250)
    expect(median([])).toBeNull()
  })
})
