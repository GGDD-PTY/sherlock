// ============================================================================
// EL SCOPE Y LAS COTAS DEL SOBRE DE HANDOFF — camino de fallo
// ============================================================================
// El handle de IndexedDB vive en un `Effect.acquireUseRelease`: `db.close()`
// corre con el `Exit` en la mano, así que también cuando venció la cota o
// cuando interrumpieron la fibra. Un handle abierto bloquea el
// `onupgradeneeded` de la pestaña siguiente, y eso es lo que un `finally` no
// cubría.
//
// El programa vive en `@/lib/mycroft/upload-handoff-idb`; se ejerce por la
// fachada `@/lib/mycroft/upload-handoff`, que es la que consume la UI.
//
// La base va sustituida por un doble que no dispara nada por su cuenta: cada
// callback lo dispara la prueba. Así lo único que se mueve es el reloj de
// Effect, que acá es virtual.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, beforeEach, vi } from 'vitest'

vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { discardHandoff } from '@/lib/mycroft/upload-handoff'
import {
  resetCapturedEffects,
  takeCapturedEffect,
  whenEffectCaptured,
} from '../utils/effect-runtime-seam'

type EventHandler = (() => void) | null

/** Una transacción que nunca asienta: ni `oncomplete`, ni `onerror`, ni `onabort`. */
function pendingTransaction() {
  const store = { clear: vi.fn(), delete: vi.fn() }
  return {
    error: null,
    oncomplete: null as EventHandler,
    onerror: null as EventHandler,
    onabort: null as EventHandler,
    objectStore: () => store,
  }
}

/** La base doble: cuenta sus cierres y entrega transacciones que no asientan. */
function fakeDatabase() {
  return {
    closes: 0,
    close(): void {
      this.closes += 1
    },
    objectStoreNames: { contains: () => true },
    transaction: () => pendingTransaction(),
  }
}

/**
 * `openDb` asigna `onupgradeneeded`, `onsuccess`, `onerror` y `onblocked` en
 * ese orden. Con una base, la apertura se entrega en cuanto `onsuccess` queda
 * asignado; sin ella queda colgada y sólo la corta la cota de 10 s.
 */
function fakeFactory(database: ReturnType<typeof fakeDatabase> | null) {
  const factory = {
    opens: 0,
    open(): unknown {
      factory.opens += 1
      let onsuccess: EventHandler = null
      const request: Record<string, unknown> = { result: database, error: null }
      Object.defineProperty(request, 'onsuccess', {
        get: () => onsuccess,
        set(handler: EventHandler) {
          onsuccess = handler
          if (database) handler?.()
        },
      })
      return request
    },
  }
  return factory
}

describe('sobre de handoff — cota de apertura y cierre por Exit', () => {
  beforeEach(() => {
    resetCapturedEffects()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect('a los 10 s abandona una apertura bloqueada por otra pestaña', () =>
    Effect.gen(function* () {
      const factory = fakeFactory(null)
      vi.stubGlobal('indexedDB', factory)

      void discardHandoff()
      // El programa vive en `upload-handoff-idb.ts` y la fachada lo carga con
      // `import()`: se compone un microtask después de la llamada.
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(takeCapturedEffect<boolean, never>())

      yield* TestClock.adjust('10 seconds')
      const cleared = yield* Fiber.join(fiber)

      // Todo fallo del sobre es advisory: `false`, nunca una excepción.
      assert.strictEqual(cleared, false)
      // Sin reintentos: una sola apertura, no dos.
      assert.strictEqual(factory.opens, 1)
    })
  )

  it.effect('cierra el handle cuando interrumpen la fibra con la transacción en vuelo', () =>
    Effect.gen(function* () {
      const database = fakeDatabase()
      vi.stubGlobal('indexedDB', fakeFactory(database))

      void discardHandoff()
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(takeCapturedEffect<boolean, never>())
      yield* Effect.yieldNow

      yield* Fiber.interrupt(fiber)

      // El `release` corrió con el Exit interrumpido en la mano: sin esto, la
      // pestaña siguiente no puede correr su `onupgradeneeded`.
      assert.strictEqual(database.closes, 1)
    })
  )

  it.effect('cierra el handle cuando la transacción vence su cota de 30 s', () =>
    Effect.gen(function* () {
      const database = fakeDatabase()
      vi.stubGlobal('indexedDB', fakeFactory(database))

      void discardHandoff()
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(takeCapturedEffect<boolean, never>())
      yield* Effect.yieldNow

      yield* TestClock.adjust('30 seconds')
      const cleared = yield* Fiber.join(fiber)

      assert.strictEqual(cleared, false)
      assert.strictEqual(database.closes, 1)
    })
  )
})
