// Regenera los rasters de marca a partir de los SVG del kit v1.0:
//   public/og-image.png        1200x630, lockup crema sobre borgoña (portada social)
//   public/apple-touch-icon.png 180x180, favicon (crema sobre borgoña, esquinas)
//   src/app/favicon.ico         32 + 16 px, PNG embebido (Vista+ y todos los navegadores)
// Un solo origen (public/brand/*.svg y public/favicon.svg): ningún PNG se edita a mano.
// Uso: bash scripts/with-project-node.sh node scripts/build-brand-rasters.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(APP_ROOT, rel), 'utf8')

const BURGUNDY = '#5A2331'
const CREAM = '#F6F3EC'

function lockupHtml() {
  const svg = read('public/brand/sherlock-lockup.svg').replace(
    'fill="currentColor"',
    `fill="${CREAM}"`
  )
  return `<!doctype html><html><body style="margin:0;width:1200px;height:630px;background:${BURGUNDY};display:flex;align-items:center;justify-content:center">
    <div style="width:720px">${svg}</div></body></html>`
}

function faviconHtml(size) {
  const svg = read('public/favicon.svg')
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
    <div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`
}

function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map(({ png }) => png)])
}

const browser = await chromium.launch()
try {
  const shoot = async (html, width, height, omitBackground = false) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
    await page.setContent(html)
    const png = await page.screenshot({ type: 'png', omitBackground })
    await page.close()
    return png
  }

  writeFileSync(path.join(APP_ROOT, 'public/og-image.png'), await shoot(lockupHtml(), 1200, 630))
  writeFileSync(
    path.join(APP_ROOT, 'public/apple-touch-icon.png'),
    await shoot(faviconHtml(180), 180, 180, true)
  )
  writeFileSync(
    path.join(APP_ROOT, 'src/app/favicon.ico'),
    ico([
      { size: 32, png: await shoot(faviconHtml(32), 32, 32, true) },
      { size: 16, png: await shoot(faviconHtml(16), 16, 16, true) },
    ])
  )
  console.log('brand rasters rebuilt: og-image.png, apple-touch-icon.png, favicon.ico')
} finally {
  await browser.close()
}
