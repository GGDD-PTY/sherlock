// ============================================================================
// LA COSTURA DE LAS ACCIONES DE ADMIN
// ============================================================================
// Cada pantalla del panel hace lo mismo: llama una mutation de Convex y pinta
// el resultado. Lo que había en cada una era `try { await mutation() } catch
// { toast.error('no se pudo') }`: el error se descartaba y el equipo veía la
// misma frase para «otro admin ya la cerró», «no tienes permiso» y «se cayó la
// red». Peor, tres handlers de `AdminVdrRequestsClient` no tenían `catch` en
// absoluto y fallaban en silencio.
//
// Acá el fallo tiene nombre. `AdminActionError` dice QUÉ acción y QUÉ paso
// falló, y conserva el mensaje de negocio que el backend ya redactó. El
// programa se arma con `Effect.fn('Pantalla.accion')` en cada componente y se
// corre en el borde (dentro del handler), nunca en el cuerpo del módulo.
//
// `adminStep` envuelve el `try` en una función `async`: un doble de prueba que
// devuelve `undefined` en vez de una promesa sobrevive igual que con `await`,
// que es lo que estos handlers hacían antes.
// ============================================================================

import { ConvexError } from 'convex/values'
import { Effect, Schema } from 'effect'

/** Un paso con nombre de una acción de admin falló. */
export class AdminActionError extends Schema.TaggedError<AdminActionError>()('AdminActionError', {
  /** La acción completa, tal como se nombra su span: `AdminGdpr.processDeletion`. */
  action: Schema.String,
  /** El paso que falló dentro de esa acción: `gdpr.processAccountDeletion`. */
  step: Schema.String,
  /** Mensaje ya apto para leerse; de negocio si el backend lo mandó. */
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * Mensaje de negocio de un error de mutation Convex. Los `AppError` del backend
 * viajan como `ConvexError` con `data.message` ya redactado para leerse — en el
 * panel, típicamente el INVALID_REQUEST_TRANSITION de cuando otro admin ganó la
 * carrera, o el BUSINESS_INVALID_STATE de un documento que no puede salir por un
 * segundo slot. Sin esto el equipo veía «no se pudo» y repetía el mismo clic.
 */
function convexErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ConvexError) {
    const message = (cause.data as { message?: unknown } | undefined)?.message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

/**
 * Un paso de una acción de admin. `fallback` es lo que se dice cuando el
 * backend no mandó un mensaje de negocio.
 */
export function adminStep<A>(
  action: string,
  step: string,
  fallback: string,
  run: () => PromiseLike<A> | A
): Effect.Effect<A, AdminActionError> {
  return Effect.tryPromise({
    try: async () => await run(),
    catch: (cause) =>
      new AdminActionError({
        action,
        step,
        message: convexErrorMessage(cause, fallback),
        cause,
      }),
  })
}
