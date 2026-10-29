import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd(), '../..')
const packages = ['package.json', 'sherlock/app/package.json'].map(
  (file) =>
    JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8')) as {
      scripts: Record<string, string>
    }
)

describe('open-source checkout hook policy', () => {
  it('does not ship the private commit, push or merge hooks', () => {
    expect(existsSync(resolve(repoRoot, '.husky'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), '.husky'))).toBe(false)
  })

  it('does not activate git hooks during dependency installation', () => {
    for (const { scripts } of packages) {
      for (const event of ['preinstall', 'install', 'postinstall', 'prepare']) {
        expect(scripts[event] ?? '').not.toMatch(/husky|core\.hooksPath|\.husky/)
      }
    }
  })

  it('exposes quality checks as explicit commands', () => {
    const [{ scripts }] = packages
    expect(scripts.typecheck).toBe('bun --cwd=sherlock/app run typecheck:all')
    expect(scripts.lint).toBe('bun --cwd=sherlock/app run lint')
    expect(scripts.test).toBe('bun --cwd=sherlock/app run test:run')
  })
})
