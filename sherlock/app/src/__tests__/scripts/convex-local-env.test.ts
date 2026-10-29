import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, it } from 'vitest'

it('reading local env does not rewrite existing sandbox config', () => {
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'sherlock-env-')))
  const script = join(app, 'scripts', 'convex-local.mjs')
  mkdirSync(join(app, 'scripts'))
  copyFileSync(resolve('scripts/convex-local.mjs'), script)
  symlinkSync(resolve('../../node_modules'), join(app, 'node_modules'), 'dir')
  const readEnv = () =>
    spawnSync(process.execPath, [script, 'env'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKOS_API_KEY: 'inherited-provider-secret',
        WORKOS_COOKIE_PASSWORD: 'inherited-provider-secret',
        NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'https://private-installation.example/callback',
        RESEND_API_KEY: 'inherited-provider-secret',
        NEXT_PUBLIC_POSTHOG_KEY: 'inherited-provider-secret',
        UPSTASH_REDIS_REST_TOKEN: 'inherited-provider-secret',
        WORKOS_UNKNOWN_FUTURE_KEY: 'inherited-provider-secret',
      },
    })

  try {
    const first = readEnv()
    expect(first.status).toBe(0)
    expect(first.stdout.includes('NEXT_PUBLIC_CONVEX_URL=')).toBe(true)
    expect(first.stdout).not.toContain('inherited-provider-secret')
    expect(first.stdout).not.toContain('private-installation.example')
    for (const key of [
      'WORKOS_API_KEY',
      'RESEND_API_KEY',
      'NEXT_PUBLIC_POSTHOG_KEY',
      'UPSTASH_REDIS_REST_TOKEN',
      'WORKOS_UNKNOWN_FUTURE_KEY',
    ]) {
      expect(first.stdout).toContain(`${key}=\n`)
    }
    expect(first.stdout).toContain('NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3100/callback')
    expect(first.stdout).toMatch(/WORKOS_COOKIE_PASSWORD=[a-f0-9]{64}/)

    const files = ['.gitignore', 'convex.json', 'package.json'].map((name) =>
      join(app, '.convex-local', name)
    )
    const unchangedTime = new Date('2000-01-01T00:00:00Z')
    for (const file of files) utimesSync(file, unchangedTime, unchangedTime)

    const second = readEnv()
    expect(second.status).toBe(0)
    expect(createHash('sha256').update(second.stdout).digest('hex')).toBe(
      createHash('sha256').update(first.stdout).digest('hex')
    )
    expect(files.map((file) => statSync(file).mtimeMs)).toEqual(
      files.map(() => unchangedTime.getTime())
    )
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})
