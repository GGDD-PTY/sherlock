import { describe, expect, it, vi } from 'vitest'
import { Effect, Exit } from 'effect'

import {
  runClientEffect,
  runClientEffectExit,
  runClientFork,
  runClientSync,
  runClientSyncExit,
} from '@/lib/effect/client-runtime'

class Boom extends Error {
  readonly _tag = 'Boom'
}

describe('runtime de cliente', () => {
  it('los cinco helpers loguean por el logger de Sherlock, no por el default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const extra = { code: 'X' }

    runClientSync(Effect.logWarning('sync', extra))
    runClientSyncExit(Effect.logWarning('syncExit', extra))
    await runClientEffect(Effect.logWarning('promise', extra))
    await runClientEffectExit(Effect.logWarning('promiseExit', extra))
    await new Promise<unknown>((resolve) => {
      runClientFork(Effect.logWarning('fork', extra)).addObserver(resolve)
    })

    // El defaultLogger de Effect aplana el mensaje a una sola string con
    // timestamp; el de Sherlock reparte por nivel y abre el array en console.
    expect(warn.mock.calls).toEqual([
      ['sync', extra],
      ['syncExit', extra],
      ['promise', extra],
      ['promiseExit', extra],
      ['fork', extra],
    ])
    warn.mockRestore()
  })

  it('los helpers de Exit devuelven el fallo en vez de tirarlo', async () => {
    const sync = runClientSyncExit(Effect.fail(new Boom('sync')))
    const promise = await runClientEffectExit(Effect.fail(new Boom('promise')))

    expect(Exit.isSuccess(sync)).toBe(false)
    expect(Exit.isSuccess(promise)).toBe(false)
    expect(runClientSyncExit(Effect.succeed(2))).toStrictEqual(Exit.succeed(2))
    await expect(runClientEffectExit(Effect.succeed(3))).resolves.toStrictEqual(Exit.succeed(3))
  })
})
