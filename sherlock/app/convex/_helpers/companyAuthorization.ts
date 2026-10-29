import { Effect } from 'effect'
import type { Doc } from '../_generated/dataModel'
import type { AuthContext, AuthResult } from './auth'
import { convexPromise, runConvex, type ConvexEffect } from './effect'
import { unauthorized } from './errors'

export const USER_MEMBERSHIP_CAP = 8
const ORGANIZATION_MEMBERSHIP_CAP = 16
const DIRECTORY_GROUP_MEMBERSHIP_CAP = 16

type CompanyAuthorizationDbContext = Pick<AuthContext, 'db'>

// Los catálogos de esta capa —qué se puede hacer, con qué fuerza, por qué, y
// con qué rol de membresía— se escriben una sola vez. La razón queda en la
// auditoría cuando una sesión no entra, así que no puede ser una cadena suelta.
// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type CompanyAccess = 'MANAGE' | 'READ_ONLY'
type CompanyEnforcement = 'ADMIN' | 'LEGACY_SESSION' | 'UNENFORCED' | 'ENFORCED'
type CompanyAuthorizationReason =
  | 'ADMIN'
  | 'LEGACY_SESSION'
  | 'EXACT_WORKOS_BINDING'
  | 'CUTOVER_COMPATIBILITY'
  | 'PROFILE_MISMATCH'
  | 'SESSION_PROVIDER_MISMATCH'
  | 'BINDING_REQUIRED'
  | 'BINDING_INVALID'
  | 'MEMBERSHIP_REVOKED'
  | 'FIRST_LOGIN_OWNER'
type CompanyMembershipRole = 'COMPANY_OWNER' | 'COMPANY_MEMBER'

export type CompanyAuthorization = {
  access: CompanyAccess
  company: Doc<'companies'>
  enforcement: CompanyEnforcement
}

export type CompanyManagementAuthorizationDecision = {
  authorized: boolean
  enforcement: CompanyAuthorization['enforcement']
  reason: CompanyAuthorizationReason
}

export const COMPANY_ORG_BINDING_CONTROL_KEY = 'WORKOS_COMPANY_ORG_BINDING_V1' as const

function denied(message = 'No tienes permiso para abrir este data room') {
  return unauthorized(message)
}

function getExactlyOneByIndex<T>(
  load: () => Promise<T[]>,
  predicate: (row: T) => boolean
): ConvexEffect<T | null> {
  return convexPromise(load).pipe(
    Effect.map((rows) => (rows.length !== 1 ? null : predicate(rows[0]) ? rows[0] : null))
  )
}

const isActiveDirectoryEvidence = Effect.fn('CompanyAuth.directoryEvidence')(function* (
  ctx: CompanyAuthorizationDbContext,
  membership: Doc<'organizationMemberships'>
) {
  const hasDirectoryEvidence = Boolean(
    membership.workosDirectoryId ||
    membership.workosDirectoryUserId ||
    membership.workosDirectoryGroupId
  )
  if (!hasDirectoryEvidence) return true

  const directoryId = membership.workosDirectoryId
  const directoryUserId = membership.workosDirectoryUserId
  if (!directoryId || !directoryUserId) return false

  const directoryUser = yield* getExactlyOneByIndex(
    () =>
      ctx.db
        .query('workosDirectoryUsers')
        .withIndex('by_directoryUserId', (q) => q.eq('directoryUserId', directoryUserId))
        .take(2),
    (candidate) =>
      candidate.userId === membership.userId &&
      candidate.workosDirectoryId === membership.workosDirectoryId
  )
  if (!directoryUser || directoryUser.active !== true || directoryUser.state !== 'ACTIVE') {
    return false
  }

  const directory = yield* getExactlyOneByIndex(
    () =>
      ctx.db
        .query('workosDirectories')
        .withIndex('by_directoryId', (q) => q.eq('directoryId', directoryId))
        .take(2),
    (candidate) => candidate.directoryId === membership.workosDirectoryId
  )
  if (!directory || directory.active !== true || directory.state !== 'ACTIVE') return false

  const resolvedOrgId = directoryUser.workosOrgId ?? directory.workosOrgId
  if (!resolvedOrgId || resolvedOrgId !== membership.providerOrgId) return false

  const directoryGroupId = membership.workosDirectoryGroupId
  if (!directoryGroupId) return true

  const groupRows = yield* convexPromise(() =>
    ctx.db
      .query('workosDirectoryGroupMemberships')
      .withIndex('by_directoryUserId_active', (q) =>
        q.eq('directoryUserId', directoryUserId).eq('active', true)
      )
      .take(DIRECTORY_GROUP_MEMBERSHIP_CAP + 1)
  )
  if (groupRows.length > DIRECTORY_GROUP_MEMBERSHIP_CAP) return false

  const matchingGroupRows = groupRows.filter(
    (candidate) =>
      candidate.directoryGroupId === directoryGroupId &&
      candidate.workosDirectoryId === membership.workosDirectoryId &&
      candidate.mappedBetaRole === membership.betaRole &&
      (candidate.workosOrgId === undefined || candidate.workosOrgId === membership.providerOrgId)
  )
  if (matchingGroupRows.length !== 1) return false

  const group = yield* getExactlyOneByIndex(
    () =>
      ctx.db
        .query('workosDirectoryGroups')
        .withIndex('by_directoryGroupId', (q) => q.eq('directoryGroupId', directoryGroupId))
        .take(2),
    (candidate) =>
      candidate.directoryGroupId === directoryGroupId &&
      candidate.workosDirectoryId === membership.workosDirectoryId
  )

  return Boolean(
    group &&
    group.active === true &&
    group.state === 'ACTIVE' &&
    group.mappedBetaRole === membership.betaRole &&
    (group.workosOrgId === undefined || group.workosOrgId === membership.providerOrgId)
  )
})

