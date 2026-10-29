import { Effect } from 'effect'

// Cerrar sesión no debe bloquear la UI: si el proveedor falla (red caída,
// sesión ya vencida) el fallo se registra y el caller sigue, para que la
// página reconcilie contra el servidor en vez de quedarse en una sesión zombi.
//
// tapError/ignore no van como extra args crudos de Effect.fn: el generador
// recibe `signOut` y esos combinators duales colisionan con el arg. El
// combinator extra es un lambda que solo toma el effect.
export const runSignOut = Effect.fn('Layout.signOut')(
  function* (signOut: () => void | Promise<void>) {
    return yield* Effect.tryPromise({
      try: () => Promise.resolve(signOut()),
      catch: (error) => new Error('sign out failed', { cause: error }),
    })
  },
  (effect) =>
    effect.pipe(
      Effect.tapError((error) => Effect.logError(error.message, error.cause)),
      Effect.ignore
    )
)
