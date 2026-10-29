import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function readAppFile(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function sizeOf(path: string) {
  return statSync(join(process.cwd(), path)).size
}

describe('Sherlock brand identity', () => {
  it('uses Sherlock across first-load brand code and metadata', () => {
    const joined = [
      'src/app/[locale]/layout.tsx',
      'src/components/shared/SherlockLockup.tsx',
      'src/components/shared/brand-paths.ts',
      'src/lib/site/brand.ts',
    ]
      .map(readAppFile)
      .join('\n')

    expect(joined).toContain('Sherlock')
    expect(joined).not.toContain('CASA GEDE')
    expect(joined).not.toContain('Casa Gede')
    expect(joined).not.toMatch(/>\s*GD\s*</)
  })

  it('ships the corrected brand assets, not the pre-rebrand placeholders', () => {
    // 2026-07-27: los assets pasaron a ser el logo oficial (lupa + S en vino y
    // marfil) en binario — favicon.ico real, apple-touch y OG en PNG (los
    // scrapers sociales no renderizan SVG). Un asset diminuto delata el
    // placeholder viejo: el favicon.ico stale era un triángulo negro genérico.
    expect(sizeOf('src/app/favicon.ico')).toBeGreaterThan(1_000)
    expect(sizeOf('public/apple-touch-icon.png')).toBeGreaterThan(4_000)
    expect(sizeOf('public/og-image.png')).toBeGreaterThan(20_000)

    // 2026-08-28: el favicon y el mark son vectoriales. El PNG embebido y el
    // `mask-image` sobre /brand-mark.png existían solo porque el isotipo no
    // tenía versión en curvas; el Sistema de Marca v1.0 la trajo.
    const faviconSvg = readAppFile('public/favicon.svg')
    expect(faviconSvg).not.toContain('data:image/png;base64,')
    expect(faviconSvg).toContain('<path')

    for (const asset of [
      'public/brand/sherlock-lockup.svg',
      'public/brand/sherlock-wordmark.svg',
      'public/brand/sherlock-mark.svg',
      'public/brand/sherlock-mark-duo.svg',
    ]) {
      const source = readAppFile(asset)
      expect(source, `${asset} must inherit its colour from the theme`).toContain('currentColor')
      expect(source, `${asset} must not bake in a background`).not.toContain('#f1efe8')
    }

    // El isotipo del navbar/footer se dibuja en curvas, sin mask ni raster.
    const mark = readAppFile('src/components/shared/SherlockLockup.tsx')
    expect(mark).not.toContain('brand-mark.png')
    expect(mark).not.toContain('maskImage')
    expect(mark).toContain('currentColor')
    // Y ninguna referencia al OG retirado sobrevive en el código.
    const brand = readAppFile('src/lib/site/brand.ts')
    expect(brand).toContain('/og-image.png')
    expect(brand).not.toContain('/og-image.svg')
  })
})