function isStructurallyValidWorkosCompanyMembership(
  membership: Doc<'organizationMemberships'>,
  expectedRole: CompanyMembershipRole
): boolean {
  if (
    membership.authProvider !== 'workos' ||
    membership.betaRole !== expectedRole ||
    membership.profileRole !== 'COMPANY' ||
    membership.providerOrgId.trim().length === 0 ||
    (membership.workosOrgId !== undefined && membership.workosOrgId !== membership.providerOrgId)
  ) {
    return false
  }

  return true
}

const isUsableWorkosMembership = Effect.fn('CompanyAuth.usableMembership')(function* (
  ctx: CompanyAuthorizationDbContext,
  membership: Doc<'organizationMemberships'>,
  expectedRole: CompanyMembershipRole
) {
  if (
    membership.status !== 'ACTIVE' ||
    !isStructurallyValidWorkosCompanyMembership(membership, expectedRole)
  ) {
    return false
  }

  return yield* isActiveDirectoryEvidence(ctx, membership)
})

function isCurrentWorkosIdentity(auth: AuthResult): boolean {
  return (
    auth.identity.authProvider === 'workos' &&
    auth.user.workosUserId === auth.identity.subject &&
    auth.identity.subject.trim().length > 0
  )
}

function isCurrentClerkIdentity(auth: AuthResult): boolean {
  if (auth.identity.authProvider !== 'clerk') return false
  return (
    auth.user.clerkId === auth.identity.subject ||
    (auth.user.authProvider === 'clerk' && auth.user.providerUserId === auth.identity.subject)
  )
}

export function isCurrentCompanyAuthorizationSession(auth: AuthResult): boolean {
  if (auth.identity.authProvider === 'workos') return isCurrentWorkosIdentity(auth)

  // A retained Clerk credential stops being a legacy management session as
  // soon as the local user is linked to WorkOS. This applies to admins too:
  // their role bypasses company ownership/membership, never provider identity.
  return !auth.user.workosUserId && isCurrentClerkIdentity(auth)
}

type CompanyWorkosOrgBindingResolution =
  | { status: 'BOUND'; providerOrgId: string; source: Doc<'companyOrganizationBindings'>['source'] }
  | { status: 'MISSING' }
  | { status: 'INVALID' }

const inspectCompanyWorkosOrgBinding = Effect.fn('CompanyAuth.inspectOrgBinding')(function* (
  ctx: CompanyAuthorizationDbContext,
  company: Doc<'companies'>
) {
  const bindings = yield* convexPromise(() =>
    ctx.db
      .query('companyOrganizationBindings')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(2)
  )
  if (bindings.length === 0) {
    return { status: 'MISSING' } satisfies CompanyWorkosOrgBindingResolution
  }
  if (bindings.length !== 1) {
    return { status: 'INVALID' } satisfies CompanyWorkosOrgBindingResolution
  }

  const binding = bindings[0]
  if (
    binding.companyId !== company._id ||
    binding.ownerProfileId !== company.ownerId ||
    binding.authProvider !== 'workos' ||
    binding.providerOrgId.trim().length === 0
  ) {
    return { status: 'INVALID' } satisfies CompanyWorkosOrgBindingResolution
  }
  return {
    status: 'BOUND',
    providerOrgId: binding.providerOrgId,
    source: binding.source,
  } satisfies CompanyWorkosOrgBindingResolution
})

