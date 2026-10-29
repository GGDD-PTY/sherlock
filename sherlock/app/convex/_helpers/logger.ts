import { Logger } from 'effect'

/**
 * `Logger.withLeveledConsole` (Logger.ts:420–441) rutea por nivel, pero llama
 * `console.warn(output)` con un solo argumento. Los avisos de Sherlock van
 * `console.warn(msg, extra)` y los tests lo pinean. `CurrentLoggers` es un
 * `Context.Reference` sin setter de proceso: este logger se da con
 * `Effect.provide` en `runConvex`. Reemplaza el set por defecto (defaultLogger
 * + tracerLogger); a dónde salen las trazas lo decide Maintainer.
 */
function consoleArgs(message: unknown): ReadonlyArray<unknown> {
  return Array.isArray(message) ? message : [message]
}

const sherlockLogger = Logger.make<unknown, void>((options) => {
  const args = consoleArgs(options.message)
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
