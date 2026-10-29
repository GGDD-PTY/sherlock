import { Effect } from 'effect'

// Marcar como leída es contabilidad: si el servidor falla, el clic ya cumplió
// y la UI tiene que seguir. Las llamadas se disparaban con `void`, así que un
// rechazo quedaba sin dueño. El programa las corre, registra el fallo y sigue.
export const markNotificationsAsRead = Effect.fn('Notifications.markAsRead')(
  function* (mark: () => Promise<unknown>) {
    return yield* Effect.tryPromise({
      try: mark,
      catch: (cause) => new Error('marking notifications as read failed', { cause }),
    })
  },
  (effect) =>
    effect.pipe(
      Effect.tapError((error) => Effect.logError(error.message, error.cause)),
      Effect.ignore
    )
)
