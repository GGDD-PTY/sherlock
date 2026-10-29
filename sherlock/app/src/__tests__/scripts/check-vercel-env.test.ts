import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  INTAKE_PRODUCTION_ENV,
  RATE_LIMIT_OPT_OUT,
  REDIS_RATE_LIMIT_PRODUCTION_ENV,
  REQUIRED_PRODUCTION_APP_ENV,
  VDR_MCP_PRODUCTION_ENV,
} from '../../../scripts/production-env-manifest.mjs'

const scriptPath = resolve(process.cwd(), 'scripts/check-vercel-env.mjs')
const requiredKeys = REQUIRED_PRODUCTION_APP_ENV.map(({ key }) => key)
const redisKeys = REDIS_RATE_LIMIT_PRODUCTION_ENV.map(({ key }) => key)
const vdrMcpKeys = VDR_MCP_PRODUCTION_ENV.map(({ key }) => key)
const baselineKeys = [...requiredKeys, ...redisKeys]

function runCheck(keys: string[], args: string[] = [], sensitiveKeys: string[] = []) {
  const tempDir = mkdtempSync(join(tmpdir(), 'sherlock-vercel-env-'))
  const binDir = join(tempDir, 'bin')
  const fakeVercel = join(binDir, 'vercel')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(
    fakeVercel,
    [
      '#!/usr/bin/env node',
      'process.stdout.write(process.env.TEST_VERCEL_ENV_JSON ?? \'{"envs":[]}\')',
    ].join('\n')
  )
  chmodSync(fakeVercel, 0o755)
  const result = spawnSync(process.execPath, [scriptPath, '--environment=production', ...args], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TEST_VERCEL_ENV_JSON: JSON.stringify({
        envs: keys.map((key) => ({
          key,
          target: ['production'],
          type: sensitiveKeys.includes(key) ? 'sensitive' : 'plain',
        })),
      }),
    },
  })
  rmSync(tempDir, { recursive: true, force: true })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('check-vercel-env', () => {
  it('passes when every required production key is present', () => {
    const result = runCheck(baselineKeys)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Vercel production env metadata passed')
    expect(result.stdout).not.toContain('write-only values unverified')
  })

  it('reports sensitive metadata as write-only and unverified without failing presence checks', () => {
    const sensitiveKeys = ['WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD']
    const result = runCheck(baselineKeys, [], sensitiveKeys)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Vercel production env metadata passed')
    expect(result.stdout).toContain('UNKNOWN: 2 write-only values — verify in Vercel')
    expect(result.stdout).not.toContain('values verified')
  })

  it('fails when a required production key is missing', () => {
    const result = runCheck(baselineKeys.filter((key) => key !== 'WORKOS_API_KEY'))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WORKOS_API_KEY')
  })

  it('fails when the Redis rate-limit keys are absent without the opt-out key', () => {
    const result = runCheck(requiredKeys)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_URL')
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_TOKEN')
  })

  it('accepts the explicit rate-limit opt-out key instead of the Redis keys', () => {
    expect(runCheck([...requiredKeys, RATE_LIMIT_OPT_OUT.key]).status).toBe(0)
  })

  it('does not require the VDR MCP authority while the release gate is off', () => {
    expect(runCheck(baselineKeys).status).toBe(0)
  })

  it('requires the full VDR MCP authority for an enabled release', () => {
    const result = runCheck(
      [...baselineKeys, ...vdrMcpKeys.filter((key) => key !== 'VDR_MCP_SERVER_SECRET')],
      ['--vdr-mcp-enabled']
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_SERVER_SECRET')
  })

  it('requires the intake authority for an enabled intake', () => {
    const result = runCheck(baselineKeys, ['--intake-enabled'])

    expect(result.status).toBe(1)
    for (const key of INTAKE_PRODUCTION_ENV.map(({ key }) => key)) {
      expect(result.stderr).toContain(key)
    }
  })

  it.each(['BYPASS_AUTH', 'NEXT_PUBLIC_BYPASS_AUTH', 'NEXT_PUBLIC_DEV_AUTH_ENABLED'])(
    'fails when forbidden production key %s exists',
    (forbiddenKey) => {
      const result = runCheck([...baselineKeys, forbiddenKey])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(forbiddenKey)
    }
  )
})
