import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type CommandModule = {
  runGateCommand: (
    command: string,
    environment: Record<string, string>,
    repoRoot: string
  ) => Promise<number>
}

let commands: CommandModule
let repoRoot: string

beforeAll(async () => {
  const script = resolve(process.cwd(), '../../scripts/verify-gate-command.mjs')
  commands = await import(pathToFileURL(script).href)
})

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'sherlock-gate-command-'))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('verify:gate multiline commands', () => {
  it('stops on an early failure instead of returning the last successful command', async () => {
    const exitCode = await commands.runGateCommand(
      'false\nprintf unexpected > marker.txt',
      {},
      repoRoot
    )

    expect(exitCode).not.toBe(0)
    await expect(readFile(join(repoRoot, 'marker.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('runs successful commands in order with the step environment', async () => {
    const exitCode = await commands.runGateCommand(
      'printf "%s" "$VERIFY_GATE_FIXTURE_VALUE" > marker.txt\nprintf second >> marker.txt',
      { VERIFY_GATE_FIXTURE_VALUE: 'first' },
      repoRoot
    )

    expect(exitCode).toBe(0)
    await expect(readFile(join(repoRoot, 'marker.txt'), 'utf8')).resolves.toBe('firstsecond')
  })
})
