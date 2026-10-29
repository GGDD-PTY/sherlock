// ============================================================================
// `ensureLocalResendKey`: no reescribe el sandbox si la llave ya está
// ============================================================================
// Cada `convex env set` empaqueta de nuevo y J4 se quedaba con un chunk
// truncado. El runner lee el valor actual y solo llama `env set` si cambia.
// ============================================================================

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), '../../scripts/journeys-local.mjs')

type EnvRun = (
  bin: string,
  args: string[],
  options: { encoding?: string; stdio?: string }
) => { status: number | null; stdout?: string }

type RunnerModule = {
  LOCAL_RESEND_KEY: string
  ensureLocalResendKey: (run?: EnvRun) => void
}

async function load(): Promise<RunnerModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as RunnerModule
}

describe('journeys-local.mjs — llave de Resend', () => {
  it('no llama env set cuando la llave del banco ya está puesta', async () => {
    const { ensureLocalResendKey, LOCAL_RESEND_KEY } = await load()
    const calls: string[][] = []
    const run: EnvRun = (_bin, args) => {
      calls.push(args)
      return { status: 0, stdout: `${LOCAL_RESEND_KEY}\n` }
    }

    ensureLocalResendKey(run)

    expect(calls).toEqual([['env', 'get', 'RESEND_API_KEY']])
  })

  it('llama env set cuando el valor actual es otro', async () => {
    const { ensureLocalResendKey, LOCAL_RESEND_KEY } = await load()
    const calls: string[][] = []
    const replies = ['re_otra\n', '']
    const run: EnvRun = (_bin, args) => {
      calls.push(args)
      return { status: 0, stdout: replies[calls.length - 1] }
    }

    ensureLocalResendKey(run)

    expect(calls).toEqual([
      ['env', 'get', 'RESEND_API_KEY'],
      ['env', 'set', 'RESEND_API_KEY', LOCAL_RESEND_KEY],
    ])
  })
})
