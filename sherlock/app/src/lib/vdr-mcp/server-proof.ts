import { createHmac } from 'node:crypto'
import { Schema } from 'effect'

import {
  buildVdrReadServerProofPayload,
  isValidVdrReadServerAudience,
  isValidVdrReadServerSecret,
  type VdrReadServerOperation,
} from '@/../convex/_vdrRead/serverProofFormat'

/**
 * No se pudo firmar la llamada app→Convex del carril de lectura. Error tipado y
 * discriminable por `reason`: `config` es un deployment sin secreto o sin
 * audiencia válidos, `input` es un binding que no arma payload. Ninguno de los
 * dos lleva el secreto ni la audiencia adentro — el error viaja a logs.
 */
class VdrReadServerProofError extends Schema.TaggedError<VdrReadServerProofError>()(
  'VdrReadServerProofError',
  {
    reason: Schema.Literals(['config', 'input']),
    operation: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * Sign an app-to-Convex call for the VDR read surface. Dedicated secret and
 * audience: a Model Runs proof can never redeem a VDR read entry point.
 */
export function createVdrReadServerProof(args: {
  operation: VdrReadServerOperation
  bindingParts: readonly string[]
  issuedAt?: number
  secret?: string
  audience?: string
}): { serverIssuedAt: number; serverProof: string } {
  const issuedAt = args.issuedAt ?? Date.now()
  const secret = args.secret ?? process.env.VDR_MCP_SERVER_SECRET ?? ''
  const audience = args.audience ?? process.env.VDR_MCP_SERVER_AUDIENCE ?? ''
  if (!isValidVdrReadServerSecret(secret) || !isValidVdrReadServerAudience(audience)) {
    throw new VdrReadServerProofError({
      reason: 'config',
      operation: args.operation,
      message: 'VDR_MCP_SERVER_CONFIG_INVALID',
    })
  }
  const payload = buildVdrReadServerProofPayload({
    operation: args.operation,
    issuedAt,
    audience,
    bindingParts: args.bindingParts,
  })
  if (!payload) {
    throw new VdrReadServerProofError({
      reason: 'input',
      operation: args.operation,
      message: 'VDR_MCP_SERVER_PROOF_INPUT_INVALID',
    })
  }
  return {
    serverIssuedAt: issuedAt,
    serverProof: createHmac('sha256', secret).update(payload).digest('base64url'),
  }
}
