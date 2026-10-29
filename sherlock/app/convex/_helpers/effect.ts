// ============================================================================
// LA FRONTERA DE EFFECT DENTRO DE CONVEX
// ============================================================================
// Convex entra a la adopción de Effect ([F] 2026-09-08 21:22, DECISIONS): su
// runtime por defecto es «very similar to the Cloudflare Workers runtime» y el
// único fallo documentado —el `setTimeout` que el scheduler armaba cada 2.048
// operaciones, Effect #6651— se cerró en el PR #7178 y entró en `4.0.0-rc.108`.
// El repo está en `4.0.0-rc.112`.
//
// Este archivo es la costura única entre los dos modelos: adentro se programa
// con Effect, afuera el handler de Convex sigue siendo `async`. Nadie más en
// `convex/` debería llamar a `Effect.runPromise*`.
//
// Reglas del aislado que este archivo respeta y que los programas de arriba
// también tienen que respetar en queries y mutations:
//
//   - nada de `Effect.sleep`, `Effect.timeout`, `Effect.retry` con schedule ni
//     ningún otro timer: Convex los prohíbe;
//   - nada de `fetch` ni de `import()` dinámico (las actions sí pueden);
//   - `Date.now()` está congelado durante toda la ejecución y `Math.random()`
//     está sembrado, así que un backoff no avanzaría aunque se pudiera armar.
//
// Los dos canales, y por qué importan:
//
//   - **error tipado (`AppError`)** — lo que el cliente puede y debe ver. Sale
//     por `runConvex` como la excepción original, que ya es un `ConvexError`, y
//     Convex serializa su `data` (`code`, `message`, `details`) al cliente.
//   - **defecto** — un bug nuestro. Sube como excepción y nunca se convierte en
//     error de negocio. Si es un `Error` se relanza tal cual para conservar el
//     stack en los logs de Convex; si no lo es, se registra del lado servidor y
//     el cliente recibe un `INTERNAL_ERROR` genérico, sin internals.
//
// El puente de vuelta —`convexPromise` y `convexSync`— existe porque `ctx.db`,
// `ctx.auth` y los helpers todavía sin convertir hablan Promise y lanzan
// `AppError`. Ese lanzamiento es un fallo *esperado*: entra al canal de error.
// Cualquier otra excepción es un defecto y se muere como defecto.
//
// Cómo se ve un handler convertido:
//
//   const requestSomething = Effect.fn('Deliverables.request')(function* (
//     ctx: MutationCtx,
//     args: { companyId: Id<'companies'> }
//   ) {
//     const { profile } = yield* requireAuthEffect(ctx)
//     const company = yield* convexPromise(() => ctx.db.get(args.companyId))
//     if (!company) return yield* Effect.fail(notFound('company', args.companyId))
//     yield* convexSync(() => requireOwnership(profile, company.ownerId))
//     return yield* convexPromise(() => ctx.db.insert('deliverables', { ... }))
//   })
//
//   ...y el registro de Convex no cambia de forma: el `handler` es una línea
//   que entrega el programa a la frontera.
//
//     handler: (ctx, args) => runConvex(requestSomething(ctx, args))
// ============================================================================

import { Cause, Effect, Exit, Option, Result } from 'effect'

import { sherlockLoggerLayer } from './logger'
import { AppError, ErrorCode } from './errors'

/**
 * Un programa Convex: el canal de error es exactamente lo que el cliente puede
 * ver. Todo lo demás es defecto y no tiene tipo porque no tiene contrato.
 */
export type ConvexEffect<A> = Effect.Effect<A, AppError>

const DEFECT_MESSAGE = 'Ocurrió un error interno. Intenta de nuevo.'

/**
 * La regla de reparto entre los dos canales, en un solo lugar: un `AppError` es
 * una respuesta al cliente, cualquier otra cosa es un bug.
 */
function classify(cause: unknown): Effect.Effect<never, AppError> {
  return cause instanceof AppError ? Effect.fail(cause) : Effect.die(cause)
}

/**
 * Trae una promesa de Convex (o de un helper todavía sin convertir) al programa
 * Effect conservando el reparto de canales.
 */
export function convexPromise<A>(operation: () => PromiseLike<A>): ConvexEffect<A> {
  // El `async` no sobra. `Effect.tryPromise` le llama `.then` a lo que reciba;
  // `await` no. Varias APIs de Convex prometen una promesa por contrato y la
  // devuelven de verdad en producción, pero un doble de prueba que devuelva
  // `undefined` mata al programa con «Cannot read properties of undefined
  // (reading 'then')». Tres conversiones distintas chocaron con esto el
  // 2026-09-08, cada una en una llamada a `ctx.scheduler.runAfter`, y cada una
  // tuvo que envolver su propia llamada. Envolver acá le da a la costura las
  // mismas reglas que `await` y nadie más tiene que acordarse.
  return Effect.tryPromise({
    try: async () => await operation(),
    catch: (cause: unknown) => cause,
  }).pipe(Effect.catch(classify))
}

/**
 * Lo mismo para los guardas síncronos (`requireAdmin`, `requireOwnership`, ...)
 * que hoy expresan el invariante lanzando.
 */
export function convexSync<A>(operation: () => A): ConvexEffect<A> {
  return Effect.try({
    try: operation,
    catch: (cause: unknown) => cause,
  }).pipe(Effect.catch(classify))
}

/**
 * Un defecto nunca sale con forma de error de negocio. Si trae stack, se relanza
 * intacto para que Convex lo registre; si no, se anota del lado servidor y el
 * cliente recibe el genérico.
 */
function defectToThrow(cause: Cause.Cause<AppError>): Error {
  const defect = Cause.findDefect(cause)

  if (Result.isSuccess(defect) && defect.success instanceof Error) {
    return defect.success
  }

  console.error('[convex/effect] defecto sin manejar:', Cause.pretty(cause))
  return new AppError(ErrorCode.INTERNAL_ERROR, DEFECT_MESSAGE)
}

/**
 * La frontera. El handler de Convex entrega aquí su programa y recibe la promesa
 * que Convex espera.
 */
export async function runConvex<A>(program: ConvexEffect<A>): Promise<A> {
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(sherlockLoggerLayer)))

  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const failure = Exit.findErrorOption(exit)

  if (Option.isSome(failure)) {
    throw failure.value
  }

  throw defectToThrow(exit.cause)
}
