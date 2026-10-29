import { createHmac } from 'node:crypto'

import { Effect, Schema } from 'effect'

import {
  buildVdrGuestServerProofPayload,
  resolveVdrGuestServerBoundaryConfig,
  type VdrGuestServerOperation,
} from '@/../convex/_guests/serverProofFormat'

/**
 * La frontera de servidor no está disponible o no encuadra: sin secreto,
 * audiencia o payload no se firma nada. El mensaje es el código estable que la
 * ruta ya trata como fallo interno — nunca viaja al cliente.
 */
class VdrGuestServerBoundaryError extends Schema.TaggedError<VdrGuestServerBoundaryError>()(
  'VdrGuestServerBoundaryError',
  {
    operation: Schema.String,
    message: Schema.String,
  }
) {}

const createVdrGuestServerProofEffect = Effect.fn('VdrGuestServerProof.create')(function* (args: {
  operation: VdrGuestServerOperation
  bindingParts: readonly string[]
  issuedAt?: number
  secret?: string
  audience?: string
}) {
  const serverIssuedAt = args.issuedAt ?? Date.now()
  const config = resolveVdrGuestServerBoundaryConfig({
    secret: args.secret ?? process.env.VDR_GUEST_SERVER_SECRET,
    audience: args.audience ?? process.env.VDR_GUEST_SERVER_AUDIENCE,
  })
  const payload = buildVdrGuestServerProofPayload({
    operation: args.operation,
    issuedAt: serverIssuedAt,
    audience: config?.audience ?? '',
    bindingParts: args.bindingParts,
  })
  if (!config || !payload) {
    return yield* new VdrGuestServerBoundaryError({
      operation: args.operation,
      message: 'VDR_GUEST_SERVER_BOUNDARY_UNAVAILABLE',
    })
  }
  return {
    serverIssuedAt,
    serverProof: createHmac('sha256', config.secret).update(payload).digest('base64url'),
  }
})

// Puente síncrono: los handlers arman la prueba en línea con los argumentos.
export function createVdrGuestServerProof(args: {
  operation: VdrGuestServerOperation
  bindingParts: readonly string[]
  issuedAt?: number
  secret?: string
  audience?: string
}): { serverIssuedAt: number; serverProof: string } {
  return Effect.runSync(createVdrGuestServerProofEffect(args))
}