export async function isCompanyOrganizationBindingEnforced(
  ctx: CompanyAuthorizationDbContext
): Promise<boolean> {
  const controls = await ctx.db
    .query('companyAuthorizationControls')
    .withIndex('by_key', (q) => q.eq('key', COMPANY_ORG_BINDING_CONTROL_KEY))
    .take(2)

  // Duplicate control rows are an invalid security state. Enforcing the
  // binding is safer than silently reopening compatibility.
  if (controls.length > 1) return true
  return controls[0]?.status === 'ENFORCED'
}

const loadUsableOwnerMemberships = Effect.fn('CompanyAuth.usableOwnerMemberships')(function* (
  ctx: CompanyAuthorizationDbContext,
  userId: Doc<'users'>['_id'],
  profileId: Doc<'profiles'>['_id'],
  providerOrgId?: string,
  membershipRows?: Doc<'organizationMemberships'>[]
) {
  const memberships =
    membershipRows ??
    (yield* convexPromise(() =>
      ctx.db
        .query('organizationMemberships')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .take(USER_MEMBERSHIP_CAP + 1)
    ))
  if (memberships.length > USER_MEMBERSHIP_CAP) return []

  const usableMemberships: Doc<'organizationMemberships'>[] = []
  for (const membership of memberships) {
    // El orden importa: las tres condiciones baratas se evalúan antes de gastar
    // una lectura en la evidencia de directorio, igual que el `&&` original.
    if (
      membership.userId !== userId ||
      membership.profileId !== profileId ||
      (providerOrgId !== undefined && membership.providerOrgId !== providerOrgId)
    ) {
      continue
    }

    if (yield* isUsableWorkosMembership(ctx, membership, 'COMPANY_OWNER')) {
      usableMemberships.push(membership)
    }
  }

  return usableMemberships
})

// Sin binding no se puede inferir la empresa a partir de la única membresía
// que sobrevivió a una revocación. El historial también cuenta como evidencia.
export const loadCompanyOwnerMembershipEvidence = Effect.fn('CompanyAuth.ownerEvidence')(function* (
  ctx: CompanyAuthorizationDbContext,
  user: Doc<'users'>,
  profileId: Doc<'profiles'>['_id']
) {
  const memberships = yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .take(USER_MEMBERSHIP_CAP + 1)
  )
  // Un delete puede llegar antes de la primera fila local de membresía.
  const workosUserId = user.workosUserId
  const tombstone = workosUserId
    ? yield* convexPromise(() =>
        ctx.db
          .query('organizationMembershipTombstones')
          .withIndex('by_providerUserId', (q) =>
            q.eq('authProvider', 'workos').eq('providerUserId', workosUserId)
          )
          .first()
      )
    : null
  const usableMemberships = yield* loadUsableOwnerMemberships(
    ctx,
    user._id,
    profileId,
    undefined,
    memberships
  )
  const candidate = usableMemberships.length === 1 ? usableMemberships[0] : undefined
  const unambiguousProviderOrgId =
    candidate &&
    !tombstone &&
    memberships.every(
      (membership) =>
        membership.authProvider !== 'workos' || membership.providerOrgId === candidate.providerOrgId
    )
      ? candidate.providerOrgId
      : undefined
  return {
    memberships,
    usableMemberships,
    hasMembershipHistory: memberships.length > 0 || tombstone !== null,
    unambiguousProviderOrgId,
  }
})

// El borde Promise va ANTES de su programa a propósito: `auth-audit.test.ts` lee
// el bloque que empieza en este `export function` y termina en el siguiente
// export de nivel superior, y ahí es donde tiene que poder ver las guardas que
// la decisión aplica. El programa se queda pegado abajo, sin `export`.
export function evaluateCompanyManagementAuthorization(
  ctx: CompanyAuthorizationDbContext,
  auth: AuthResult,
  company: Doc<'companies'>
): Promise<CompanyManagementAuthorizationDecision> {
  return runConvex(evaluateCompanyManagementAuthorizationEffect(ctx, auth, company))
}

