// ============================================================================
// ACTOR DE AUDITORÍA DE LOS CARRILES DE OPERADOR
// ============================================================================
// `operatorDeliverables.ts` corre con la deploy key del
// deployment, no con una sesión: no hay identidad de navegador que autorizar y
// tampoco una a la cual atribuirle la escritura. La fila de `adminAuditLogs` se
// ancla entonces al perfil ADMIN del deployment y, si no existe ninguno, al
// dueño de la empresa. Quién escribió de verdad lo dice el `notes` de cada
// llamador, para que la auditoría no se lea como una persona en la UI.
// ============================================================================

import { Effect } from 'effect'

import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { convexPromise, runConvex } from './effect'
import { notFound } from './errors'

export type OperatorActor = { profileId: Id<'profiles'>; email: string }

type OperatorActorContext = QueryCtx | MutationCtx

type OperatorActorOptions = { fallbackProfileId?: Id<'profiles'>; fallbackEmail: string }

const resolveOperatorActorEffect = Effect.fn('OperatorActor.resolve')(function* (
  ctx: OperatorActorContext,
  options: OperatorActorOptions
) {
  const admin = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', 'ADMIN'))
      .first()
  )

  const fallbackProfileId = options.fallbackProfileId
  let profile = admin
  if (!profile && fallbackProfileId) {
    profile = yield* convexPromise(() => ctx.db.get(fallbackProfileId))
  }

  if (!profile) {
    return yield* Effect.fail(notFound('Perfil ADMIN del deployment'))
  }

  const user = yield* convexPromise(() => ctx.db.get(profile.userId))

  return {
    profileId: profile._id,
    email: user?.email ?? options.fallbackEmail,
  } satisfies OperatorActor
})

// `fallbackProfileId` es una decisión del llamador, no un default. El puente
// devuelve un insumo que el cliente ya tenía, así que atribuirlo al dueño de la
// empresa cuando no hay ADMIN es aceptable. Un entregable del equipo NO: firmarlo
// con el perfil del cliente falsea la procedencia, y por eso `operatorDeliverables`
// no pasa respaldo y prefiere fallar ruidosamente.
export function resolveOperatorActor(
  ctx: OperatorActorContext,
  options: OperatorActorOptions
): Promise<OperatorActor> {
  return runConvex(resolveOperatorActorEffect(ctx, options))
}
