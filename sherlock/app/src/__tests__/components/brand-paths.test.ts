import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SHERLOCK_LOCKUP_MARK_SCALE,
  SHERLOCK_LOCKUP_VIEW_BOX,
  SHERLOCK_LOCKUP_WORDMARK_OFFSET,
  SHERLOCK_MARK_PATH,
  SHERLOCK_MARK_TRANSFORM,
  SHERLOCK_MARK_VIEW_BOX,
  SHERLOCK_WORDMARK_PATH,
  SHERLOCK_WORDMARK_TRANSFORM,
  SHERLOCK_WORDMARK_VIEW_BOX,
} from '@/components/shared/brand-paths'

const BRAND_DIR = path.resolve(__dirname, '../../../public/brand')

function readSvg(name: string) {
  return fs.readFileSync(path.join(BRAND_DIR, name), 'utf8')
}

function paths(svg: string) {
  return [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) =>
    match[1].replace(/\s+/g, ' ').trim()
  )
}

function attr(svg: string, name: string) {
  return [...svg.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((match) => match[1])
}

// Los componentes inlinean los trazos del kit para no depender de un fetch ni
// de un <img> que no hereda currentColor. Si alguien reemplaza un SVG del kit,
// este test obliga a regenerar las constantes en vez de dejar dos logos.
describe('brand paths mirror the official SVGs', () => {
  it('mark', () => {
    const svg = readSvg('sherlock-mark.svg')
    expect(paths(svg)).toEqual([SHERLOCK_MARK_PATH])
    expect(attr(svg, 'viewBox')).toEqual([SHERLOCK_MARK_VIEW_BOX])
    expect(attr(svg, 'transform')).toEqual([SHERLOCK_MARK_TRANSFORM])
  })

  it('wordmark', () => {
    const svg = readSvg('sherlock-wordmark.svg')
    expect(paths(svg)).toEqual([SHERLOCK_WORDMARK_PATH])
    expect(attr(svg, 'viewBox')).toEqual([SHERLOCK_WORDMARK_VIEW_BOX])
    expect(attr(svg, 'transform')).toEqual([SHERLOCK_WORDMARK_TRANSFORM])
  })

  it('lockup composes the same mark and wordmark', () => {
    const svg = readSvg('sherlock-lockup.svg')
    expect(paths(svg)).toEqual([SHERLOCK_MARK_PATH, SHERLOCK_WORDMARK_PATH])
    expect(attr(svg, 'viewBox')).toEqual([SHERLOCK_LOCKUP_VIEW_BOX])
    expect(attr(svg, 'transform')).toEqual([
      SHERLOCK_LOCKUP_MARK_SCALE,
      SHERLOCK_MARK_TRANSFORM,
      `${SHERLOCK_LOCKUP_WORDMARK_OFFSET} scale(1.000000)`,
      SHERLOCK_WORDMARK_TRANSFORM,
    ])
  })
})
