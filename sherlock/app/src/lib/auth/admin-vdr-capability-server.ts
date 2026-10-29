import { makeFunctionReference } from 'convex/server'
import { Duration, Effect, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import type { AdminVdrAction } from '@/../convex/_adminVdr/capabilityFormat'
import type { ApiUser } from '@/lib/api/with-auth'
import { decodeBoundary, externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { createAdminVdrCapabilityProof } from './admin-vdr-capability-proof'

type IssueArgs = ReturnType<typeof createAdminVdrCapabilityProof>['issuance'] & {
  companyId: Id<'companies'>
}

const issueCapabilityMutation = makeFunctionReference<'mutation', IssueArgs, { expiresAt: number }>(
  'adminVdrCapabilities:issue'
)

/**
 * No hay autoridad para emitir la capability: o la sesión de admin no está,
 * o Convex no aceptó la identidad de servidor. El mensaje es el código estable
 * que la ruta convierte en 403 — nunca viaja tal cual al cliente.
 */
class AdminVdrCapabilityAuthorityError extends Schema.TaggedError<AdminVdrCapabilityAuthorityError>()(
  'AdminVdrCapabilityAuthorityError',
  {
    message: Schema.String,
  }
) {}

const issuedCapabilitySchema = Schema.Struct({ expiresAt: Schema.Number })

const issueAdminVdrCapabilityEffect = Effect.fn('AdminVdrCapability.issue')(function* (args: {
  user: ApiUser
  companyId: Id<'companies'>
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
}) {
  if (!args.user.sessionId || args.user.role !== 'ADMIN') {
    return yield* new AdminVdrCapabilityAuthorityError({
      message: 'ADMIN_VDR_CAPABILITY_SESSION_UNAVAILABLE',
    })
  }
  const prepared = createAdminVdrCapabilityProof({
    subject: args.user.id,
    sessionId: args.user.sessionId,
    companyId: args.companyId,
    action: args.action,
    target: args.target,
    input: args.input,
  })
  const convex = yield* Effect.promise(() => getAuthenticatedConvex())
  if (!convex?.client || !convex.isAuthenticated) {
    return yield* new AdminVdrCapabilityAuthorityError({
      message: 'ADMIN_VDR_CAPABILITY_CONVEX_UNAVAILABLE',
    })
  }
  // Sin reintento: la emisión es una mutación: repetirla mintaría dos
  // capabilities para la misma acción.
  const issued = yield* externalCall({
    service: 'Convex',
    operation: 'adminVdrCapabilities.issue',
    retries: 0,
    timeout: Duration.seconds(8),
    run: () =>
      convex.client.mutation(issueCapabilityMutation, {
        ...prepared.issuance,
        companyId: args.companyId,
      }),
  })
  const { expiresAt } = yield* decodeBoundary(
    'adminVdrCapabilities.issue',
    issuedCapabilitySchema,
    issued
  )

  return { capability: prepared.capability, expiresAt }
})

export function issueAdminVdrCapability(args: {
  user: ApiUser
  companyId: Id<'companies'>
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
}): Promise<{ capability: string; expiresAt: number }> {
  return runServerEffect(issueAdminVdrCapabilityEffect(args))
}