const evaluateCompanyManagementAuthorizationEffect = Effect.fn('CompanyAuth.evaluateManagement')(
  function* (ctx: CompanyAuthorizationDbContext, auth: AuthResult, company: Doc<'companies'>) {
    if (!isCurrentCompanyAuthorizationSession(auth)) {
      return {
        authorized: false,
        enforcement: 'ENFORCED',
        reason: 'SESSION_PROVIDER_MISMATCH',
      } satisfies CompanyManagementAuthorizationDecision
    }
    if (auth.profile.isActive === false) {
      return {
        authorized: false,
        enforcement: 'ENFORCED',
        reason: 'PROFILE_MISMATCH',
      } satisfies CompanyManagementAuthorizationDecision
    }
    if (auth.profile.role === 'ADMIN') {
      return {
        authorized: true,
        enforcement: 'ADMIN',
        reason: 'ADMIN',
      } satisfies CompanyManagementAuthorizationDecision
    }
    if (auth.profile._id !== company.ownerId) {
      return {
        authorized: false,
        enforcement: 'ENFORCED',
        reason: 'PROFILE_MISMATCH',
      } satisfies CompanyManagementAuthorizationDecision
    }

    // The live session provider is the trust boundary. A dual-linked row may
    // still say `authProvider: clerk` while a WorkOS JWT resolved it through
    // `workosUserId`; that WorkOS session must never inherit the Clerk legacy
    // bypass from stored migration metadata.
    const binding = yield* inspectCompanyWorkosOrgBinding(ctx, company)
    if (auth.identity.authProvider === 'clerk') {
      // Legacy is only for a genuinely Clerk-only identity. Once a user or its
      // company is linked to WorkOS, a retained Clerk credential must not bypass
      // WorkOS deprovisioning or the organization cutover.
      if (binding.status !== 'MISSING') {
        return {
          authorized: false,
          enforcement: 'ENFORCED',
          reason: 'SESSION_PROVIDER_MISMATCH',
        } satisfies CompanyManagementAuthorizationDecision
      }
      return {
        authorized: true,
        enforcement: 'LEGACY_SESSION',
        reason: 'LEGACY_SESSION',
      } satisfies CompanyManagementAuthorizationDecision
    }

    if (binding.status === 'BOUND') {
      if (binding.source === 'BACKFILL') {
        const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, auth.user, auth.profile._id)
        if (evidence.unambiguousProviderOrgId !== binding.providerOrgId) {
          return {
            authorized: false,
            enforcement: 'ENFORCED',
            reason: 'MEMBERSHIP_REVOKED',
          } satisfies CompanyManagementAuthorizationDecision
        }
      }
      const boundMemberships = yield* loadUsableOwnerMemberships(
        ctx,
        auth.user._id,
        auth.profile._id,
        binding.providerOrgId
      )
      return boundMemberships.length === 1
        ? ({
            authorized: true,
            enforcement: 'ENFORCED',
            reason: 'EXACT_WORKOS_BINDING',
          } satisfies CompanyManagementAuthorizationDecision)
        : ({
            authorized: false,
            enforcement: 'ENFORCED',
            reason: 'MEMBERSHIP_REVOKED',
          } satisfies CompanyManagementAuthorizationDecision)
    }

    // Compatibility is only for an absent binding during the staged rollout.
    // Duplicate, stale-owner, blank, or otherwise malformed bindings are an
    // invalid security state and always fail closed.
    if (binding.status === 'INVALID') {
      return {
        authorized: false,
        enforcement: 'ENFORCED',
        reason: 'BINDING_INVALID',
      } satisfies CompanyManagementAuthorizationDecision
    }

    if (yield* convexPromise(() => isCompanyOrganizationBindingEnforced(ctx))) {
      return {
        authorized: false,
        enforcement: 'ENFORCED',
        reason: 'BINDING_REQUIRED',
      } satisfies CompanyManagementAuthorizationDecision
    }

    const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, auth.user, auth.profile._id)
    if (evidence.unambiguousProviderOrgId) {
      return {
        authorized: true,
        enforcement: 'UNENFORCED',
        reason: 'CUTOVER_COMPATIBILITY',
      } satisfies CompanyManagementAuthorizationDecision
    }

    if (!evidence.hasMembershipHistory) {
      return {
        authorized: true,
        enforcement: 'UNENFORCED',
        reason: 'FIRST_LOGIN_OWNER',
      } satisfies CompanyManagementAuthorizationDecision
    }

    return {
      authorized: false,
      enforcement: 'UNENFORCED',
      reason: 'MEMBERSHIP_REVOKED',
    } satisfies CompanyManagementAuthorizationDecision
  }
)

