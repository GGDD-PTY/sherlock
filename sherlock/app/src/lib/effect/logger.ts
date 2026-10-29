import { Logger, References } from 'effect'

/**
 * `Logger.withLeveledConsole` (Logger.ts:420–441) rutea por nivel, pero llama
 * `console.warn(output)` con un solo argumento. Los avisos de Sherlock van
 * `console.warn(msg, extra)` y los tests lo pinean. `CurrentLoggers` es un
 * `Context.Reference` sin setter de proceso: este logger se monta en el
 * `ManagedRuntime` y se da con `Effect.provide` en las costuras que no pasan
 * por él. Reemplaza el set por defecto (defaultLogger + tracerLogger); a dónde
 * salen las trazas lo decide Maintainer.
 */

function consoleArgs(message: unknown): ReadonlyArray<unknown> {
  return Array.isArray(message) ? message : [message]
}

/**
 * `Effect.annotateLogs` no viaja en `options.message`: vive en el fiber, bajo
 * `References.CurrentLogAnnotations` (`Context.Reference<ReadonlyRecord>`), y
 * se lee con `options.fiber.getRef` — `Logger.Options` de Effect 4 expone el
 * fiber justamente para eso. Sin esto, un `requestId` o un `route` anotados por
 * una ruta no salían en ninguna parte y la anotación era trabajo perdido.
 *
 * Van al final y solo si hay alguna, así una línea sin anotaciones sale con los
 * mismos argumentos de siempre.
 */
function withAnnotations(
  args: ReadonlyArray<unknown>,
  annotations: Readonly<Record<string, unknown>>
): ReadonlyArray<unknown> {
  return Object.keys(annotations).length > 0 ? [...args, annotations] : args
}

const sherlockLogger = Logger.make<unknown, void>((options) => {
  const args = withAnnotations(
    consoleArgs(options.message),
    options.fiber.getRef(References.CurrentLogAnnotations)
  )
  switch (options.logLevel) {
    case 'Debug':
      console.debug(...args)
      return
    case 'Trace':
      console.trace(...args)
      return
    case 'Info':
      // `withLeveledConsole` usa console.info. Los tests de Sherlock pinean
      // `console.log` para Effect.log (nivel Info).
      console.log(...args)
      return
    case 'Warn':
      console.warn(...args)
      return
    case 'Error':
    case 'Fatal':
      console.error(...args)
      return
    case 'All':
    case 'None':
      // Umbrales, no niveles de mensaje: no llegan a un logger con un mensaje real.
      console.log(...args)
  }
})

export const sherlockLoggerLayer = Logger.layer([sherlockLogger])
