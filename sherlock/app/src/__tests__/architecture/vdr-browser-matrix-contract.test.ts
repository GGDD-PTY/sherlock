import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Project } from '@playwright/test'
import { describe, expect, it } from 'vitest'

import playwrightConfig from '../../../playwright.config'

const VDR_CROSS_BROWSER_SPECS = [
  '**/intake-temporary-journey.spec.ts',
  '**/intake-deliverables-journey.spec.ts',
  '**/vdr-guest.spec.ts',
]

const ciWorkflow = readFileSync(resolve(process.cwd(), '../../.github/workflows/ci.yml'), 'utf8')
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

const GENERAL_AND_JOURNEY_E2E_SCRIPTS = [
  'test:e2e',
  'test:e2e:headed',
  'test:e2e:journeys',
  'test:e2e:journeys:shard-a',
  'test:e2e:journeys:shard-b',
  'test:e2e:journeys:shard-c',
  'test:e2e:journeys:shard-d',
]

const JOURNEY_E2E_SCRIPTS = GENERAL_AND_JOURNEY_E2E_SCRIPTS.filter((name) =>
  name.startsWith('test:e2e:journeys')
)

function project(name: string) {
  const match = playwrightConfig.projects?.find((candidate) => candidate.name === name)
  expect(match, `Missing Playwright project: ${name}`).toBeDefined()
  return match as Project
}

describe('VDR cross-browser matrix contract', () => {
  it('keeps ordinary E2E commands on Chromium and exposes the focused VDR matrix separately', () => {
    for (const scriptName of GENERAL_AND_JOURNEY_E2E_SCRIPTS) {
      const script = packageJson.scripts[scriptName]
      expect(script, `Missing ${scriptName} script`).toBeDefined()

      const playwrightInvocations = script
        .split('&&')
        .filter((segment) => segment.includes('playwright test'))
      expect(
        playwrightInvocations.length,
        `Missing Playwright invocation in ${scriptName}`
      ).toBeGreaterThan(0)

      for (const invocation of playwrightInvocations) {
        expect(invocation, `${scriptName} must select Chromium`).toContain('--project=chromium')
        expect(invocation).not.toContain('--project=firefox')
        expect(invocation).not.toContain('--project=webkit')
      }
    }

    for (const scriptName of JOURNEY_E2E_SCRIPTS) {
      expect(packageJson.scripts[scriptName], `${scriptName} must forward CLI arguments`).toContain(
        '"$@"'
      )
    }

    const vdrMatrix = packageJson.scripts['test:e2e:vdr:cross-browser']
    expect(vdrMatrix, 'Missing test:e2e:vdr:cross-browser script').toBeDefined()
    expect(vdrMatrix).toContain('e2e/intake-temporary-journey.spec.ts')
    expect(vdrMatrix).toContain('e2e/intake-deliverables-journey.spec.ts')
    expect(vdrMatrix).toContain('e2e/vdr-guest.spec.ts')
    expect(vdrMatrix).toContain('--project=firefox --project=webkit')
    expect(vdrMatrix).not.toContain('--project=chromium')
  })

  it('keeps Chromium general while scoping Firefox and WebKit to the VDR contracts', () => {
    expect(project('chromium').testMatch).toBeUndefined()
    expect(project('firefox').testMatch).toEqual(VDR_CROSS_BROWSER_SPECS)
    expect(project('webkit').testMatch).toEqual(VDR_CROSS_BROWSER_SPECS)
  })

  it('requires explicit invocation of the cross-browser suite outside CI', () => {
    expect(ciWorkflow).toContain('workflow_dispatch:')
    expect(ciWorkflow).not.toContain('test:e2e')
    expect(ciWorkflow).not.toContain('playwright')
    expect(ciWorkflow).not.toContain('vdr-cross-browser')
    expect(packageJson.scripts['test:e2e:vdr:cross-browser']).toContain(
      'bash scripts/with-project-node.sh'
    )
    expect(packageJson.scripts['test:e2e:vdr:cross-browser']).toContain('"$@"')
  })
})
