import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// ============================================================================
// APT MIRROR BEFORE PLAYWRIGHT --with-deps
// ============================================================================
// #328: Depot images ship /etc/apt/apt-mirrors.txt pointing at
// us-east-1.ec2.archive.ubuntu.com, which is unreachable from Depot's network.
// `playwright install --with-deps` then burns the whole job timeout on Ign:
// retries. The fix is the rewrite script, not a bigger timeout. This contract
// fails if a new --with-deps job forgets to call the script first.
// ============================================================================

const REPO_ROOT = resolve(process.cwd(), '../..')
const SCRIPT_REL = 'scripts/ci/apt-use-reachable-mirror.sh'

function readRepo(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
}

describe('reachable apt mirror before Playwright --with-deps', () => {
  const script = readRepo(SCRIPT_REL)

  it('rewrites the Depot EC2 Ubuntu mirror to archive.ubuntu.com', () => {
    expect(script).toContain("MIRROR='http://archive.ubuntu.com/ubuntu/'")
    expect(script).toContain('set -euo pipefail')
    expect(script).toContain('ec2\\.archive\\.ubuntu\\.com')
    expect(script).toContain('el mirror de apt ya es alcanzable — sin cambios')

    const sed = script.match(/s#([^#]+)#\$\{MIRROR\}#g/)
    expect(sed?.[1]).toBe('https?://[a-z0-9.-]*ec2\\.archive\\.ubuntu\\.com/ubuntu/?')

    const rewrite = new RegExp(sed![1], 'g')
    expect('http://us-east-1.ec2.archive.ubuntu.com/ubuntu/'.replace(rewrite, 'CANONICAL')).toBe(
      'CANONICAL'
    )
    expect('https://us-west-2.ec2.archive.ubuntu.com/ubuntu'.replace(rewrite, 'CANONICAL')).toBe(
      'CANONICAL'
    )
    expect('http://archive.ubuntu.com/ubuntu/'.replace(rewrite, 'CANONICAL')).toBe(
      'http://archive.ubuntu.com/ubuntu/'
    )
  })

  it('keeps OS package installation and private mirror setup out of the unit-test workflow', () => {
    const workflow = readRepo('.github/workflows/ci.yml')
    expect(workflow).not.toContain('--with-deps')
    expect(workflow).not.toContain(SCRIPT_REL)
    expect(workflow).not.toMatch(/apt(?:-get)? (?:install|update)/)
  })
})
