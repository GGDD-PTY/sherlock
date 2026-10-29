import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('dev authentication cannot seed companies or documents implicitly', () => {
  const source = readFileSync(join(process.cwd(), 'convex/_helpers/auth.dev.ts'), 'utf8')
  expect(source).not.toMatch(/\.insert\('(companies|documents|documentVersions)'/)
})
