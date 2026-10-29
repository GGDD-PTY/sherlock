// ============================================================================
// SEAM DE PRUEBAS SOBRE `runServerEffect`
// ============================================================================
// Los módulos de la ola de Effect componen su programa y lo corren adentro, con
// `runServerEffect`. Ese borde usa el reloj vivo: probar una cota de tiempo por
// ahí costaría segundos de reloj real.
//
// Este seam reemplaza el borde por una captura: el módulo arma exactamente el
// mismo programa y en vez de correrlo lo deja acá. La prueba lo forkea bajo el
// `TestClock` de `@effect/vitest` y adelanta el reloj a mano — el mismo patrón
// de `src/__tests__/lib/effect/external.test.ts`. El grafo bajo prueba no
// cambia; lo único que cambia es dónde corre.
// ============================================================================

import type { Effect } from 'effect'

type CapturedEffect = Effect.Effect<unknown, unknown>

const captured: CapturedEffect[] = []
const waiting: Array<() => void> = []

function captureServerEffect(effect: CapturedEffect): Promise<never> {
  captured.push(effect)
  for (const notify of waiting.splice(0)) notify()
  // La promesa nunca asienta: quien llamó al módulo queda esperando y la prueba
  // decide el destino del programa.
  return new Promise<never>(() => {})
}

/** El módulo con el que se sustituye `@/lib/effect/runtime`. */
export const capturingRuntimeModule = {
  runServerEffect: captureServerEffect,
  runServerEffectExit: captureServerEffect,
  throwEffectError: (error: unknown): never => {
    if (error instanceof Error) throw error
    throw new Error('Effect failed', { cause: error })
  },
}

/** Descarta lo capturado por el caso anterior. */
export function resetCapturedEffects(): void {
  captured.length = 0
  waiting.length = 0
}

/**
 * Espera a que el módulo llegue al borde. Hace falta cuando la función pública
 * awaitea algo — un import diferido — antes de componer su programa.
 */
export function whenEffectCaptured(): Promise<void> {
  if (captured.length > 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    waiting.push(resolve)
  })
}

/** El programa que el módulo iba a correr, en orden de captura. */
export function takeCapturedEffect<A, E>(): Effect.Effect<A, E> {
  const effect = captured.shift()
  if (!effect) throw new Error('Ningún programa llegó al borde de runServerEffect')
  return effect as Effect.Effect<A, E>
}
