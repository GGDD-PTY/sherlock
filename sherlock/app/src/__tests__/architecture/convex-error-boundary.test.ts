import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')
const CONVEX_ROOT = path.join(APP_ROOT, 'convex')
const RAW_THROW_PATTERN = /throw new Error\s*\(/

function collectConvexFiles(dir: string, results: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === '_generated' || entry.name.startsWith('.')) {
        continue
      }

      collectConvexFiles(fullPath, results)
      continue
    }

    if (entry.name.endsWith('.ts')) {
      results.push(fullPath)
    }
  }

  return results
}

describe('convex error boundary', () => {
  it('keeps app convex modules on standardized errors instead of raw throws', () => {
    const violations = collectConvexFiles(CONVEX_ROOT)
      .filter((file) => RAW_THROW_PATTERN.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file).replaceAll(path.sep, '/'))

    expect(violations).toEqual([])
  })
})
