import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd(), '..', '..')

describe('PR #151 review regressions', () => {
  it('does not ship the private red-main issue automation or issue write permissions', () => {
    expect(existsSync(resolve(REPO_ROOT, '.github/workflows/main-red-alert.yml'))).toBe(false)
    const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).not.toContain('issues: write')
    expect(workflow).not.toContain('github.rest.issues')
    expect(workflow).not.toContain('actions/github-script')
  })

  it('labels pause-account failures with pause semantics', () => {
    const actions = readFileSync(
      resolve(process.cwd(), 'src', 'app', '[locale]', '(app)', 'settings', 'actions.ts'),
      'utf8'
    )

    expect(actions).toContain("console.error('[pauseAccount] Error:'")
    expect(actions).not.toContain("console.error('[deleteAccount] Error:'")
  })
})
