import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const REPO_ROOT = resolve(process.cwd(), '../..')
const recordSchema = z.record(z.string(), z.unknown())

function expectApprovedEvents(source: string): void {
  const workflow = recordSchema.parse(parse(source))
  const events = recordSchema.parse(workflow.on)
  expect(Object.keys(events).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
  expect(events.push).toEqual({ branches: ['main'] })
  expect(events.pull_request).toEqual({ branches: ['main'] })
}

const workflowDirectory = resolve(REPO_ROOT, '.github/workflows')
const workflows = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, source: readFileSync(resolve(workflowDirectory, name), 'utf8') }))

describe('open-source CI event and security coverage contract', () => {
  it('checks pull requests and main pushes while retaining manual dispatch', () => {
    expect(workflows.length).toBeGreaterThan(0)
    for (const workflow of workflows) {
      expectApprovedEvents(workflow.source)
    }
  })

  it.each(['pull_request_target', 'schedule', 'workflow_run', 'merge_group'])(
    'rejects the unapproved %s trigger',
    (event) => {
      const workflow = recordSchema.parse(parse(workflows[0].source))
      const mutant = { ...workflow, on: { ...recordSchema.parse(workflow.on), [event]: null } }
      // Exercise the same assertion as the real workflow, with one forbidden event added.
      expect(() => expectApprovedEvents(JSON.stringify(mutant))).toThrow()
    }
  )

  it('retains route, company isolation, guest access and MCP security regression suites', () => {
    const securityContracts = [
      'src/__tests__/api/documents-access.test.ts',
      'src/__tests__/api/vdr-guest-access.test.ts',
      'src/__tests__/lib/api/with-auth.test.ts',
      'src/__tests__/convex/auth-dev-bypass.test.ts',
      'src/__tests__/convex/security.test.ts',
      'src/__tests__/convex/vdr-security-regressions.test.ts',
      'src/__tests__/vdr-mcp/route.test.ts',
      'src/__tests__/vdr-mcp/oauth-isolation.test.ts',
      'src/__tests__/vdr-mcp/boundary.test.ts',
      'src/__tests__/vdr-mcp/convex-binding.test.ts',
    ]

    for (const contract of securityContracts) {
      expect(
        existsSync(resolve(process.cwd(), contract)),
        `Missing security suite: ${contract}`
      ).toBe(true)
    }

    const appPackage = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')))
    expect(appPackage.scripts['test:run']).toBe('vitest run')
    const vitestConfig = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')
    expect(vitestConfig).toContain("include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}']")
    expect(vitestConfig).toContain("exclude: ['node_modules', '.next']")
  })
})
