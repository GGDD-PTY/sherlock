import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/vercel-build.sh')

function writeCommand(binDir: string, name: string) {
  const path = join(binDir, name)
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' '${name} '"$*" >> "$TEST_COMMAND_LOG"`,
    ].join('\n')
  )
  chmodSync(path, 0o755)
}

function runBuild(env: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), 'sherlock-vercel-build-'))
  const binDir = join(tempDir, 'bin')
  const commandLog = join(tempDir, 'commands.log')
  mkdirSync(join(tempDir, 'public/mog'), { recursive: true })
  mkdirSync(join(tempDir, 'public/pdfjs'), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(tempDir, 'public/mog/index.html'), '')
  writeFileSync(join(tempDir, 'public/pdfjs/pdf.worker.min.mjs'), '')
  writeFileSync(commandLog, '')
  for (const command of ['node', 'bunx', 'next']) writeCommand(binDir, command)

  const result = spawnSync('bash', [scriptPath], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TEST_COMMAND_LOG: commandLog,
    },
  })
  const commands = readFileSync(commandLog, 'utf8')
  rmSync(tempDir, { recursive: true, force: true })
  return { result, commands }
}

describe('Vercel deployment boundary', () => {
  it('deploys Convex for the isolated staging target', () => {
    const { result, commands } = runBuild({
      VERCEL_ENV: 'preview',
      VERCEL_TARGET_ENV: 'staging',
    })
    const commandLines = commands.trim().split('\n')

    expect(result.status).toBe(0)
    expect(commands).toContain(
      'bunx convex deploy --check-build-environment disable --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd node scripts/quarantine-next-ds-store.mjs && next build --webpack'
    )
    expect(commandLines.some((line) => line.startsWith('next '))).toBe(false)
  })

  it('keeps ordinary previews build-only', () => {
    const { result, commands } = runBuild({
      VERCEL_ENV: 'preview',
      VERCEL_TARGET_ENV: 'preview',
    })

    expect(result.status).toBe(0)
    expect(commands).not.toContain('bunx convex deploy')
    expect(commands).toContain('next build --webpack')
  })

  it('continues deploying Convex for Production', () => {
    const { result, commands } = runBuild({
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
    })

    expect(result.status).toBe(0)
    expect(commands).toContain('bunx convex deploy')
    expect(commands).not.toContain('--check-build-environment disable')
  })
})
