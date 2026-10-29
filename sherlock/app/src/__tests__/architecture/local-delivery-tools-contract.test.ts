import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd(), '../..')
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('explicit local verification commands', () => {
  it('runs the complete app test suite without a private delivery wrapper', () => {
    expect(rootPackage.scripts.test).toBe('bun --cwd=sherlock/app run test:run')
    expect(rootPackage.scripts.typecheck).toBe('bun --cwd=sherlock/app run typecheck:all')
    expect(rootPackage.scripts.lint).toBe('bun --cwd=sherlock/app run lint')
  })
})
