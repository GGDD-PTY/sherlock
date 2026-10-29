import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(resolve(process.cwd(), '../../.github/workflows/ci.yml'), 'utf8')
const appPackage = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('explicit production bundle budget', () => {
  it('keeps the bundle budget available after a local build without adding it to CI', () => {
    expect(appPackage.scripts['bundle:size']).toBe(
      'bun run build && tsx scripts/bundle-size-check.ts'
    )
    expect(workflow).not.toContain('bundle-size')
    expect(workflow).not.toContain('upload-artifact')
    expect(workflow).not.toMatch(/run:\s.*\bbuild\b/)
  })
})
