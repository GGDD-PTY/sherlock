import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, it } from 'vitest'

it('starts an empty local backend and loopback app without invoking a seed or inheriting provider credentials', () => {
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'sherlock-startup-')))
  const scripts = join(app, 'scripts')
  const bins = join(app, 'node_modules', '.bin')
  const config = join(app, '.convex-local', '.convex', 'local', 'default')
  const log = join(app, 'calls.jsonl')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(bins, { recursive: true })
  mkdirSync(config, { recursive: true })
  copyFileSync(resolve('scripts/convex-local.mjs'), join(scripts, 'convex-local.mjs'))
  writeFileSync(join(config, 'config.json'), JSON.stringify({ adminKey: 'local-only-admin-key' }))
  writeFileSync(join(scripts, 'build-viewer-assets.mjs'), '')

  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.STARTUP_TEST_LOG, JSON.stringify({
  executable: process.argv[1], args: process.argv.slice(2),
  provider: { workos: process.env.WORKOS_API_KEY, resend: process.env.RESEND_API_KEY,
    posthog: process.env.NEXT_PUBLIC_POSTHOG_KEY, upstash: process.env.UPSTASH_REDIS_REST_TOKEN },
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
}) + '\\n');
`
  writeFileSync(join(bins, 'convex'), stub, { mode: 0o755 })
  writeFileSync(join(bins, 'bash'), stub, { mode: 0o755 })
  const env = {
    ...process.env,
    PATH: `${bins}:${process.env.PATH}`,
    STARTUP_TEST_LOG: log,
    WORKOS_API_KEY: 'inherited-secret',
    RESEND_API_KEY: 'inherited-secret',
    NEXT_PUBLIC_POSTHOG_KEY: 'inherited-secret',
    UPSTASH_REDIS_REST_TOKEN: 'inherited-secret',
    CONVEX_LOCAL_CLOUD_PORT: '43210',
    PORT: '43100',
  }

  try {
    for (const command of ['backend', 'dev', 'after-push']) {
      const result = spawnSync(process.execPath, [join(scripts, 'convex-local.mjs'), command], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      })
      expect(result.status, result.stderr).toBe(0)
    }
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as Array<{
      executable: string
      args: string[]
      provider: Record<string, string>
      convexUrl?: string
    }>
    expect(calls.some((call) => call.args[0] === 'dev')).toBe(true)
    expect(calls.some((call) => call.args.includes('--run'))).toBe(false)
    expect(calls.some((call) => call.args.some((arg) => arg.includes('_localSeed:')))).toBe(false)
    const appCall = calls.find((call) => call.executable.endsWith('/bash'))
    expect(appCall?.args.join(' ')).toContain('next dev --webpack --hostname 127.0.0.1')
    expect(appCall?.convexUrl).toBe('http://127.0.0.1:43210')
    for (const call of calls) {
      expect(call.provider).toEqual({ workos: '', resend: '', posthog: '', upstash: '' })
    }
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})
