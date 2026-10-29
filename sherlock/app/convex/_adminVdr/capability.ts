// ============================================================================
// CONSUMO DE UNA CAPACIDAD ADMIN DEL VDR
// ============================================================================
// Una capacidad es un permiso de UN SOLO USO, amarrado a la sesión WorkOS, a la
// empresa, a la acción, al objetivo y al digest EXACTO de los argumentos. Este
// módulo la gasta: comprueba los diez amarres, la marca consumida y deja la
// huella en el log de admin.
//
// El programa vive en Effect y el borde sigue hablando Promise: quien llama es
// una mutation todavía sin convertir. Cada rechazo es el MISMO `AppError`, sin
// decir cuál amarre falló — y el reparto de canales de `runConvex` garantiza que
// un fallo nuestro (un `crypto.subtle` que revienta) suba como defecto y no se
// disfrace de «no autorizado».
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { AuthResult } from '../_helpers/auth'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { unauthorized } from '../_helpers/errors'
import {
  ADMIN_VDR_CAPABILITY_TTL_MS,
  canonicalizeAdminVdrInput,
  isValidAdminVdrBindingIdentifier,
  isValidAdminVdrCapabilitySecret,
  type AdminVdrAction,
} from './capabilityFormat'

export const adminVdrCapabilityValidator = v.optional(v.string())

const CAPABILITY_TOKEN_PATTERN = /^avc_[A-Za-z0-9_-]{43}$/

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export async function adminVdrIdentityBindingDigest(
  subject: string,
  sessionId: string,
  secret = process.env.ADMIN_VDR_CAPABILITY_SECRET
): Promise<string | null> {
  if (
    !secret ||
    !isValidAdminVdrCapabilitySecret(secret) ||
    !isValidAdminVdrBindingIdentifier(subject) ||
    !isValidAdminVdrBindingIdentifier(sessionId)
  ) {
    return null
  }
  const payload = `admin-vdr-identity.v1\n${subject.length}:${subject}\n${sessionId.length}:${sessionId}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(signature))
}

/** Una sola salida de rechazo: nunca se dice CUÁL de los amarres falló. */
function capabilityDeniedError() {
  return unauthorized('Se requiere una autorización administrativa VDR válida.')
}

function capabilityDenied(): never {
  throw capabilityDeniedError()
}

function resolveWorkOsSession(auth: AuthResult): { subject: string; sessionId: string } {
  if (
    auth.identity.authProvider !== 'workos' ||
    !auth.identity.sessionId ||
    auth.user.workosUserId !== auth.identity.subject
  ) {
    capabilityDenied()
  }
  return { subject: auth.identity.subject, sessionId: auth.identity.sessionId }
}

export function withoutAdminVdrCapability<T extends Record<string, unknown>>(
  args: T
): Omit<T, 'adminCapability'> {
  const { adminCapability: _adminCapability, ...input } = args
  return input
}

type RequireAdminVdrCapabilityArgs = {
  ctx: MutationCtx
  auth: AuthResult
  capability: string | undefined
  company: Doc<'companies'>
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
}

const consumeAdminVdrCapability = Effect.fn('AdminVdrCapability.consume')(function* (
  args: RequireAdminVdrCapabilityArgs
) {
  if (args.auth.profile.role !== 'ADMIN') {
    // Un no-admin que MANDA capacidad está probando la frontera: se rechaza. Sin
    // capacidad, la ruta simplemente no le aplica.
    if (args.capability !== undefined) return yield* Effect.fail(capabilityDeniedError())
    return
  }

  const capability = args.capability
  if (!capability || !CAPABILITY_TOKEN_PATTERN.test(capability)) {
    return yield* Effect.fail(capabilityDeniedError())
  }

  // El guarda expresa su invariante lanzando; `convexSync` lo trae al canal de
  // error en vez de dejarlo subir como defecto.
  const actor = yield* convexSync(() => resolveWorkOsSession(args.auth))
  const canonicalInput = canonicalizeAdminVdrInput(args.input)
  if (!canonicalInput) return yield* Effect.fail(capabilityDeniedError())

  const [tokenHash, inputDigest, identityBindingDigest] = yield* convexPromise(() =>
    Promise.all([
      sha256Hex(capability),
      sha256Hex(canonicalInput),
      adminVdrIdentityBindingDigest(actor.subject, actor.sessionId),
    ])
  )

  const row = yield* convexPromise(() =>
    args.ctx.db
      .query('adminVdrCapabilities')
      .withIndex('by_tokenHash', (query) => query.eq('tokenHash', tokenHash))
      .unique()
  )
  const now = Date.now()
  if (
    !row ||
    row.profileId !== args.auth.profile._id ||
    !identityBindingDigest ||
    row.identityBindingDigest !== identityBindingDigest ||
    row.companyId !== args.company._id ||
    row.action !== args.action ||
    row.target !== args.target ||
    row.inputDigest !== inputDigest ||
    row.expiresAt <= now ||
    row.expiresAt - row.issuedAt !== ADMIN_VDR_CAPABILITY_TTL_MS ||
    row.consumedAt !== undefined
  ) {
    return yield* Effect.fail(capabilityDeniedError())
  }

  // Convex mutations are transactional: if the caller's business write or
  // audit fails after this patch, the consumption rolls back with it.
  yield* convexPromise(() => args.ctx.db.patch(row._id, { consumedAt: now }))
  yield* convexPromise(() =>
    logAdminAction({
      ctx: args.ctx,
      adminProfileId: args.auth.profile._id,
      adminEmail: args.auth.user.email,
      action: 'VDR_ADMIN_CAPABILITY_CONSUME',
      targetType: 'COMPANY',
      targetId: `${args.company._id}`,
      newValue: {
        action: args.action,
        target: args.target,
        capabilityId: `${row._id}`,
        inputDigest,
        sessionBound: true,
      },
    })
  )
})

export function requireAdminVdrCapability(args: RequireAdminVdrCapabilityArgs): Promise<void> {
  return runConvex(consumeAdminVdrCapability(args))
}