export async function requireCompanyManagementAuthorization(
  ctx: CompanyAuthorizationDbContext,
  auth: AuthResult,
  company: Doc<'companies'>,
  denialMessage = 'No tienes permiso para administrar esta empresa'
): Promise<CompanyManagementAuthorizationDecision> {
  const decision = await evaluateCompanyManagementAuthorization(ctx, auth, company)
  if (!decision.authorized) throw denied(denialMessage)
  return decision
}

// El borde Promise va ANTES de su programa a propósito: `auth-audit.test.ts` lee
// el bloque que empieza en este `export function` y termina en el siguiente
// export de nivel superior, y ahí es donde tiene que poder ver las guardas que
// la decisión aplica. El programa se queda pegado abajo, sin `export`.
export function resolveCompanyWorkosOrgBindingForCreation(
  ctx: CompanyAuthorizationDbContext,
  auth: AuthResult,
  ownerProfileId: Doc<'profiles'>['_id'],
  denialMessage = 'No tienes permiso para crear esta empresa'
): Promise<string | undefined> {
  return runConvex(bindingForCreationEffect(ctx, auth, ownerProfileId, denialMessage))
}

const bindingForCreationEffect = Effect.fn('CompanyAuth.bindingForCreation')(function* (
  ctx: CompanyAuthorizationDbContext,
  auth: AuthResult,
  ownerProfileId: Doc<'profiles'>['_id'],
  denialMessage: string
) {
  if (!isCurrentCompanyAuthorizationSession(auth) || auth.profile.isActive === false) {
    return yield* Effect.fail(denied(denialMessage))
  }
  const ownerProfile = yield* convexPromise(() => ctx.db.get(ownerProfileId))
  if (!ownerProfile || ownerProfile.role !== 'COMPANY' || ownerProfile.isActive === false) {
    return yield* Effect.fail(denied(denialMessage))
  }
  const ownerUser = yield* convexPromise(() => ctx.db.get(ownerProfile.userId))
  if (!ownerUser || ownerUser._id !== ownerProfile.userId) {
    return yield* Effect.fail(denied(denialMessage))
  }

  const isSelf = auth.profile._id === ownerProfile._id
  if (!isSelf && auth.profile.role !== 'ADMIN') return yield* Effect.fail(denied(denialMessage))
  // Sin usuario WorkOS no hay organización que ligar: el llamador crea la
  // empresa sin binding.
  if (!ownerUser.workosUserId) return
  const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, ownerUser, ownerProfile._id)
  if (evidence.unambiguousProviderOrgId) return evidence.unambiguousProviderOrgId

  // Once enforcement is live, creation must preserve the invariant that each
  // WorkOS-linked company has exactly one valid organization binding.
  if (yield* convexPromise(() => isCompanyOrganizationBindingEnforced(ctx))) {
    return yield* Effect.fail(denied(denialMessage))
  }

  // During inventory/backfill, a Clerk/admin flow may still create an unbound
  // row. It is surfaced as UNRESOLVED and blocks cutover until explicitly
  // reconciled. A live WorkOS owner never receives this compatibility bypass.
  if (isSelf && auth.identity.authProvider === 'workos') {
    return yield* Effect.fail(denied(denialMessage))
  }

  // Cae al final sin binding: la fila se crea UNRESOLVED y bloquea el cutover
  // hasta que alguien la reconcilie a mano.
})

