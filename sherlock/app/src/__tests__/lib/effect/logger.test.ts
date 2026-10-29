import { describe, expect, it, vi } from 'vitest'
import { Effect, Logger } from 'effect'

import { sherlockLoggerLayer } from '@/lib/effect/logger'
import { runServerEffectSync } from '@/lib/effect/runtime'

// Fuera del test para que `vitest/no-conditional-in-test` no cuente el ternario.
const messageShape = <L,>(entry: { level: L; message: unknown }) =>
  [
    entry.level,
    Array.isArray(entry.message),
    Array.isArray(entry.message) ? entry.message.length : -1,
  ] as const

describe('sherlock logger', () => {
  it('recibe los argumentos de Effect.log* como un array', () => {
    const seen: Array<{ level: string; message: unknown }> = []
    const probe = Logger.make<unknown, void>((options) => {
      seen.push({ level: options.logLevel, message: options.message })
    })

    Effect.runSync(
      Effect.gen(function* () {
        yield* Effect.logWarning('uno')
        yield* Effect.logWarning('uno', 'dos')
        yield* Effect.logError('err', new Error('boom'))
      }).pipe(Effect.provide(Logger.layer([probe])))
    )

    expect(
      seen.map(messageShape)
    ).toEqual([
      ['Warn', true, 1],
      ['Warn', true, 2],
      ['Error', true, 2],
    ])
    expect((seen[1]!.message as unknown[])[1]).toBe('dos')
  })

  it('reparte por nivel y abre el array en console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const extra = { code: 'X' }

    Effect.runSync(
      Effect.gen(function* () {
        yield* Effect.logWarning('aviso', extra)
        yield* Effect.logError('fallo', extra)
        yield* Effect.logInfo('info', extra)
      }).pipe(Effect.provide(sherlockLoggerLayer))
    )

    expect(warn).toHaveBeenCalledWith('aviso', extra)
    expect(error).toHaveBeenCalledWith('fallo', extra)
    expect(log).toHaveBeenCalledWith('info', extra)

    warn.mockRestore()
    error.mockRestore()
    log.mockRestore()
  })

  // `Effect.annotateLogs` no viaja en el mensaje: vive en el fiber. El logger
  // lo saca de ahí, porque si no una ruta que anota `requestId` y `route` no
  // los ve en ninguna línea.
  it('agrega las anotaciones del fiber al final, y solo si hay', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detail = { operation: 'convex.listar' }

    Effect.runSync(
      Effect.gen(function* () {
        yield* Effect.logError('sin anotaciones', detail)
        yield* Effect.logError('con anotaciones', detail).pipe(
          Effect.annotateLogs({ requestId: 'req-1', route: 'GET /api/prueba' })
        )
      }).pipe(Effect.provide(sherlockLoggerLayer))
    )

    expect(error.mock.calls).toEqual([
      ['sin anotaciones', detail],
      ['con anotaciones', detail, { requestId: 'req-1', route: 'GET /api/prueba' }],
    ])

    error.mockRestore()
  })

  it('el runtime de Sherlock usa ese logger', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runServerEffectSync(
      Effect.logWarning('[ENV] preview environment - env validation warnings:', 'CONVEX_DEPLOYMENT')
    )

    expect(warn).toHaveBeenCalledWith(
      '[ENV] preview environment - env validation warnings:',
      'CONVEX_DEPLOYMENT'
    )
    warn.mockRestore()
  })
})
