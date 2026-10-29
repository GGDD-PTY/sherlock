import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const REPO_ROOT = resolve(process.cwd(), '../..')
const recordSchema = z.record(z.string(), z.unknown())

function expectManualOnly(source: string): void {
  const workflow = recordSchema.parse(parse(source))
  expect(Object.keys(recordSchema.parse(workflow.on))).toEqual(['workflow_dispatch'])
}

const workflowDirectory = resolve(REPO_ROOT, '.github/workflows')
const workflows = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, source: readFileSync(resolve(workflowDirectory, name), 'utf8') }))

describe('open-source CI event and security coverage contract', () => {
  it('requires a human to start every workflow', () => {
    expect(workflows.length).toBeGreaterThan(0)
    for (const workflow of workflows) {
      expectManualOnly(workflow.source)
    }
  })

  it.each(['push', 'pull_request', 'schedule', 'workflow_run', 'merge_group'])(
    'rejects a workflow when an automatic %s trigger is introduced',
    (event) => {
      const workflow = recordSchema.parse(parse(workflows[0].source))
      const mutant = { ...workflow, on: { workflow_dispatch: null, [event]: null } }
      // Exercise the same assertion as the real workflow, with one forbidden event added.
      expect(() => expectManualOnly(JSON.stringify(mutant))).toThrow()
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