const resolveCompanyWorkosOrgBindingForSelfProvisioningEffect = Effect.fn(
  'CompanyAuth.bindingForSelfProvisioning'
)(function* (ctx: CompanyAuthorizationDbContext, auth: AuthResult) {
  // Sin argumento `ownerProfileId`: acá el dueño es el propio llamador por
  // construcción, así que la propiedad es estructural y no un gate en runtime.
  if (!isCurrentCompanyAuthorizationSession(auth) || auth.profile.isActive === false) {
    return { allowed: false }
  }
  if (auth.profile.role !== 'COMPANY') return { allowed: false }
  if (!auth.user.workosUserId) return { allowed: true }

  const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, auth.user, auth.profile._id)
  if (evidence.unambiguousProviderOrgId) {
    return { allowed: true, providerOrgId: evidence.unambiguousProviderOrgId }
  }

  // Con el enforcement activo, una empresa sin binding es un estado de seguridad
  // inválido: el aprovisionamiento se niega en vez de crear uno.
  const enforced = yield* convexPromise(() => isCompanyOrganizationBindingEnforced(ctx))
  if (enforced) return { allowed: false }

  // Espejo de FIRST_LOGIN_OWNER en el camino de lectura/gestión: cero membresías
  // UTILIZABLES con alguna fila existente es una desprovisión (INACTIVE), no un
  // primer login — crearle workspace aquí le daría uno que después no puede abrir.
  if (evidence.hasMembershipHistory) return { allowed: false }

  // Una sesión WorkOS propia sin membresía de organización es, por definición, el
  // estado de primer login. `...ForCreation` lo niega, lo que haría imposible
  // aprovisionar justo a la población que este camino sirve.
  return { allowed: true }
})

/**
 * Hermana de `resolveCompanyWorkosOrgBindingForCreation` para el aprovisionamiento
 * de primer login. Devuelve una decisión en vez de lanzar: el llamador degrada al
 * wizard existente en vez de mostrarle un error de autorización a un usuario nuevo
 * legítimo.
 */
export function resolveCompanyWorkosOrgBindingForSelfProvisioning(
  ctx: CompanyAuthorizationDbContext,
  auth: AuthResult
): Promise<{ allowed: false } | { allowed: true; providerOrgId?: string }> {
  return runConvex(resolveCompanyWorkosOrgBindingForSelfProvisioningEffect(ctx, auth))
}

const resolveMemberCompany = Effect.fn('CompanyAuth.resolveMemberCompany')(function* (
  ctx: AuthContext,
  auth: AuthResult,
  denialMessage: string
) {
  const memberships = yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_userId', (q) => q.eq('userId', auth.user._id))
      .take(USER_MEMBERSHIP_CAP + 1)
  )
  if (memberships.length > USER_MEMBERSHIP_CAP) return yield* Effect.fail(denied(denialMessage))

  const usableMemberships: Doc<'organizationMemberships'>[] = []
  for (const membership of memberships) {
    if (membership.userId !== auth.user._id || membership.profileId !== auth.profile._id) {
      continue
    }

    if (yield* isUsableWorkosMembership(ctx, membership, 'COMPANY_MEMBER')) {
      usableMemberships.push(membership)
    }
  }
  if (usableMemberships.length === 0) return null
  if (usableMemberships.length !== 1) return yield* Effect.fail(denied(denialMessage))

  const memberMembership = usableMemberships[0]
  const organizationMemberships = yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_providerOrgId', (q) =>
        q.eq('authProvider', 'workos').eq('providerOrgId', memberMembership.providerOrgId)
      )
      .take(ORGANIZATION_MEMBERSHIP_CAP + 1)
  )
  if (organizationMemberships.length > ORGANIZATION_MEMBERSHIP_CAP) {
    return yield* Effect.fail(denied(denialMessage))
  }

  const ownerMemberships: Doc<'organizationMemberships'>[] = []
  for (const membership of organizationMemberships) {
    if (yield* isUsableWorkosMembership(ctx, membership, 'COMPANY_OWNER')) {
      ownerMemberships.push(membership)
    }
  }
  if (ownerMemberships.length !== 1) return yield* Effect.fail(denied(denialMessage))

  const ownerMembership = ownerMemberships[0]
  const [ownerProfile, ownerUser] = yield* Effect.all(
    [
      convexPromise(() => ctx.db.get(ownerMembership.profileId)),
      convexPromise(() => ctx.db.get(ownerMembership.userId)),
    ],
    { concurrency: 'unbounded' }
  )
  if (
    !ownerProfile ||
    !ownerUser ||
    ownerProfile._id !== ownerMembership.profileId ||
    ownerProfile.userId !== ownerMembership.userId ||
    ownerProfile.role !== 'COMPANY' ||
    ownerProfile.isActive === false ||
    !ownerUser.workosUserId
  ) {
    return yield* Effect.fail(denied(denialMessage))
  }

  const companies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', ownerProfile._id))
      .take(2)
  )
  if (companies.length !== 1) return yield* Effect.fail(denied(denialMessage))
  const company = companies[0]
  const binding = yield* inspectCompanyWorkosOrgBinding(ctx, company)
  if (binding.status === 'INVALID') return yield* Effect.fail(denied(denialMessage))
  if (binding.status === 'BOUND' && binding.providerOrgId !== memberMembership.providerOrgId) {
    return yield* Effect.fail(denied(denialMessage))
  }
  if (binding.status === 'BOUND' && binding.source === 'BACKFILL') {
    const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, ownerUser, ownerProfile._id)
    if (evidence.unambiguousProviderOrgId !== binding.providerOrgId) {
      return yield* Effect.fail(denied(denialMessage))
    }
  }
  if (binding.status === 'MISSING') {
    if (yield* convexPromise(() => isCompanyOrganizationBindingEnforced(ctx))) {
      return yield* Effect.fail(denied(denialMessage))
    }
    const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, ownerUser, ownerProfile._id)
    if (evidence.unambiguousProviderOrgId !== memberMembership.providerOrgId) {
      return yield* Effect.fail(denied(denialMessage))
    }
  }
  return company
})

