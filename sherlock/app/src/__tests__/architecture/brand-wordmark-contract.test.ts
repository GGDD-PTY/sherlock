import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = path.resolve(__dirname, '../..')
const SKIP_DIRS = new Set(['__tests__', 'messages'])

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
      continue
    }
    if (entry.name.endsWith('.tsx')) out.push(path.join(dir, entry.name))
  }
  return out
}

// BRAND.md §6: "Nunca reconstruir el wordmark escribiendo 'Sherlock' en el
// navegador — usar el SVG oficial." Un elemento con `font-display` cuyo único
// texto es la palabra Sherlock es exactamente eso. El lockup y el wordmark
// viven en components/shared y se consumen desde ahí.
const TYPED_WORDMARK = /font-display[^>]*>\s*(?:\{\s*['"`])?Sherlock(?:['"`]\s*\})?\s*</

describe('brand wordmark contract', () => {
  it('never types the wordmark in a display span', () => {
    const offenders = walk(SOURCE_ROOT)
      .filter((file) => TYPED_WORDMARK.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file))
    expect(offenders).toEqual([])
  })

  it('renders the brand only through the shared lockup', () => {
    const consumers = walk(SOURCE_ROOT).filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return /SherlockLockup|SherlockWordmark|SherlockMark/.test(source)
    })
    expect(consumers.length).toBeGreaterThan(0)
    for (const file of consumers) {
      if (file.includes(`${path.sep}components${path.sep}shared${path.sep}`)) continue
      const source = fs.readFileSync(file, 'utf8')
      expect(source, path.relative(SOURCE_ROOT, file)).toMatch(
        /from '@\/components\/shared\/SherlockLockup'/
      )
    }
  })
})
