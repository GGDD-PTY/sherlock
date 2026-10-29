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
  it('provides one manual verification workflow on a standard GitHub runner', () => {
    const workflowFiles = readdirSync(resolve(REPO_ROOT, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
    const workflow = readWorkflow()
    const jobs = recordSchema.parse(workflow.jobs)

    expect(workflowFiles).toEqual(['ci.yml'])
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(jobs)).toEqual(['verify'])
    expect(verificationJob()['runs-on']).toBe('ubuntu-latest')
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
    const bunSetup = steps.find((step) => step.uses === 'oven-sh/setup-bun@v2')
    const nodeSetup = steps.find((step) => step.uses === 'actions/setup-node@v4')
    const commands = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []))

    expect(steps.filter((step) => step.uses === 'actions/checkout@v4')).toHaveLength(1)
    expect(bunSetup?.with).toEqual({ 'bun-version': bunVersion })
    expect(nodeSetup?.with).toEqual({ 'node-version': nodeVersion })
    expect(commands).toEqual([
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run lint',
      expect.stringMatching(/^bun run test(?: --maxWorkers=\d+)?$/),
    ])
    expect(rootPackage.scripts.test).toBe('bun --cwd=sherlock/app run test:run')
  })

  it('requires no installation credentials and cannot deploy or call a paid runner', () => {
    const source = readRepo('.github/workflows/ci.yml')
    const steps = stepsSchema.parse(verificationJob().steps)

    expect(source).not.toMatch(/secrets\s*\.|vars\s*\.|id-token\s*:\s*write/)
    expect(source).not.toMatch(/blacksmith|buildkite|depot-|self-hosted/i)
    expect(source).not.toMatch(/vercel|convex deploy|wrangler|deploy-hook/i)
    expect(verificationJob()).not.toHaveProperty('environment')
    expect(steps.flatMap((step) => (step.uses ? [step.uses] : []))).toEqual([
      'actions/checkout@v4',
      'actions/setup-node@v4',
      'oven-sh/setup-bun@v2',
    ])
  })
})