const resolveCurrentCompanyAuthorizationEffect = Effect.fn('CompanyAuth.resolveCurrent')(function* (
  ctx: AuthContext,
  auth: AuthResult,
  denialMessage: string
) {
  if (auth.profile.role !== 'COMPANY') return null

  const ownedCompanies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', auth.profile._id))
      .take(2)
  )
  if (ownedCompanies.length > 1) return yield* Effect.fail(denied(denialMessage))
  if (ownedCompanies.length === 1) {
    const decision = yield* evaluateCompanyManagementAuthorizationEffect(
      ctx,
      auth,
      ownedCompanies[0]
    )
    // La gestión puede fallar y el perfil seguir siendo miembro de otra
    // empresa: el alta de primer login inserta ownerId antes de que llegue
    // organization_membership.created. Cerrar en null le quitaba el solo
    // lectura de la emisora. Si la gestión sí autoriza, esa fila manda.
    if (decision.authorized) {
      return {
        access: 'MANAGE',
        company: ownedCompanies[0],
        enforcement: decision.enforcement,
      } satisfies CompanyAuthorization
    }
  }

  // Membership RBAC is a WorkOS-only lane. A legacy Clerk identity can still
  // resolve a shared local user for migration compatibility, but it must never
  // consume that user's WorkOS organization grants.
  if (auth.identity.authProvider !== 'workos' || auth.user.workosUserId !== auth.identity.subject) {
    return null
  }

  const company = yield* resolveMemberCompany(ctx, auth, denialMessage)
  if (!company) return null

  const binding = yield* inspectCompanyWorkosOrgBinding(ctx, company)
  return {
    access: 'READ_ONLY',
    company,
    enforcement: binding.status === 'BOUND' ? 'ENFORCED' : 'UNENFORCED',
  } satisfies CompanyAuthorization
})

export function resolveCurrentCompanyAuthorization(
  ctx: AuthContext,
  auth: AuthResult,
  denialMessage = 'No tienes permiso para abrir este data room'
): Promise<CompanyAuthorization | null> {
  return runConvex(resolveCurrentCompanyAuthorizationEffect(ctx, auth, denialMessage))
}

const requireCompanyReadAuthorizationEffect = Effect.fn('CompanyAuth.requireRead')(function* (
  ctx: AuthContext,
  auth: AuthResult,
  company: Doc<'companies'>,
  denialMessage: string
) {
  if (auth.profile.role === 'ADMIN') {
    const decision = yield* evaluateCompanyManagementAuthorizationEffect(ctx, auth, company)
    if (!decision.authorized) return yield* Effect.fail(denied(denialMessage))
    return { access: 'MANAGE', company, enforcement: 'ADMIN' } satisfies CompanyAuthorization
  }

  const resolved = yield* resolveCurrentCompanyAuthorizationEffect(ctx, auth, denialMessage)
  if (!resolved || resolved.company._id !== company._id) {
    return yield* Effect.fail(denied(denialMessage))
  }
  return resolved
})

export function requireCompanyReadAuthorization(
  ctx: AuthContext,
  auth: AuthResult,
  company: Doc<'companies'>,
  denialMessage = 'No tienes permiso para abrir este data room'
): Promise<CompanyAuthorization> {
  return runConvex(requireCompanyReadAuthorizationEffect(ctx, auth, company, denialMessage))
}
