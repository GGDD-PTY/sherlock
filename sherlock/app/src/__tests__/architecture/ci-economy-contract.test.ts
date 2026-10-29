import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const REPO_ROOT = resolve(process.cwd(), '../..')
const recordSchema = z.record(z.string(), z.unknown())
const stepsSchema = z.array(recordSchema)

function readRepo(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')
}

function readWorkflow(): Record<string, unknown> {
  return recordSchema.parse(parse(readRepo('.github/workflows/ci.yml')))
}

function verificationJob(): Record<string, unknown> {
  return recordSchema.parse(recordSchema.parse(readWorkflow().jobs).verify)
}

describe('open-source CI contract', () => {
  it('defaults to free public runners and selects Blacksmith only by explicit dispatch', () => {
    const workflowFiles = readdirSync(resolve(REPO_ROOT, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
    const workflow = readWorkflow()
    const jobs = recordSchema.parse(workflow.jobs)

    expect(workflowFiles).toEqual(['ci.yml', 'codeql.yml'])
    const trigger = recordSchema.parse(recordSchema.parse(workflow.on).workflow_dispatch)
    const provider = recordSchema.parse(recordSchema.parse(trigger.inputs).provider)
    expect(provider.type).toBe('choice')
    expect(provider.default).toBe('github')
    expect(provider.options).toEqual(['github', 'blacksmith'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(jobs)).toEqual(['verify'])
    expect(verificationJob()['runs-on']).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.provider == 'blacksmith' && 'blacksmith-4vcpu-ubuntu-2404' || 'ubuntu-24.04' }}"
    )
    expect(verificationJob()['timeout-minutes']).toBe(30)
  })

  it('installs the declared tool versions and runs type, lint and test checks', () => {
    const steps = stepsSchema.parse(verificationJob().steps)
    const rootPackage = z
      .object({
        packageManager: z.string(),
        engines: z.object({ node: z.string() }),
        scripts: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readRepo('package.json')))
    const bunVersion = rootPackage.packageManager.replace(/^bun@/, '')
    const nodeVersion = /^>=(\d+\.\d+\.\d+)\s/.exec(rootPackage.engines.node)?.[1]
    expect(nodeVersion).toBeDefined()
    const bunSetup = steps.find((step) => String(step.uses).startsWith('oven-sh/setup-bun@'))
    const nodeSetup = steps.find((step) => String(step.uses).startsWith('actions/setup-node@'))
    const commands = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []))

    const checkout = steps.find((step) => String(step.uses).startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
    expect(bunSetup?.with).toEqual({ 'bun-version': bunVersion })
    expect(nodeSetup?.with).toEqual({ 'node-version': nodeVersion, 'package-manager-cache': false })
    expect(commands).toEqual([
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run lint',
      expect.stringMatching(/^bun run test(?: --maxWorkers=\d+)?$/),
    ])
    expect(rootPackage.scripts.test).toBe('bun --cwd=sherlock/app run test:run')
  })

  it('requires no installation credentials, pins actions, and cannot deploy', () => {
    const source = readRepo('.github/workflows/ci.yml')
    const steps = stepsSchema.parse(verificationJob().steps)

    expect(source).not.toMatch(/secrets\s*\.|vars\s*\.|id-token\s*:\s*write/)
    expect(source).not.toMatch(/buildkite|depot-|self-hosted/i)
    expect(source).not.toMatch(/vercel|convex deploy|wrangler|deploy-hook/i)
    expect(verificationJob()).not.toHaveProperty('environment')
    const actions = steps.flatMap((step) => (step.uses ? [String(step.uses)] : []))
    expect(actions.map((action) => action.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'oven-sh/setup-bun',
      'actions/cache',
    ])
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/)
    const cache = recordSchema.parse(
      steps.find((step) => String(step.uses).startsWith('actions/cache@'))?.with
    )
    expect(cache.path).toBe('~/.bun/install/cache')
    expect(String(cache.key)).toContain("hashFiles('bun.lock', 'patches/**')")
  })

  it('keeps CodeQL manual, isolated from credentials, and on standard runners', () => {
    const workflow = recordSchema.parse(parse(readRepo('.github/workflows/codeql.yml')))
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    const job = recordSchema.parse(recordSchema.parse(workflow.jobs).analyze)
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job.permissions).toEqual({ contents: 'read', 'security-events': 'write' })
    const steps = stepsSchema.parse(job.steps)
    for (const step of steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
    expect(readRepo('.github/workflows/codeql.yml')).not.toMatch(
      /secrets\s*\.|id-token\s*:\s*write|deploy/i
    )
  })

  it('groups dependency proposals and preserves patched dependencies', () => {
    const config = recordSchema.parse(parse(readRepo('.github/dependabot.yml')))
    const updates = z.array(recordSchema).parse(config.updates)
    expect(updates.map((update) => update['package-ecosystem']).sort()).toEqual([
      'bun',
      'github-actions',
    ])
    for (const update of updates) {
      expect(update['open-pull-requests-limit']).toBe(1)
      expect(update.schedule).toEqual({ interval: 'weekly' })
      expect(Object.keys(recordSchema.parse(update.groups))).toHaveLength(1)
    }
    const bun = updates.find((update) => update['package-ecosystem'] === 'bun')
    expect(bun?.directory).toBe('/')
    expect(bun?.ignore).toEqual(
      expect.arrayContaining([{ 'dependency-name': '@mog-sdk/*' }, { 'dependency-name': 'convex' }])
    )
  })
})
