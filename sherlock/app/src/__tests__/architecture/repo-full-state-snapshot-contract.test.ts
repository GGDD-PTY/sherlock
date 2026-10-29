import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd(), '../..')

describe('open-source export privacy contract', () => {
  it('excludes private operational snapshots and knowledge archives', () => {
    const rootEntries = readdirSync(REPO_ROOT)
    expect(rootEntries.filter((name) => /^REPO_FULL_STATE.*\.md$/i.test(name))).toEqual([])

    for (const privatePath of [
      'llm-wiki',
      'docs/kb',
      'docs/wiki',
      'docs/agent-reference',
      'repo-full-state-viewer',
      'sherlock-handoffs',
      '.buildkite',
      'vercel.json',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, privatePath)), `Private export path: ${privatePath}`).toBe(
        false
      )
    }
  })

  it('ignores local credentials, runtime state, databases and private data', () => {
    const ignoredPatterns = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    for (const pattern of [
      '.env',
      '.env.*',
      '**/.convex/',
      '**/.convex-local/',
      '**/.vercel/',
      '*.pem',
      '*.key',
      '*.sqlite*',
      '*.db*',
      'backups/',
      'exports/',
      'data/',
      'private/',
      'llm-wiki/',
      'sherlock-handoffs/',
      'REPO_FULL_STATE*.md',
    ]) {
      expect(ignoredPatterns, `Missing privacy ignore: ${pattern}`).toContain(pattern)
    }
    expect(ignoredPatterns).toContain('!.env.example')
    expect(ignoredPatterns).toContain('!.env.template')
  })
})
