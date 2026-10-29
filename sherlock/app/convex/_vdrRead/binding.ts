// ============================================================================
// VDR READ — server-side room binding
// ============================================================================
// The MCP caller proves a WorkOS identity and nothing else. Everything that
// decides WHICH room it may read is recomputed here, on every entry point,
// from durable state: the WorkOS subject resolves a Convex user and profile,
// the profile's live role decides the branch, and the room is derived — never
// accepted — from the caller.
//
// COMPANY  -> its single owned company; an explicit `salaId` must equal it.
// ADMIN    -> must name `salaId`; authorization is re-evaluated for that room.
// Guests never reach this surface (no WorkOS subject).
// ============================================================================

import { Effect, Option, Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'
import type { AuthContext, AuthResult } from '../_helpers/auth'
import { findUserByProviderIdentifier, isProfileUsable } from '../_helpers/auth.identity'
import { evaluateCompanyManagementAuthorization } from '../_helpers/companyAuthorization'
import { convexPromise, runConvex } from '../_helpers/effect'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type VdrReadFailureCode = 'DENIED' | 'NOT_FOUND'

const VDR_READ_DENIED = 'DENIED' as const
const VDR_READ_NOT_FOUND = 'NOT_FOUND' as const

export type VdrReadBindingFailure = Readonly<{ code: VdrReadFailureCode }>

export type VdrReadBinding = Readonly<{
  auth: AuthResult
  company: Doc<'companies'>
  role: Doc<'profiles'>['role']
}>

export function isVdrReadFailure(
  value: VdrReadBinding | VdrReadBindingFailure
): value is VdrReadBindingFailure {
  return 'code' in value
}

// Un identificador que llega del MCP: recortado, no vacío y con techo. Una
// sola definición para la sala y para la transacción.
const NormalizedId = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isLengthBetween(1, 128))
)
const decodeNormalizedId = Schema.decodeUnknownOption(NormalizedId)

function normalizedId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  return Option.getOrNull(decodeNormalizedId(value.trim()))
}

/**
 * Resolve the room a WorkOS subject may read. Every failure that could
 * otherwise distinguish "exists but not yours" from "does not exist" collapses
 * into NOT_FOUND, so passing someone else's identifier is never an oracle.
 */
const resolveVdrReadBindingEffect = Effect.fn('VdrReadBinding.resolve')(function* (
  ctx: AuthContext,
  args: {
    principalId: string
    salaId?: string
  }
) {
  const subject = normalizedId(args.principalId)
  if (!subject) return { code: VDR_READ_DENIED }

  const user = yield* convexPromise(() => findUserByProviderIdentifier(ctx, subject))
  if (!user) return { code: VDR_READ_DENIED }

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .unique()
  )
  if (!profile || !isProfileUsable(profile)) return { code: VDR_READ_DENIED }

  const auth: AuthResult = {
    // The bearer already proved this WorkOS subject; the entry point re-derives
    // the rest. `authProvider: 'workos'` is what closes the legacy-Clerk bypass
    // inside `evaluateCompanyManagementAuthorization`.
    identity: { subject, authProvider: 'workos' },
    user,
    profile,
  }

  const requestedSala = normalizedId(args.salaId)
  let company: Doc<'companies'> | null = null

  if (profile.role === 'ADMIN') {
    if (!requestedSala) return { code: VDR_READ_NOT_FOUND }
    const companyId = ctx.db.normalizeId('companies', requestedSala)
    company = companyId ? yield* convexPromise(() => ctx.db.get(companyId)) : null
  } else {
    company = yield* convexPromise(() =>
      ctx.db
        .query('companies')
        .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
        .unique()
    )
    if (company && requestedSala && requestedSala !== company._id) {
      return { code: VDR_READ_NOT_FOUND }
    }
  }
  if (!company) return { code: VDR_READ_NOT_FOUND }

  // El `const` no es cosmético: dentro de un closure TypeScript pierde el
  // estrechamiento de un `let`, y aquí lo que se pasa a la autorización tiene
  // que ser la empresa ya probada como no nula.
  const room = company
  const decision = yield* convexPromise(() =>
    evaluateCompanyManagementAuthorization(ctx, auth, room)
  )
  if (!decision.authorized) return { code: VDR_READ_NOT_FOUND }

  return { auth, company: room, role: profile.role }
})

export function resolveVdrReadBinding(
  ctx: AuthContext,
  args: {
    principalId: string
    salaId?: string
  }
): Promise<VdrReadBinding | VdrReadBindingFailure> {
  return runConvex(resolveVdrReadBindingEffect(ctx, args))
}
