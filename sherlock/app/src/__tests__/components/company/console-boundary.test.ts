import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const COMPANY_ROOT = path.join(APP_ROOT, 'src/components/company')
const CONSOLE_CALL = /\bconsole\.(?:log|error|warn|info|debug)\s*\(/

function filesUnder(root: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...filesUnder(file))
      continue
    }
    if (file.endsWith('.ts') || file.endsWith('.tsx')) out.push(file)
  }
  return out
}

describe('company console boundary', () => {
  it('does not call console.* in company UI; logs go through Effect', () => {
    const violations = filesUnder(COMPANY_ROOT)
      .filter((file) => CONSOLE_CALL.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file))
      .toSorted()

    expect(violations).toEqual([])
  })
})
