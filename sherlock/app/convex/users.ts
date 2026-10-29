// ============================================================================
// Sherlock - USER FUNCTIONS
// ============================================================================
// Funciones para manejar usuarios y perfiles.
// Estas funciones corren en el servidor de Convex.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { requireAuthAdmin } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import {
  findUserByAuthIdentity,
  findUserByProviderIdentifier,
  getIdentityAuthProvider,
  isProfileUsable,
  loadProviderUserTombstone,
  requireAuthEffect,
  syntheticIdentityEmail,
  type ProviderIdentity,
} from './_helpers/auth.identity'
import { stripAdminOnlyKycFields } from './_helpers/kycFilter'
import {
  AppError,
  ErrorCode,
  unauthorized,
  userNotFound,
} from './_helpers/errors'
import { recordCompanyAuthorizationInventoryForCreation } from './companyAuthorizationRollout'
import { markCompletedProgram, markSkippedProgram } from './webhookEvents'

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function resolveCurrentUserState(
  ctx: QueryCtx,
  identityOrProviderUserId: ProviderIdentity | string
): Promise<{ user: Doc<'users'> | null; profile: Doc<'profiles'> | null }> {
  const identity = typeof identityOrProviderUserId === 'string' ? null : identityOrProviderUserId
  const user =
    typeof identityOrProviderUserId === 'string'
      ? await findUserByProviderIdentifier(ctx, identityOrProviderUserId)
      : await findUserByAuthIdentity(ctx, identityOrProviderUserId)

  if (!user) {
    return { user: null, profile: null }
  }

  // Optional current-user reads must enforce the same provider cutover as
  // `requireAuth`. A retained Clerk token can still locate a dual-linked row
  // through `clerkId`, but it must become anonymous before the profile (or any
  // downstream business state) is read.
  if (identity && getIdentityAuthProvider(identity) === 'clerk' && user.workosUserId) {
    return { user: null, profile: null }
  }

  const profile = await ctx.db
    .query('profiles')
    .withIndex('by_userId', (q) => q.eq('userId', user._id))
    .first()

  // Internal provider-id lookups retain their existing contract. Only
  // request-authenticated optional reads degrade an inactive profile to an
  // anonymous result, matching the mandatory `requireAuth` boundary.
  if (identity && profile && !isProfileUsable(profile)) {
    return { user: null, profile: null }
  }

  return { user, profile }
}

type WorkosSyncResult = {
  action: string
  resourceId?: string
  details: string
  processed: boolean
}

type PrivateBetaRole =
  | 'ADMIN'
  | 'COMPANY_OWNER'
  | 'COMPANY_MEMBER'
  | 'COUNSEL_REVIEWER'

type ProfileRole = 'COMPANY' | 'ADMIN'

const WORKOS_ROLE_MAP: Record<string, PrivateBetaRole> = {
  company_owner: 'COMPANY_OWNER',
  company_member: 'COMPANY_MEMBER',
  counsel_reviewer: 'COUNSEL_REVIEWER',
}

const WORKOS_DIRECTORY_GROUP_ROLE_MAP: Record<string, PrivateBetaRole> = {
  sherlock_company_owner: 'COMPANY_OWNER',
  sherlock_company_owners: 'COMPANY_OWNER',
  sherlock_company_member: 'COMPANY_MEMBER',
  sherlock_company_members: 'COMPANY_MEMBER',
  sherlock_counsel_reviewer: 'COUNSEL_REVIEWER',
  sherlock_counsel_reviewers: 'COUNSEL_REVIEWER',
}

const DIRECTORY_ROLE_PRIORITY: PrivateBetaRole[] = [
  'COMPANY_OWNER',
  'COMPANY_MEMBER',
  'COUNSEL_REVIEWER',
]

type DirectoryState = 'ACTIVE' | 'INACTIVE' | 'DELETED'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function stringValueFrom(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record?.[key])
    if (value) return value
  }
  return undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const raw = stringValue(value)
  if (!raw) {
    return undefined
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

function timestampValueFrom(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = timestampValue(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function syncSkipped(eventType: string, data: unknown, reason?: string): WorkosSyncResult {
  const record = asRecord(data)
  const resourceId = stringValue(record?.id) ?? stringValue(record?.organizationId)
  return {
    action: 'workos_event_skipped',
    resourceId,
    details: reason ?? `No local sync handler for WorkOS event ${eventType}`,
    processed: false,
  }
}

function fullName(firstName?: string, lastName?: string): string | undefined {
  return [firstName, lastName].filter(Boolean).join(' ') || undefined
}

function mapBetaRoleToProfileRole(betaRole: PrivateBetaRole): ProfileRole {
  switch (betaRole) {
    case 'ADMIN':
      return 'ADMIN'
    case 'COUNSEL_REVIEWER':
    case 'COMPANY_OWNER':
    case 'COMPANY_MEMBER':
      return 'COMPANY'
  }
}

function normalizeDirectoryState(value: string | undefined, deleted = false): DirectoryState {
  if (deleted) return 'DELETED'

  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'active' ||
    normalized === 'linked' ||
    normalized === 'activated' ||
    normalized === 'enabled'
  ) {
    return 'ACTIVE'
  }

  return 'INACTIVE'
}

function normalizeDirectoryRoleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sherlock[:_\s-]+/, 'sherlock_')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function betaRoleValue(value: unknown): PrivateBetaRole | null {
  if (
    value === 'COMPANY_OWNER' ||
    value === 'COMPANY_MEMBER' ||
    value === 'COUNSEL_REVIEWER'
  ) {
    return value
  }

  const slug = stringValue(value)
  if (!slug) {
    return null
  }

  return WORKOS_ROLE_MAP[normalizeDirectoryRoleKey(slug)] ?? null
}

function getDirectoryGroupBetaRole(data: Record<string, unknown>): PrivateBetaRole | null {
  const rawAttributes = asRecord(data.rawAttributes) ?? asRecord(data.raw_attributes)
  const customAttributes = asRecord(data.customAttributes) ?? asRecord(data.custom_attributes)

  const explicitRole =
    betaRoleValue(data.sherlockRole) ??
    betaRoleValue(data.sherlock_role) ??
    betaRoleValue(data.betaRole) ??
    betaRoleValue(data.beta_role) ??
    betaRoleValue(rawAttributes?.sherlockRole) ??
    betaRoleValue(rawAttributes?.sherlock_role) ??
    betaRoleValue(rawAttributes?.betaRole) ??
    betaRoleValue(rawAttributes?.beta_role) ??
    betaRoleValue(customAttributes?.sherlockRole) ??
    betaRoleValue(customAttributes?.sherlock_role) ??
    betaRoleValue(customAttributes?.betaRole) ??
    betaRoleValue(customAttributes?.beta_role)

  if (explicitRole) {
    return explicitRole
  }

  const groupName = stringValue(data.name)
  if (!groupName) {
    return null
  }

  return WORKOS_DIRECTORY_GROUP_ROLE_MAP[normalizeDirectoryRoleKey(groupName)] ?? null
}

function chooseHighestDirectoryRole(roles: PrivateBetaRole[]): PrivateBetaRole | null {
  for (const role of DIRECTORY_ROLE_PRIORITY) {
    if (roles.includes(role)) {
      return role
    }
  }
  return null
}

function profileRoleValue(value: unknown): ProfileRole | null {
  if (value === 'COMPANY' || value === 'ADMIN') {
    return value
  }
  return null
}

function getMembershipBetaRole(data: Record<string, unknown>): PrivateBetaRole | null {
  const role = asRecord(data.role)
  const primarySlug = stringValue(role?.slug)
  if (primarySlug && WORKOS_ROLE_MAP[primarySlug]) {
    return WORKOS_ROLE_MAP[primarySlug]
  }

  if (!Array.isArray(data.roles)) {
    return null
  }

  for (const roleValue of data.roles) {
    const roleRecord = asRecord(roleValue)
    const slug = stringValue(roleRecord?.slug)
    if (slug && WORKOS_ROLE_MAP[slug]) {
      return WORKOS_ROLE_MAP[slug]
    }
  }

  return null
}

function mapMembershipStatus(status: string | undefined): 'ACTIVE' | 'INACTIVE' {
  return status === 'active' ? 'ACTIVE' : 'INACTIVE'
}

function membershipUpdateIsStale(
  existingMembership:
    | {
        providerUpdatedAt?: number
        status?: 'ACTIVE' | 'INACTIVE'
      }
    | undefined,
  membershipStatus: 'ACTIVE' | 'INACTIVE',
  membershipTimestamp: number | undefined
): boolean {
  return (
    existingMembership?.providerUpdatedAt !== undefined &&
    ((membershipStatus === 'ACTIVE' && membershipTimestamp === undefined) ||
      (membershipTimestamp !== undefined &&
        (membershipTimestamp < existingMembership.providerUpdatedAt ||
          (membershipTimestamp === existingMembership.providerUpdatedAt &&
            existingMembership.status === 'INACTIVE' &&
            membershipStatus === 'ACTIVE'))))
  )
}

async function findProfileByUserId(
  ctx: MutationCtx,
  userId: Id<'users'>
): Promise<Doc<'profiles'> | null> {
  return await ctx.db
    .query('profiles')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .first()
}

async function findUserByEmail(ctx: MutationCtx, email: string): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', email))
    .first()
}

async function refreshCompanyAuthorizationInventoryForUser(ctx: MutationCtx, userId: Id<'users'>) {
  const profile = await findProfileByUserId(ctx, userId)
  if (!profile || profile.role !== 'COMPANY') return
  const companies = await ctx.db
    .query('companies')
    .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
    .collect()
  for (const company of companies) {
    await recordCompanyAuthorizationInventoryForCreation(ctx, company._id)
  }
}

async function persistProviderUserTombstone(ctx: MutationCtx, workosUserId: string) {
  const existing = await loadProviderUserTombstone(ctx, workosUserId)
  if (existing) return existing
  const deletedAt = Date.now()
  await ctx.db.insert('providerUserTombstones', {
    authProvider: 'workos',
    providerUserId: workosUserId,
    deletedAt,
  })
}

async function ensureWorkosUser(
  ctx: MutationCtx,
  workosUserId: string,
  options: {
    email?: string
    name?: string
    image?: string
    emailVerified?: boolean
    role?: ProfileRole
    existingUser?: Doc<'users'> | null
  } = {}
): Promise<Doc<'users'> | null> {
  // Un user.deleted previo, aunque no hubiera fila local, bloquea el alta.
  // WorkOS no reutiliza ids.
  if (await loadProviderUserTombstone(ctx, workosUserId)) return null

  const existing =
    'existingUser' in options
      ? options.existingUser
      : await findUserByProviderIdentifier(ctx, workosUserId)
  const email = options.email ?? syntheticIdentityEmail('workos', workosUserId)
  const patch = {
    authProvider: 'workos' as const,
    providerUserId: workosUserId,
    workosUserId,
    email,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.emailVerified !== undefined ? { emailVerified: options.emailVerified } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
  }

  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing
  }

  const userId = await ctx.db.insert('users', patch)
  const user = await ctx.db.get(userId)
  if (!user) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Error al sincronizar usuario WorkOS')
  }
  return user
}

// `user.deleted` es TERMINAL en WorkOS: los ids de usuario no se reutilizan y
// un usuario recreado colisiona por email (se salta el sync). Ningún evento
// posterior puede probar re-provisioning de ESE usuario, así que un hold
// PROVIDER con esta razón nunca se levanta por sync — solo una corrección
// manual del equipo lo revierte.
const WORKOS_USER_DELETED_DEACTIVATION_REASON = 'workos:user.deleted'

async function syncWorkosUser(ctx: MutationCtx, eventType: string, data: unknown) {
  const record = asRecord(data)
  const workosUserId = stringValue(record?.id)

  if (!record || !workosUserId) {
    return syncSkipped(eventType, data, 'WorkOS user payload missing id')
  }

  if (eventType === 'user.deleted') {
    await persistProviderUserTombstone(ctx, workosUserId)
    const user = await findUserByProviderIdentifier(ctx, workosUserId)
    if (!user) {
      return {
        action: 'workos_user_delete_noop',
        resourceId: workosUserId,
        details: `No local WorkOS user found for deleted user ${workosUserId}`,
        processed: true,
      }
    }

    const profile = await findProfileByUserId(ctx, user._id)
    // Marcar el ORIGEN de la desactivación: PROVIDER es sincronizable (un
    // evento autoritativo posterior puede reactivar). Si el perfil ya estaba
    // desactivado (p.ej. por un admin, AML), no pisar esa marca — el borrado
    // en el IdP no relaja una suspensión de plataforma.
    if (profile && profile.isActive !== false) {
      await ctx.db.patch(profile._id, {
        isActive: false,
        deactivatedBy: 'PROVIDER',
        deactivationReason: WORKOS_USER_DELETED_DEACTIVATION_REASON,
      })
    } else if (
      profile &&
      profile.deactivatedBy === 'PROVIDER' &&
      profile.deactivationReason !== WORKOS_USER_DELETED_DEACTIVATION_REASON
    ) {
      // Un hold PROVIDER previo (p.ej. deprovision de dsync) se ESCALA a
      // terminal: el borrado global del usuario es definitivo y ningún evento
      // de sync posterior debe poder levantarlo. ADMIN/USER y los holds legacy
      // sin marca no se tocan — ya son pegajosos por sí mismos.
      await ctx.db.patch(profile._id, {
        deactivationReason: WORKOS_USER_DELETED_DEACTIVATION_REASON,
      })
    }

    return {
      action: 'workos_user_deactivated',
      resourceId: workosUserId,
      details: `Deactivated local WorkOS user ${workosUserId}`,
      processed: true,
    }
  }

  const email = stringValue(record.email)
  if (!email) {
    return syncSkipped(eventType, data, 'WorkOS user payload missing email')
  }

  const existingUser = await findUserByProviderIdentifier(ctx, workosUserId)
  if (!existingUser) {
    const emailOwner = await findUserByEmail(ctx, email)
    if (emailOwner) {
      return {
        action: 'workos_user_email_collision',
        resourceId: workosUserId,
        // Sin el email: `result.details` se persiste en `webhookEvents` y lo lee el panel.
        details: `Skipped WorkOS user ${workosUserId} because its email is already linked to a different local user`,
        processed: false,
      }
    }
  }

  const user = await ensureWorkosUser(ctx, workosUserId, {
    email,
    name: fullName(stringValue(record.firstName), stringValue(record.lastName)),
    image: stringValue(record.profilePictureUrl),
    emailVerified: booleanValue(record.emailVerified),
    existingUser,
  })
  if (!user) {
    return {
      action: 'workos_user_deleted_ignored',
      resourceId: workosUserId,
      details: `Ignored WorkOS user ${workosUserId} after provider deletion`,
      processed: true,
    }
  }
  // Los eventos `user.*` de WorkOS NO son autoridad de rol: WorkOS no conoce el
  // rol de producto (COMPANY/ADMIN), que vive en `profiles.role` y se
  // fija en onboarding o desde el panel admin. Si dejáramos que este path
  // patchee el rol, cualquier `user.updated` (cambio de nombre, verificación de
  // email, reset de password) pisaría el rol real. El rol solo se usa aquí como
  // semilla al CREAR el perfil, y la semilla es COMPANY: el pivot sell-side
  // ([F] 2026-08-15, alta mínima automática) cerró el carril self-serve de
  // inversionista — todo signup nuevo es una empresa entrando por /mycroft.
  await ensureWorkosProfile(ctx, user, profileRoleValue(user.role) ?? 'COMPANY', {
    authoritativeRole: false,
  })
  await refreshCompanyAuthorizationInventoryForUser(ctx, user._id)

  return {
    action: 'workos_user_synced',
    resourceId: workosUserId,
    details: `Synced WorkOS user ${workosUserId}`,
    processed: true,
  }
}

async function ensureWorkosProfile(
  ctx: MutationCtx,
  user: Doc<'users'>,
  profileRole: ProfileRole,
  options: {
    authoritativeRole?: boolean
    providerActive?: boolean
  } = {}
): Promise<Doc<'profiles'>> {
  // `authoritativeRole` solo es true cuando el rol viene del IdP
  // (organization_membership.* / dsync.*). En el path `user.*` el rol local
  // manda y no debe pisarse.
  const authoritativeRole = options.authoritativeRole ?? true
  // `providerActive` distingue si el evento autoritativo refleja presencia
  // ACTIVA en el IdP: un membership con status inactivo (o fuera de orden) no
  // prueba re-provisioning y no puede levantar un hold PROVIDER.
  const providerActive = options.providerActive ?? true
  const existing = await findProfileByUserId(ctx, user._id)
  if (existing) {
    const patch: {
      role?: ProfileRole
      isActive?: boolean
      deactivatedBy?: 'ADMIN' | 'USER' | 'PROVIDER'
      deactivationReason?: string
    } = {}
    if (authoritativeRole && existing.role !== profileRole) {
      patch.role = profileRole
    }
    // Misma lógica que el rol: un evento `user.*` no es autoridad sobre el
    // estado de la cuenta. Sin este gate, cualquier `user.updated` (cambio de
    // foto, verificación de email, reset de password) reactiva un perfil que un
    // admin desactivó, y la desactivación no se sostiene.
    //
    // Y aun con rol autoritativo, el IdP solo puede revertir lo que el propio
    // IdP causó: únicamente una desactivación marcada PROVIDER (user.deleted /
    // deprovision de dsync) se reactiva sola. ADMIN (AML/fraude) y USER
    // (self-service) son pegajosas, y un perfil desactivado sin marca (legacy)
    // se trata como pegajoso — sin origen conocido, la reactivación es humana.
    //
    // Excepción dentro de PROVIDER: un hold por `user.deleted` es terminal
    // (WorkOS no reutiliza ids y un usuario recreado colisiona por email), así
    // que ningún evento posterior puede referirse legítimamente a ese usuario.
    // Solo un admin lo reactiva.
    if (
      authoritativeRole &&
      providerActive &&
      existing.isActive === false &&
      existing.deactivatedBy === 'PROVIDER' &&
      existing.deactivationReason !== WORKOS_USER_DELETED_DEACTIVATION_REASON
    ) {
      patch.isActive = true
      patch.deactivatedBy = undefined
      patch.deactivationReason = undefined
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, patch)
    }
    return existing
  }

  // El perfil NUEVO también respeta providerActive: un membership inactivo (o
  // stale) como primer evento de un usuario no crea un perfil admitido. Se
  // marca PROVIDER para que un re-provisioning verificado del IdP pueda
  // levantarlo solo (round-trip), sin intervención admin.
  const profileId = await ctx.db.insert('profiles', {
    userId: user._id,
    role: profileRole,
    language: 'es',
    timezone: 'America/Panama',
    emailNotifications: true,
    isVerified: false,
    isActive: providerActive,
    ...(providerActive ? {} : { deactivatedBy: 'PROVIDER' as const }),
    unreadMessageCount: 0,
  })
  const profile = await ctx.db.get(profileId)
  if (!profile) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Error al sincronizar perfil WorkOS')
  }
  return profile
}

// Resuelve la organización de una identidad de directorio: el mapping del hijo
// cuando existe, y si falta (payload dsync aceptado sin organizationId), la del
// directorio padre vía workosDirectoryId.
async function resolveDirectoryUserOrgId(
  ctx: MutationCtx,
  directoryUser: Doc<'workosDirectoryUsers'>
): Promise<string | undefined> {
  if (directoryUser.workosOrgId) {
    return directoryUser.workosOrgId
  }
  if (!directoryUser.workosDirectoryId) {
    return undefined
  }
  const directory = await ctx.db
    .query('workosDirectories')
    .withIndex('by_directoryId', (q) => q.eq('directoryId', directoryUser.workosDirectoryId))
    .first()
  return directory?.workosOrgId
}

// Un membership `active` que llega DESPUÉS de un deprovision de dsync (fuera
// de orden o reintentado en cola) no prueba presencia vigente en el IdP: si el
// usuario tiene identidades de directorio EN ESA organización y ninguna está
// efectivamente activa, dsync ya lo dio de baja allí y el evento es stale.
//
// Dos matices deliberados:
// - Alcance por organización: una identidad deprovisionada en la org A no
//   convierte en stale un membership legítimo de la org B (p.ej. alta directa
//   sin dsync); sin identidades de directorio en la org del evento no hay
//   señal dsync y el status del membership manda. La org de cada identidad se
//   resuelve vía el hijo o su directorio padre; una identidad cuya org no
//   puede resolverse no prueba ser ajena a la org del evento y cuenta como
//   señal dsync (fail-closed).
// - "Activa" es VERIFICADA contra el padre: una identidad marcada activa por
//   un dsync.user.* retrasado tras un dsync.deactivated no cuenta si el
//   directorio padre almacenado sigue inactivo (fail-closed vía
//   isWorkosDirectoryActive).
//
// Ordenación causal (`membershipTimestamp`): la señal dsync no puede vetar la
// org para siempre. Si el objeto membership del payload es POSTERIOR a todos
// los deprovisions dsync almacenados en esa org, no es un evento retrasado
// sino un alta directa NUEVA tras el deprovision — el round-trip legítimo del
// IdP — y sí prueba presencia. Fail-closed: sin timestamp en el payload o sin
// momento de deprovision almacenado, el evento sigue tratándose como stale.
async function isDsyncDeprovisioned(
  ctx: MutationCtx,
  userId: Id<'users'>,
  workosOrgId: string,
  membershipTimestamp?: number
): Promise<boolean> {
  const allDirectoryUsers = await ctx.db
    .query('workosDirectoryUsers')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect()
  const directoryUsers: typeof allDirectoryUsers = []
  for (const directoryUser of allDirectoryUsers) {
    const resolvedOrgId = await resolveDirectoryUserOrgId(ctx, directoryUser)
    if (resolvedOrgId === undefined || resolvedOrgId === workosOrgId) {
      directoryUsers.push(directoryUser)
    }
  }
  if (directoryUsers.length === 0) {
    return false
  }
  for (const directoryUser of directoryUsers) {
    if (
      directoryUser.active === true &&
      (await isWorkosDirectoryActive(ctx, directoryUser.workosDirectoryId))
    ) {
      return false
    }
  }
  if (membershipTimestamp !== undefined) {
    const postdatesEveryDeprovision = directoryUsers.every((directoryUser) => {
      const deprovisionedAt = directoryUser.deprovisionedAt ?? directoryUser.updatedAt
      return deprovisionedAt !== undefined && deprovisionedAt < membershipTimestamp
    })
    if (postdatesEveryDeprovision) {
      return false
    }
  }
  return true
}

async function loadMembershipTombstonesById(ctx: MutationCtx, membershipId: string) {
  return await ctx.db
    .query('organizationMembershipTombstones')
    .withIndex('by_providerMembershipId', (q) =>
      q.eq('authProvider', 'workos').eq('providerMembershipId', membershipId)
    )
    .collect()
}

async function loadMembershipTombstonesForIdentity(
  ctx: MutationCtx,
  input: { membershipId: string; workosOrgId: string; workosUserId: string }
) {
  const [byMembershipId, byOrganizationUser] = await Promise.all([
    loadMembershipTombstonesById(ctx, input.membershipId),
    ctx.db
      .query('organizationMembershipTombstones')
      .withIndex('by_providerOrgUser', (q) =>
        q
          .eq('authProvider', 'workos')
          .eq('providerOrgId', input.workosOrgId)
          .eq('providerUserId', input.workosUserId)
      )
      .collect(),
  ])
  return [...byMembershipId, ...byOrganizationUser].filter(
    (tombstone, index, rows) =>
      rows.findIndex((candidate) => candidate._id === tombstone._id) === index
  )
}

async function persistMembershipTombstone(
  ctx: MutationCtx,
  input: {
    membershipId: string
    workosOrgId: string
    workosUserId: string
    membershipTimestamp?: number
  }
) {
  const tombstones = await loadMembershipTombstonesById(ctx, input.membershipId)
  if (
    tombstones.some(
      (row) => row.providerOrgId !== input.workosOrgId || row.providerUserId !== input.workosUserId
    )
  ) {
    // A provider membership id is immutable. Conflicting locators are corrupt
    // evidence and must never be allowed to rewrite or weaken the tombstone.
    return { stale: true, conflict: true, tombstone: tombstones[0] }
  }

  const unresolved = tombstones.find((row) => row.providerUpdatedAt === undefined)
  const strongestTimestamp = tombstones.reduce<number | undefined>((current, tombstone) => {
    if (tombstone.providerUpdatedAt === undefined) return current
    return current === undefined
      ? tombstone.providerUpdatedAt
      : Math.max(current, tombstone.providerUpdatedAt)
  }, undefined)
  const strongest =
    unresolved ??
    tombstones.find((row) => row.providerUpdatedAt === strongestTimestamp) ??
    tombstones[0]
  if (
    !unresolved &&
    strongestTimestamp !== undefined &&
    input.membershipTimestamp !== undefined &&
    input.membershipTimestamp < strongestTimestamp
  ) {
    return { stale: true, conflict: false, tombstone: strongest }
  }

  const patch = {
    authProvider: 'workos' as const,
    providerMembershipId: input.membershipId,
    providerOrgId: input.workosOrgId,
    providerUserId: input.workosUserId,
    // An unknown provider timestamp is stronger than any locally comparable
    // watermark. Once present, keep it unresolved until an explicit repair;
    // another timestamped delivery cannot safely assign it an order.
    providerUpdatedAt:
      unresolved || input.membershipTimestamp === undefined
        ? undefined
        : Math.max(strongestTimestamp ?? 0, input.membershipTimestamp),
    deletedAt: Date.now(),
  }
  if (strongest) {
    await ctx.db.patch(strongest._id, patch)
    for (const duplicate of tombstones.filter((row) => row._id !== strongest._id)) {
      await ctx.db.delete(duplicate._id)
    }
    return { stale: false, conflict: false, tombstone: { ...strongest, ...patch } }
  }

  const tombstoneId = await ctx.db.insert('organizationMembershipTombstones', patch)
  return { stale: false, conflict: false, tombstone: { _id: tombstoneId, ...patch } }
}

async function syncWorkosMembership(ctx: MutationCtx, eventType: string, data: unknown) {
  const record = asRecord(data)
  const membershipId = stringValue(record?.id)
  const workosUserId = stringValue(record?.userId)
  const workosOrgId = stringValue(record?.organizationId)

  if (!record || !membershipId || !workosUserId || !workosOrgId) {
    return syncSkipped(eventType, data, 'WorkOS membership payload missing required ids')
  }

  // Timestamp del OBJETO membership (no de la entrega). También se persiste
  // para deletes: de otro modo un `updated` activo anterior, entregado tarde,
  // podría revivir una autorización ya revocada.
  const membershipCreatedAt = timestampValueFrom(record, 'createdAt', 'created_at')
  const membershipUpdatedAt = timestampValueFrom(record, 'updatedAt', 'updated_at')
  const membershipTimestamp =
    membershipCreatedAt !== undefined || membershipUpdatedAt !== undefined
      ? Math.max(membershipCreatedAt ?? 0, membershipUpdatedAt ?? 0)
      : undefined
  const membershipStatus = mapMembershipStatus(stringValue(record.status))

  if (eventType === 'organization_membership.deleted') {
    const exactMemberships = await ctx.db
      .query('organizationMemberships')
      .withIndex('by_providerMembershipId', (q) =>
        q.eq('authProvider', 'workos').eq('providerMembershipId', membershipId)
      )
      .collect()
    if (
      exactMemberships.length > 0 &&
      membershipTimestamp !== undefined &&
      exactMemberships.every(
        (membership) =>
          membership.providerUpdatedAt !== undefined &&
          membership.providerUpdatedAt > membershipTimestamp
      )
    ) {
      return {
        action: 'workos_membership_stale_ignored',
        resourceId: workosOrgId,
        details: `Ignored WorkOS membership delete ${membershipId} predating stored provider evidence`,
        processed: true,
      }
    }

    const tombstone = await persistMembershipTombstone(ctx, {
      membershipId,
      workosOrgId,
      workosUserId,
      membershipTimestamp,
    })
    if (tombstone.stale) {
      return {
        action: 'workos_membership_stale_ignored',
        resourceId: workosOrgId,
        details: `Ignored WorkOS membership delete ${membershipId} predating stored provider evidence`,
        processed: true,
      }
    }

    const user = await findUserByProviderIdentifier(ctx, workosUserId)
    const legacyMemberships =
      exactMemberships.length === 0 && user
        ? (
            await ctx.db
              .query('organizationMemberships')
              .withIndex('by_providerOrgId', (q) =>
                q.eq('authProvider', 'workos').eq('providerOrgId', workosOrgId)
              )
              .collect()
          ).filter(
            (membership) =>
              membership.userId === user._id && membership.providerMembershipId === undefined
          )
        : []
    const affectedMemberships = exactMemberships.length > 0 ? exactMemberships : legacyMemberships
    const affectedUserIds = new Set<Id<'users'>>(user ? [user._id] : [])

    for (const existingMembership of affectedMemberships) {
      if (
        membershipTimestamp !== undefined &&
        existingMembership.providerUpdatedAt !== undefined &&
        membershipTimestamp < existingMembership.providerUpdatedAt
      ) {
        continue
      }
      await ctx.db.patch(existingMembership._id, {
        status: 'INACTIVE',
        ...(membershipTimestamp !== undefined ? { providerUpdatedAt: membershipTimestamp } : {}),
        updatedAt: Date.now(),
      })
      affectedUserIds.add(existingMembership.userId)
    }

    // Membership deletion is an authorization revocation, not only an org-row
    // update. The helper is multi-org aware and only deactivates the profile
    // when no other verified WorkOS presence remains.
    for (const affectedUserId of affectedUserIds) {
      await deactivateProfileFromProvider(ctx, affectedUserId)
    }

    if (!user && affectedMemberships.length === 0) {
      return {
        action: 'workos_membership_tombstoned',
        resourceId: workosOrgId,
        details: `Tombstoned WorkOS membership ${membershipId} before local provisioning`,
        processed: true,
      }
    }

    return {
      action: 'workos_membership_deactivated',
      resourceId: workosOrgId,
      details: `Deactivated WorkOS membership ${membershipId}`,
      processed: true,
    }
  }

  const tombstones = await loadMembershipTombstonesForIdentity(ctx, {
    membershipId,
    workosOrgId,
    workosUserId,
  })
  if (membershipStatus === 'ACTIVE' && tombstones.length > 0) {
    const hasUnknownTimestamp = tombstones.some(
      (tombstone) => tombstone.providerUpdatedAt === undefined
    )
    const strongestTimestamp = tombstones.reduce<number | undefined>((current, tombstone) => {
      if (tombstone.providerUpdatedAt === undefined) return current
      return current === undefined
        ? tombstone.providerUpdatedAt
        : Math.max(current, tombstone.providerUpdatedAt)
    }, undefined)
    if (
      hasUnknownTimestamp ||
      strongestTimestamp === undefined ||
      membershipTimestamp === undefined ||
      membershipTimestamp <= strongestTimestamp
    ) {
      return {
        action: 'workos_membership_stale_ignored',
        resourceId: workosOrgId,
        details: `Ignored WorkOS membership event ${membershipId} not newer than deletion evidence`,
        processed: true,
      }
    }
  }

  const user = await findUserByProviderIdentifier(ctx, workosUserId)

  // El watermark se resuelve antes de cualquier retorno. Un updated INACTIVE
  // que no es stale deja el tombstone aunque después se salte el rol, la
  // evidencia duplicada, la identidad o un usuario ya borrado. Un evento
  // stale no escribe: la fila puede seguir ACTIVE.
  const exactMemberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_providerMembershipId', (q) =>
      q.eq('authProvider', 'workos').eq('providerMembershipId', membershipId)
    )
    .take(2)
  const organizationMemberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_providerOrgId', (q) =>
      q.eq('authProvider', 'workos').eq('providerOrgId', workosOrgId)
    )
    .collect()
  const watermarkMembership =
    exactMemberships.length === 1
      ? exactMemberships[0]
      : exactMemberships.length === 0
        ? organizationMemberships.find(
            (membership) =>
              user !== null &&
              membership.userId === user._id &&
              membership.providerMembershipId === undefined
          )
        : undefined
  if (
    membershipStatus === 'INACTIVE' &&
    !membershipUpdateIsStale(watermarkMembership, membershipStatus, membershipTimestamp)
  ) {
    await persistMembershipTombstone(ctx, {
      membershipId,
      workosOrgId,
      workosUserId,
      membershipTimestamp,
    })
  }

  if (await loadProviderUserTombstone(ctx, workosUserId)) {
    return {
      action: 'workos_user_deleted_ignored',
      resourceId: workosOrgId,
      details: `Ignored WorkOS membership ${membershipId} for deleted user ${workosUserId}`,
      processed: true,
    }
  }

  const betaRole = getMembershipBetaRole(record)
  if (!betaRole) {
    return syncSkipped(
      eventType,
      data,
      `WorkOS membership ${membershipId} has no mapped Sherlock beta role`
    )
  }

  const profileRole = mapBetaRoleToProfileRole(betaRole)
  const ensuredUser = user ?? (await ensureWorkosUser(ctx, workosUserId, { role: profileRole }))
  if (!ensuredUser) {
    return {
      action: 'workos_user_deleted_ignored',
      resourceId: workosOrgId,
      details: `Ignored WorkOS membership ${membershipId} for deleted user ${workosUserId}`,
      processed: true,
    }
  }
  const localUser = ensuredUser

  // Solo un membership ACTIVO prueba presencia vigente en el IdP: un evento
  // con status inactivo (o llegado fuera de orden tras un deprovision) no debe
  // levantar un hold PROVIDER del perfil. Y aun con status activo, el estado
  // ALMACENADO manda: si dsync ya deprovisionó todas las identidades de
  // directorio del usuario, el evento es stale y tampoco levanta el hold.
  if (exactMemberships.length > 1) {
    return {
      action: 'workos_membership_stale_ignored',
      resourceId: workosOrgId,
      details: `Ignored WorkOS membership event ${membershipId} because local evidence is duplicated`,
      processed: true,
    }
  }
  const exactMembership = exactMemberships[0]
  if (
    exactMembership &&
    (exactMembership.userId !== localUser._id || exactMembership.providerOrgId !== workosOrgId)
  ) {
    return {
      action: 'workos_membership_stale_ignored',
      resourceId: workosOrgId,
      details: `Ignored WorkOS membership event ${membershipId} because provider identity changed`,
      processed: true,
    }
  }
  const existingMembership =
    exactMembership ??
    organizationMemberships.find(
      (membership) =>
        membership.userId === localUser._id && membership.providerMembershipId === undefined
    )

  // Watermark monotónico (providerUpdatedAt): un evento membership
  // ESTRICTAMENTE anterior a la evidencia causal ya persistida es una entrega
  // retrasada con estado viejo. El tombstone de un INACTIVE no stale ya se
  // escribió arriba; este retorno sigue descartando el patch. Un updated
  // inactivo más viejo no puede dejar tombstone con la fila todavía ACTIVE.
  // No es autoridad de rol (no puede re-rolear users/profiles), no puede tocar
  // el hold del perfil vía ensureWorkosProfile, y si pisara la fila (T1 sobre
  // T3), el watermark retrocedería y un deprovision dsync intermedio (T2)
  // entregado después tumbaría membership y perfil legítimos. Un evento sin
  // timestamps se aplica como siempre (y no toca el watermark almacenado); uno
  // con timestamp igual sigue aplicándose idempotente salvo que intente pasar
  // de INACTIVE a ACTIVE: un delete gana el empate y un regrant debe ser
  // estrictamente posterior.
  if (membershipUpdateIsStale(existingMembership, membershipStatus, membershipTimestamp)) {
    return {
      action: 'workos_membership_stale_ignored',
      resourceId: workosOrgId,
      details: `Ignored WorkOS membership event ${membershipId} predating stored provider evidence`,
      processed: true,
    }
  }

  const dsyncStale =
    membershipStatus === 'ACTIVE' &&
    (await isDsyncDeprovisioned(ctx, localUser._id, workosOrgId, membershipTimestamp))
  const providerActive = membershipStatus === 'ACTIVE' && !dsyncStale

  // Un evento stale tampoco es autoridad de rol: no puede re-rolear (usuario o
  // perfil) a alguien que sigue vivo a través de otra organización.
  if (!dsyncStale && localUser.role !== profileRole) {
    await ctx.db.patch(localUser._id, { role: profileRole })
  }
  const profile = await ensureWorkosProfile(ctx, localUser, profileRole, {
    authoritativeRole: !dsyncStale,
    providerActive,
  })

  const membershipPatch = {
    userId: localUser._id,
    profileId: profile._id,
    authProvider: 'workos' as const,
    providerMembershipId: membershipId,
    providerOrgId: workosOrgId,
    workosOrgId,
    name: stringValue(record.organizationName),
    betaRole,
    profileRole,
    // Un evento stale (status activo que contradice el estado dsync
    // almacenado) tampoco puede persistir la membership como ACTIVE: una
    // membership activa autoriza superficies downstream (p.ej. el admin
    // portal de WorkOS vía getMyMembershipForOrg).
    status: dsyncStale ? ('INACTIVE' as const) : membershipStatus,
    // Evidencia causal persistida: un deprovision dsync entregado DESPUÉS
    // pero anterior según el proveedor no debe tumbar esta membership.
    ...(membershipTimestamp !== undefined ? { providerUpdatedAt: membershipTimestamp } : {}),
    updatedAt: Date.now(),
  }

  if (existingMembership) {
    await ctx.db.patch(existingMembership._id, membershipPatch)
  } else {
    await ctx.db.insert('organizationMemberships', {
      ...membershipPatch,
      createdAt: Date.now(),
    })
  }

  if (membershipPatch.status === 'INACTIVE') {
    await deactivateProfileFromProvider(ctx, localUser._id)
  }
  await refreshCompanyAuthorizationInventoryForUser(ctx, localUser._id)

  // A strictly newer provider regrant supersedes delete-first evidence. Delete
  // it only after the membership/profile writes above succeeded in this same
  // transaction; unresolved tombstones otherwise have no TTL and are retained.
  if (membershipStatus === 'ACTIVE' && !dsyncStale) {
    for (const tombstone of tombstones) await ctx.db.delete(tombstone._id)
  }

  return {
    action: 'workos_membership_synced',
    resourceId: workosOrgId,
    details: `Synced WorkOS membership ${membershipId}`,
    processed: true,
  }
}

async function findDirectoryUserById(ctx: MutationCtx, directoryUserId: string) {
  return await ctx.db
    .query('workosDirectoryUsers')
    .withIndex('by_directoryUserId', (q) => q.eq('directoryUserId', directoryUserId))
    .first()
}

// Estado VERIFICADO del directorio, no asumido: el hold PROVIDER de un perfil
// solo puede levantarse cuando el directorio padre sigue activo. Fail-closed si
// el directorio no existe localmente — sin evidencia de directorio activo, la
// reactivación no procede (dsync.activated siempre llega antes que sus users).
async function isWorkosDirectoryActive(ctx: MutationCtx, workosDirectoryId: string | undefined) {
  if (!workosDirectoryId) {
    return false
  }
  const directory = await ctx.db
    .query('workosDirectories')
    .withIndex('by_directoryId', (q) => q.eq('directoryId', workosDirectoryId))
    .first()
  return directory?.active === true
}

async function findDirectoryGroupById(ctx: MutationCtx, directoryGroupId: string) {
  return await ctx.db
    .query('workosDirectoryGroups')
    .withIndex('by_directoryGroupId', (q) => q.eq('directoryGroupId', directoryGroupId))
    .first()
}

async function syncWorkosDirectory(ctx: MutationCtx, eventType: string, data: unknown) {
  const record = asRecord(data)
  const directoryId = stringValue(record?.id)

  if (!record || !directoryId) {
    return syncSkipped(eventType, data, 'WorkOS directory payload missing id')
  }

  const now = Date.now()
  const stateValue =
    stringValue(record.state) ??
    (eventType === 'dsync.activated'
      ? 'active'
      : eventType === 'dsync.deactivated'
        ? 'inactive'
        : undefined)
  const state = normalizeDirectoryState(stateValue, eventType === 'dsync.deleted')
  const active = state === 'ACTIVE'
  // Timestamp del OBJETO directory según el PROVEEDOR (no de la entrega):
  // watermark causal para ordenar activaciones y shutdowns entregados fuera
  // de orden, y momento del shutdown para la ordenación de memberships.
  const directoryTimestamp = timestampValueFrom(record, 'updatedAt', 'updated_at')
  const patch = {
    directoryId,
    ...(stringValueFrom(record, 'organizationId', 'organization_id')
      ? { workosOrgId: stringValueFrom(record, 'organizationId', 'organization_id') }
      : {}),
    ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
    ...(stringValue(record.type) ? { type: stringValue(record.type) } : {}),
    ...(stringArrayValue(record.domains) ? { domains: stringArrayValue(record.domains) } : {}),
    state,
    active,
    ...(directoryTimestamp !== undefined ? { providerUpdatedAt: directoryTimestamp } : {}),
    updatedAt: now,
    ...(state === 'DELETED' ? { deletedAt: now } : {}),
  }

  const existing = await ctx.db
    .query('workosDirectories')
    .withIndex('by_directoryId', (q) => q.eq('directoryId', directoryId))
    .first()

  // Ordenación causal también para el DIRECTORIO: un evento ESTRICTAMENTE
  // anterior al watermark del proveedor ya persistido es una entrega retrasada
  // y se descarta entero. Sin este orden, un dsync.deactivated viejo (T1)
  // llegado después de la re-activación (T3) marcaría cada hijo como inactivo
  // con un deprovisionedAt viejo y tumbaría sus perfiles con marca PROVIDER.
  // Un evento sin timestamp se aplica como siempre (fail-closed en la
  // dirección de desactivación) y no toca el watermark almacenado.
  if (
    directoryTimestamp !== undefined &&
    existing?.providerUpdatedAt !== undefined &&
    directoryTimestamp < existing.providerUpdatedAt
  ) {
    return {
      action: 'workos_directory_stale_ignored',
      resourceId: directoryId,
      details: `Ignored WorkOS directory event for ${directoryId} predating stored provider evidence`,
      processed: true,
    }
  }

  if (existing) {
    await ctx.db.patch(existing._id, patch)
  } else {
    await ctx.db.insert('workosDirectories', {
      ...patch,
      createdAt: now,
    })
  }

  if (!active) {
    const directoryUsers = await ctx.db
      .query('workosDirectoryUsers')
      .withIndex('by_workosDirectoryId', (q) => q.eq('workosDirectoryId', directoryId))
      .collect()

    // La org del shutdown se resuelve también vía el PADRE (payload o fila
    // almacenada): una identidad guardada sin workosOrgId propio dejaría el
    // fallback por org sin ejecutar y una membership directa de esa misma org
    // quedaría ACTIVE, bloqueando la desactivación del perfil.
    const directoryOrgId =
      stringValueFrom(record, 'organizationId', 'organization_id') ?? existing?.workosOrgId
    // Momento del shutdown según el PROVEEDOR cuando el payload lo trae: una
    // membership otorgada después del shutdown pero procesada antes de esta
    // entrega tardía no debe tumbarse (entrega invertida).
    const shutdownTimestamp = directoryTimestamp

    for (const directoryUser of directoryUsers) {
      await ctx.db.patch(directoryUser._id, {
        active: false,
        state,
        updatedAt: now,
        deprovisionedAt: shutdownTimestamp ?? now,
      })
      await deactivateOrganizationMembershipsForDirectoryUser(
        ctx,
        directoryUser.directoryUserId,
        directoryUser.userId,
        directoryUser.workosOrgId ?? directoryOrgId,
        shutdownTimestamp
      )
      // Un shutdown de directorio completo (dsync.deactivated/deleted) es un
      // deprovision de origen IdP para cada usuario del directorio: el perfil
      // también tiene que caer, igual que en `deprovisionDirectoryUser`.
      await deactivateProfileFromProvider(ctx, directoryUser.userId)
    }
  }

  return {
    action: active ? 'workos_directory_synced' : 'workos_directory_deactivated',
    resourceId: directoryId,
    details: `Synced WorkOS directory ${directoryId}`,
    processed: true,
  }
}

async function upsertWorkosDirectoryGroup(
  ctx: MutationCtx,
  data: Record<string, unknown>,
  options: { deleted?: boolean } = {}
) {
  const directoryGroupId = stringValue(data.id)
  const workosDirectoryId = stringValueFrom(data, 'directoryId', 'directory_id')

  if (!directoryGroupId || !workosDirectoryId) {
    return null
  }

  const now = Date.now()
  const state = normalizeDirectoryState(
    stringValue(data.state) ?? (options.deleted ? undefined : 'active'),
    options.deleted
  )
  const active = state === 'ACTIVE'
  const mappedBetaRole = getDirectoryGroupBetaRole(data)
  const patch = {
    directoryGroupId,
    workosDirectoryId,
    ...(stringValueFrom(data, 'organizationId', 'organization_id')
      ? { workosOrgId: stringValueFrom(data, 'organizationId', 'organization_id') }
      : {}),
    ...(stringValue(data.name) ? { name: stringValue(data.name) } : {}),
    state,
    active,
    ...(mappedBetaRole ? { mappedBetaRole } : {}),
    updatedAt: now,
    ...(state === 'DELETED' ? { deletedAt: now } : {}),
  }

  const existing = await findDirectoryGroupById(ctx, directoryGroupId)
  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return { ...existing, ...patch }
  }

  const id = await ctx.db.insert('workosDirectoryGroups', {
    ...patch,
    createdAt: now,
  })
  const inserted = await ctx.db.get(id)
  return inserted ?? { _id: id, ...patch, createdAt: now }
}

async function syncWorkosDirectoryGroup(ctx: MutationCtx, eventType: string, data: unknown) {
  const record = asRecord(data)
  const directoryGroupId = stringValue(record?.id)

  if (!record || !directoryGroupId) {
    return syncSkipped(eventType, data, 'WorkOS directory group payload missing id')
  }

  const group = await upsertWorkosDirectoryGroup(ctx, record, {
    deleted: eventType === 'dsync.group.deleted',
  })
  if (!group) {
    return syncSkipped(eventType, data, 'WorkOS directory group payload missing directory id')
  }

  if (eventType === 'dsync.group.deleted') {
    const activeMemberships = await ctx.db
      .query('workosDirectoryGroupMemberships')
      .withIndex('by_directoryGroupId_active', (q) =>
        q.eq('directoryGroupId', directoryGroupId).eq('active', true)
      )
      .collect()

    for (const membership of activeMemberships) {
      await ctx.db.patch(membership._id, {
        active: false,
        updatedAt: Date.now(),
        removedAt: Date.now(),
      })
      await refreshOrganizationMembershipForDirectoryUser(
        ctx,
        membership.directoryUserId,
        membership.workosOrgId
      )
    }

    return {
      action: 'workos_directory_group_deactivated',
      resourceId: directoryGroupId,
      details: `Synced WorkOS directory group ${directoryGroupId}`,
      processed: true,
    }
  }

  return {
    action: 'workos_directory_group_synced',
    resourceId: directoryGroupId,
    details: `Synced WorkOS directory group ${directoryGroupId}`,
    processed: true,
  }
}

async function upsertWorkosDirectoryUser(
  ctx: MutationCtx,
  data: Record<string, unknown>,
  options: { profileRole?: ProfileRole; ensureLocalUser?: boolean; deleted?: boolean } = {}
) {
  const directoryUserId = stringValue(data.id)
  const workosDirectoryId = stringValueFrom(data, 'directoryId', 'directory_id')

  if (!directoryUserId || !workosDirectoryId) {
    return null
  }

  const now = Date.now()
  const existing = await findDirectoryUserById(ctx, directoryUserId)
  // Sin `state` explícito en el payload, el estado guardado es pegajoso: un
  // evento retrasado (p.ej. dsync.group.user_added tras dsync.user.deleted) no
  // puede re-activar por defecto a un directory user ya deprovisionado. El
  // default 'active' solo aplica a usuarios nunca vistos.
  const explicitState = stringValue(data.state)
  // Y un `state` explícitamente activo también se ordena CAUSALMENTE contra la
  // evidencia de deprovision almacenada: un dsync.group.user_added retrasado
  // que embebe al hijo con state 'active' tras un dsync.user.deleted ya
  // aplicado no prueba re-provisioning aunque el directorio padre siga activo.
  // Solo un evento cuyos timestamps del proveedor POSTDATAN el deprovisionedAt
  // guardado (round-trip legítimo del IdP) revierte el estado; sin timestamps
  // en el payload, fail-closed: el evento se trata como stale y el estado
  // guardado manda.
  const eventCreatedAt = timestampValueFrom(data, 'createdAt', 'created_at')
  const eventUpdatedAt = timestampValueFrom(data, 'updatedAt', 'updated_at')
  const eventTimestamp =
    eventCreatedAt !== undefined || eventUpdatedAt !== undefined
      ? Math.max(eventCreatedAt ?? 0, eventUpdatedAt ?? 0)
      : undefined
  const storedDeprovisionedAt =
    existing && existing.active === false
      ? (existing.deprovisionedAt ?? existing.updatedAt)
      : undefined
  const staleExplicitActive =
    !options.deleted &&
    normalizeDirectoryState(explicitState) === 'ACTIVE' &&
    storedDeprovisionedAt !== undefined &&
    !(eventTimestamp !== undefined && eventTimestamp > storedDeprovisionedAt)
  const fallbackState = options.deleted
    ? undefined
    : existing
      ? existing.active
        ? 'active'
        : 'inactive'
      : 'active'
  const state = normalizeDirectoryState(
    (staleExplicitActive ? undefined : explicitState) ?? fallbackState,
    options.deleted
  )
  const active = state === 'ACTIVE'
  const email = stringValue(data.email)
  const workosUserId = stringValueFrom(data, 'userId', 'user_id', 'workosUserId') ?? directoryUserId
  let localUser: Doc<'users'> | null = null

  if (options.ensureLocalUser && email && active) {
    // Estado VERIFICADO también como autoridad de rol: un hijo explícitamente
    // activo embebido en un evento retrasado tras la desactivación del
    // directorio padre no levanta el hold PROVIDER ni reescribe users.role /
    // profiles.role (ensureWorkosUser parchea role en usuarios existentes).
    const parentDirectoryActive = await isWorkosDirectoryActive(ctx, workosDirectoryId)
    const existingUser = await findUserByProviderIdentifier(ctx, workosUserId)
    const emailOwner = existingUser ? null : await findUserByEmail(ctx, email)
    if (!emailOwner) {
      localUser = await ensureWorkosUser(ctx, workosUserId, {
        email,
        name: fullName(
          stringValueFrom(data, 'firstName', 'first_name'),
          stringValueFrom(data, 'lastName', 'last_name')
        ),
        ...(parentDirectoryActive ? { role: options.profileRole } : {}),
        existingUser,
      })
    }
    if (
      options.profileRole &&
      localUser &&
      parentDirectoryActive &&
      localUser.role !== options.profileRole
    ) {
      await ctx.db.patch(localUser._id, { role: options.profileRole })
    }
    if (options.profileRole && localUser) {
      // El hold PROVIDER solo se levanta con estado verificado: user activo
      // (explícito o confirmado arriba) Y directorio padre activo.
      await ensureWorkosProfile(ctx, localUser, options.profileRole, {
        authoritativeRole: parentDirectoryActive,
        providerActive: parentDirectoryActive,
      })
    }
  } else {
    localUser = await findUserByProviderIdentifier(ctx, workosUserId)
  }

  const patch = {
    directoryUserId,
    workosDirectoryId,
    ...(stringValueFrom(data, 'organizationId', 'organization_id')
      ? { workosOrgId: stringValueFrom(data, 'organizationId', 'organization_id') }
      : {}),
    ...(workosUserId ? { workosUserId } : {}),
    ...(localUser ? { userId: localUser._id } : {}),
    ...(email ? { email } : {}),
    ...(stringValueFrom(data, 'firstName', 'first_name')
      ? { firstName: stringValueFrom(data, 'firstName', 'first_name') }
      : {}),
    ...(stringValueFrom(data, 'lastName', 'last_name')
      ? { lastName: stringValueFrom(data, 'lastName', 'last_name') }
      : {}),
    state,
    active,
    updatedAt: now,
    // El watermark de deprovision queda FIJADO mientras la fila siga
    // inactiva: solo la transición activa→inactiva (o una fila nueva) estampa
    // uno nuevo. Moverlo hacia adelante con cada evento redundante vetaría
    // re-altas legítimas otorgadas entre el deprovision real y la entrega
    // tardía; un deprovision genuinamente posterior lo corrige después vía
    // `deprovisionDirectoryUser` con el timestamp del proveedor.
    ...(!active
      ? {
          deprovisionedAt:
            existing && existing.active === false
              ? (existing.deprovisionedAt ?? existing.updatedAt ?? now)
              : now,
        }
      : {}),
  }

  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return { ...existing, ...patch }
  }

  const id = await ctx.db.insert('workosDirectoryUsers', {
    ...patch,
    createdAt: now,
  })
  const inserted = await ctx.db.get(id)
  return inserted ?? { _id: id, ...patch, createdAt: now }
}

async function syncWorkosDirectoryUser(ctx: MutationCtx, eventType: string, data: unknown) {
  const record = asRecord(data)
  const directoryUserId = stringValue(record?.id)

  if (!record || !directoryUserId) {
    return syncSkipped(eventType, data, 'WorkOS directory user payload missing id')
  }

  // Watermark PREVIO al upsert: si la identidad ya estaba deprovisionada, un
  // evento retrasado que no POSTDATA esa evidencia no re-ejecuta el
  // deprovision con su timestamp viejo. Si lo hiciera, `deprovisionedAt`
  // retrocedería y una réplica apenas más nueva (pero aún anterior al
  // deprovision real) pasaría a postdatar el watermark y levantaría el hold.
  const priorDirectoryUser = await findDirectoryUserById(ctx, directoryUserId)
  const priorDeprovisionedAt =
    priorDirectoryUser && priorDirectoryUser.active === false
      ? (priorDirectoryUser.deprovisionedAt ?? priorDirectoryUser.updatedAt)
      : undefined

  const directoryUser = await upsertWorkosDirectoryUser(ctx, record, {
    deleted: eventType === 'dsync.user.deleted',
  })
  if (!directoryUser) {
    return syncSkipped(eventType, data, 'WorkOS directory user payload missing directory id')
  }

  if (eventType === 'dsync.user.deleted' || directoryUser.active === false) {
    const eventTimestamp = timestampValueFrom(record, 'updatedAt', 'updated_at')
    const staleRedelivery =
      priorDeprovisionedAt !== undefined &&
      !(eventTimestamp !== undefined && eventTimestamp > priorDeprovisionedAt)
    if (!staleRedelivery) {
      await deprovisionDirectoryUser(
        ctx,
        directoryUser.directoryUserId,
        directoryUser.workosOrgId,
        eventTimestamp
      )
    }
    return {
      action: 'workos_directory_user_deprovisioned',
      resourceId: directoryUserId,
      details: staleRedelivery
        ? `Ignored stale Directory Sync event for already deprovisioned user ${directoryUserId}`
        : `Deprovisioned Directory Sync user ${directoryUserId}`,
      processed: true,
    }
  }

  return {
    action: 'workos_directory_user_synced',
    resourceId: directoryUserId,
    details: `Synced WorkOS directory user ${directoryUserId}`,
    processed: true,
  }
}

async function findDirectoryGroupMembership(
  ctx: MutationCtx,
  directoryUserId: string,
  directoryGroupId: string
) {
  const memberships = await ctx.db
    .query('workosDirectoryGroupMemberships')
    .withIndex('by_directoryUserId', (q) => q.eq('directoryUserId', directoryUserId))
    .collect()

  return memberships.find((membership) => membership.directoryGroupId === directoryGroupId) ?? null
}

async function upsertDirectoryGroupMembership(
  ctx: MutationCtx,
  input: {
    workosDirectoryId: string
    workosOrgId?: string
    directoryUserId: string
    directoryGroupId: string
    mappedBetaRole?: PrivateBetaRole
    active: boolean
  }
) {
  const now = Date.now()
  const existing = await findDirectoryGroupMembership(
    ctx,
    input.directoryUserId,
    input.directoryGroupId
  )
  const patch = {
    workosDirectoryId: input.workosDirectoryId,
    ...(input.workosOrgId ? { workosOrgId: input.workosOrgId } : {}),
    directoryUserId: input.directoryUserId,
    directoryGroupId: input.directoryGroupId,
    ...(input.mappedBetaRole ? { mappedBetaRole: input.mappedBetaRole } : {}),
    active: input.active,
    updatedAt: now,
    ...(!input.active ? { removedAt: now } : {}),
  }

  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return { ...existing, ...patch }
  }

  const id = await ctx.db.insert('workosDirectoryGroupMemberships', {
    ...patch,
    createdAt: now,
  })
  const inserted = await ctx.db.get(id)
  return inserted ?? { _id: id, ...patch, createdAt: now }
}

// `deprovisionTimestamp` es el momento del evento dsync SEGÚN EL PROVEEDOR:
// una membership cuya evidencia almacenada (providerUpdatedAt) es posterior fue
// otorgada DESPUÉS del deprovision (entrega invertida) y no debe tumbarse por
// un evento más viejo. Fail-closed: sin timestamps en ambos lados, se desactiva
// como siempre.
async function deactivateOrganizationMembershipsForDirectoryUser(
  ctx: MutationCtx,
  directoryUserId: string,
  userId?: Id<'users'>,
  workosOrgId?: string,
  deprovisionTimestamp?: number
) {
  const now = Date.now()
  const directoryMemberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_workosDirectoryUserId', (q) => q.eq('workosDirectoryUserId', directoryUserId))
    .collect()

  const fallbackMemberships =
    userId && workosOrgId
      ? await ctx.db
          .query('organizationMemberships')
          .withIndex('by_providerOrgId', (q) =>
            q.eq('authProvider', 'workos').eq('providerOrgId', workosOrgId)
          )
          .collect()
      : []

  const memberships = [...directoryMemberships, ...fallbackMemberships].filter(
    (membership, index, all) =>
      (workosOrgId === undefined || membership.workosOrgId === workosOrgId) &&
      (userId === undefined || membership.userId === userId) &&
      all.findIndex((candidate) => candidate._id === membership._id) === index
  )

  for (const membership of memberships) {
    if (
      deprovisionTimestamp !== undefined &&
      membership.providerUpdatedAt !== undefined &&
      membership.providerUpdatedAt > deprovisionTimestamp
    ) {
      continue
    }
    if (membership.status !== 'INACTIVE') {
      await ctx.db.patch(membership._id, {
        status: 'INACTIVE',
        updatedAt: now,
      })
    }
  }
}

// Un deprovision de origen IdP tiene que alcanzar el PERFIL, no solo
// memberships y el directory user: `requireAuth` gatea por `profiles.isActive`,
// así que sin este patch el usuario dado de baja en el IdP seguía
// autenticándose (hallazgo deprovision-dsync-no-desactiva-perfil, J3).
// PROVIDER = sincronizable: un re-provisioning del IdP puede revertirla. Si ya
// estaba desactivado (p.ej. ADMIN por AML), no pisar esa marca.
async function deactivateProfileFromProvider(
  ctx: MutationCtx,
  userId: Id<'users'> | undefined
): Promise<void> {
  if (!userId) {
    return
  }

  // Multi-org: dar de baja UNA identidad de directorio no puede dejar al
  // usuario fuera de organizaciones no relacionadas. El perfil solo cae cuando
  // no queda NINGUNA presencia activa del proveedor (org membership u otra
  // identidad de directorio). Las lecturas ven los writes previos de esta
  // misma mutación, así que la identidad recién deprovisionada ya no cuenta.
  const memberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect()
  // Solo cuentan memberships del proveedor activo (workos): una fila ACTIVE
  // legada de Clerk no representa presencia utilizable en el IdP y no debe
  // bloquear la desactivación del perfil.
  if (
    memberships.some(
      (membership) => membership.authProvider === 'workos' && membership.status === 'ACTIVE'
    )
  ) {
    return
  }

  const directoryUsers = await ctx.db
    .query('workosDirectoryUsers')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .collect()
  // Presencia VERIFICADA, no asumida: una identidad marcada activa por un
  // dsync.user.* retrasado tras un dsync.deactivated no cuenta si su
  // directorio padre almacenado ya no está activo (fail-closed).
  for (const directoryUser of directoryUsers) {
    if (
      directoryUser.active === true &&
      (await isWorkosDirectoryActive(ctx, directoryUser.workosDirectoryId))
    ) {
      return
    }
  }

  const profile = await findProfileByUserId(ctx, userId)
  if (profile && profile.isActive !== false) {
    await ctx.db.patch(profile._id, { isActive: false, deactivatedBy: 'PROVIDER' })
  }
}

async function deprovisionDirectoryUser(
  ctx: MutationCtx,
  directoryUserId: string,
  workosOrgId?: string,
  deprovisionTimestamp?: number
) {
  const now = Date.now()
  const directoryUser = await findDirectoryUserById(ctx, directoryUserId)
  const activeGroupMemberships = await ctx.db
    .query('workosDirectoryGroupMemberships')
    .withIndex('by_directoryUserId_active', (q) =>
      q.eq('directoryUserId', directoryUserId).eq('active', true)
    )
    .collect()

  for (const membership of activeGroupMemberships) {
    await ctx.db.patch(membership._id, {
      active: false,
      updatedAt: now,
      removedAt: now,
    })
  }

  if (directoryUser) {
    await ctx.db.patch(directoryUser._id, {
      active: false,
      state: 'DELETED',
      updatedAt: now,
      // El momento del deprovision según el PROVEEDOR (no el de la entrega):
      // con la hora de recepción, un membership otorgado entre el deprovision
      // y su entrega tardía compararía como anterior y ningún reintento
      // posterior podría restaurarlo.
      deprovisionedAt: deprovisionTimestamp ?? now,
    })
  }

  // La org del deprovision también se resuelve vía el PADRE: un payload y una
  // identidad almacenada sin workosOrgId dejarían la membership directa de esa
  // misma org fuera de ambas queries del deactivador; quedaría ACTIVE y
  // bloquearía la desactivación del perfil.
  const resolvedOrgId =
    workosOrgId ?? (directoryUser ? await resolveDirectoryUserOrgId(ctx, directoryUser) : undefined)

  await deactivateOrganizationMembershipsForDirectoryUser(
    ctx,
    directoryUserId,
    directoryUser?.userId,
    resolvedOrgId,
    deprovisionTimestamp
  )

  return await deactivateProfileFromProvider(ctx, directoryUser?.userId)
}

async function refreshOrganizationMembershipForDirectoryUser(
  ctx: MutationCtx,
  directoryUserId: string,
  workosOrgId?: string
): Promise<void> {
  const directoryUser = await findDirectoryUserById(ctx, directoryUserId)
  if (!directoryUser?.userId) {
    return
  }

  const activeGroupMemberships = await ctx.db
    .query('workosDirectoryGroupMemberships')
    .withIndex('by_directoryUserId_active', (q) =>
      q.eq('directoryUserId', directoryUserId).eq('active', true)
    )
    .collect()

  const scopedMemberships = activeGroupMemberships.filter(
    (membership) =>
      workosOrgId === undefined ||
      membership.workosOrgId === workosOrgId ||
      directoryUser.workosOrgId === workosOrgId
  )
  const activeRoles = scopedMemberships
    .map((membership) => membership.mappedBetaRole)
    .filter((role): role is PrivateBetaRole => Boolean(role))
  const betaRole = chooseHighestDirectoryRole(activeRoles)

  if (!betaRole) {
    await deactivateOrganizationMembershipsForDirectoryUser(
      ctx,
      directoryUserId,
      directoryUser.userId,
      workosOrgId ?? directoryUser.workosOrgId
    )
    await deactivateProfileFromProvider(ctx, directoryUser.userId)
    return
  }

  const profileRole = mapBetaRoleToProfileRole(betaRole)
  const user = await ctx.db.get(directoryUser.userId)
  if (!user) {
    return
  }

  // El estado VERIFICADO manda: directory user activo Y directorio padre
  // activo. Un refresh disparado por un evento de grupo retrasado sobre un
  // usuario deprovisionado no prueba re-provisioning: ni levanta el hold
  // PROVIDER del perfil ni puede reinstalar la org membership como ACTIVE
  // (una membership activa autoriza p.ej. el admin portal de WorkOS) ni
  // actúa como autoridad de rol sobre `users.role`/`profiles.role`.
  const providerActive =
    directoryUser.active === true &&
    (await isWorkosDirectoryActive(ctx, directoryUser.workosDirectoryId))

  if (providerActive && user.role !== profileRole) {
    await ctx.db.patch(user._id, { role: profileRole })
  }
  const profile = await ensureWorkosProfile(ctx, user, profileRole, {
    authoritativeRole: providerActive,
    providerActive,
  })
  const selectedGroupMembership =
    scopedMemberships.find((membership) => membership.mappedBetaRole === betaRole) ??
    scopedMemberships[0]

  const existingMemberships = await ctx.db
    .query('organizationMemberships')
    .withIndex('by_workosDirectoryUserId', (q) => q.eq('workosDirectoryUserId', directoryUserId))
    .collect()
  const existingMembership =
    existingMemberships.find(
      (membership) =>
        membership.userId === user._id &&
        (workosOrgId === undefined || membership.workosOrgId === workosOrgId)
    ) ?? null
  const providerOrgId = workosOrgId ?? directoryUser.workosOrgId

  if (!providerOrgId) {
    return
  }

  const membershipPatch = {
    userId: user._id,
    profileId: profile._id,
    authProvider: 'workos' as const,
    providerOrgId,
    workosOrgId: providerOrgId,
    workosDirectoryId: directoryUser.workosDirectoryId,
    workosDirectoryUserId: directoryUserId,
    ...(selectedGroupMembership?.directoryGroupId
      ? { workosDirectoryGroupId: selectedGroupMembership.directoryGroupId }
      : {}),
    betaRole,
    profileRole,
    status: providerActive ? ('ACTIVE' as const) : ('INACTIVE' as const),
    updatedAt: Date.now(),
  }

  if (existingMembership) {
    await ctx.db.patch(existingMembership._id, membershipPatch)
  } else {
    await ctx.db.insert('organizationMemberships', {
      ...membershipPatch,
      createdAt: Date.now(),
    })
  }

  if (!providerActive) {
    await deactivateProfileFromProvider(ctx, directoryUser.userId)
  }
}

async function syncWorkosDirectoryGroupUserChange(
  ctx: MutationCtx,
  eventType: string,
  data: unknown
) {
  const record = asRecord(data)
  const userRecord = asRecord(record?.user)
  const groupRecord = asRecord(record?.group)
  const directoryUserId = stringValue(userRecord?.id)
  const directoryGroupId = stringValue(groupRecord?.id)

  if (!record || !userRecord || !groupRecord || !directoryUserId || !directoryGroupId) {
    return syncSkipped(eventType, data, 'WorkOS directory group membership payload missing ids')
  }

  const group = await upsertWorkosDirectoryGroup(ctx, groupRecord)
  const mappedBetaRole =
    group?.mappedBetaRole ?? getDirectoryGroupBetaRole(groupRecord) ?? undefined
  const profileRole = mappedBetaRole ? mapBetaRoleToProfileRole(mappedBetaRole) : undefined
  const directoryUser = await upsertWorkosDirectoryUser(ctx, userRecord, {
    ensureLocalUser: eventType === 'dsync.group.user_added' && Boolean(mappedBetaRole),
    profileRole,
  })

  if (!directoryUser || !group) {
    return syncSkipped(eventType, data, 'WorkOS directory group membership payload incomplete')
  }

  if (eventType === 'dsync.group.user_removed') {
    await upsertDirectoryGroupMembership(ctx, {
      workosDirectoryId: directoryUser.workosDirectoryId,
      workosOrgId: directoryUser.workosOrgId,
      directoryUserId,
      directoryGroupId,
      mappedBetaRole,
      active: false,
    })
    await refreshOrganizationMembershipForDirectoryUser(
      ctx,
      directoryUserId,
      directoryUser.workosOrgId
    )

    return {
      action: 'workos_directory_group_user_removed',
      resourceId: directoryUserId,
      details: `Removed Directory Sync membership for ${directoryUserId}`,
      processed: true,
    }
  }

  await upsertDirectoryGroupMembership(ctx, {
    workosDirectoryId: directoryUser.workosDirectoryId,
    workosOrgId: directoryUser.workosOrgId,
    directoryUserId,
    directoryGroupId,
    mappedBetaRole,
    active: true,
  })
  await refreshOrganizationMembershipForDirectoryUser(
    ctx,
    directoryUserId,
    directoryUser.workosOrgId
  )

  return {
    action: mappedBetaRole
      ? 'workos_directory_group_user_added'
      : 'workos_directory_group_user_added_unmapped',
    resourceId: directoryUserId,
    details: mappedBetaRole
      ? `Activated Directory Sync membership for ${directoryUserId}`
      : `Recorded unmapped Directory Sync group membership for ${directoryUserId}`,
    processed: true,
  }
}

// ============================================================================
// QUERIES (Lectura de datos)
// ============================================================================

/**
 * Obtener el user + profile del usuario autenticado actual.
 * Evita que el cliente necesite hacer lookups arbitrarios por email/Clerk ID.
 * KYC admin-only fields are stripped for non-admin owners.
 */
const getCurrentUserStateProgram = Effect.fn('Users.getCurrentUserState')(function* (
  ctx: QueryCtx
) {
  const identity = yield* convexPromise(() => ctx.auth.getUserIdentity())
  if (!identity) {
    return null
  }

  // Identidad WorkOS autenticada sin fila local todavía (el redirect le ganó
  // al webhook): devolver la forma {user: null} y no null, para que
  // requireWorkosSession distinga "primer login" de un fallo de backend — con
  // null redirige a /onboarding?error=profile-fetch-failed, que es la propia
  // página de onboarding: loop infinito para la población del bootstrap. Una
  // credencial Clerk retenida NO es primer login: sigue degradando a null
  // (frontera fail-closed, ver retained-clerk-current-user-boundary).
  const result = yield* convexPromise(() => resolveCurrentUserState(ctx, identity))
  if (!result.user) {
    const authProvider = yield* convexSync(() => getIdentityAuthProvider(identity))
    return authProvider === 'workos' ? result : null
  }
  if (!result.profile) return result

  // Owner viewing own profile: strip admin-only KYC fields
  // Admin viewing own profile: return full data
  if (result.profile.role === 'ADMIN') {
    return result
  }

  return {
    ...result,
    profile: stripAdminOnlyKycFields(result.profile),
  }
})

export const getCurrentUserState = query({
  args: {},
  handler: (ctx) => runConvex(getCurrentUserStateProgram(ctx)),
})

/**
 * El id de perfil con el que Convex resuelve ESTA sesión. `requireAuth` pasa por
 * el bypass de dev, así que la ruta Next puede firmar la prueba de entrega con
 * el mismo perfil que `consumeDownloadGrant` verificará; `getCurrentUserState`
 * lee la identidad cruda y devuelve null sin token.
 */
const getCurrentProfileIdProgram = Effect.fn('Users.getCurrentProfileId')(function* (
  ctx: QueryCtx
) {
  const { profile } = yield* requireAuthEffect(ctx)
  return { profileId: profile._id }
})

export const getCurrentProfileId = query({
  args: {},
  handler: (ctx) => runConvex(getCurrentProfileIdProgram(ctx)),
})

// ============================================================================
// MUTATIONS (Escritura de datos)
// ============================================================================

const syncWorkosEventProgram = Effect.fn('Users.syncWorkosEvent')(function* (
  ctx: MutationCtx,
  args: { eventType: string; data: unknown }
) {
  if (
    args.eventType === 'dsync.activated' ||
    args.eventType === 'dsync.deactivated' ||
    args.eventType === 'dsync.deleted'
  ) {
    return yield* convexPromise(() => syncWorkosDirectory(ctx, args.eventType, args.data))
  }

  if (
    args.eventType === 'dsync.user.created' ||
    args.eventType === 'dsync.user.updated' ||
    args.eventType === 'dsync.user.deleted'
  ) {
    return yield* convexPromise(() => syncWorkosDirectoryUser(ctx, args.eventType, args.data))
  }

  if (
    args.eventType === 'dsync.group.created' ||
    args.eventType === 'dsync.group.updated' ||
    args.eventType === 'dsync.group.deleted'
  ) {
    return yield* convexPromise(() => syncWorkosDirectoryGroup(ctx, args.eventType, args.data))
  }

  if (
    args.eventType === 'dsync.group.user_added' ||
    args.eventType === 'dsync.group.user_removed'
  ) {
    return yield* convexPromise(() =>
      syncWorkosDirectoryGroupUserChange(ctx, args.eventType, args.data)
    )
  }

  if (
    args.eventType === 'user.created' ||
    args.eventType === 'user.updated' ||
    args.eventType === 'user.deleted'
  ) {
    return yield* convexPromise(() => syncWorkosUser(ctx, args.eventType, args.data))
  }

  if (
    args.eventType === 'organization_membership.created' ||
    args.eventType === 'organization_membership.updated' ||
    args.eventType === 'organization_membership.deleted'
  ) {
    return yield* convexPromise(() => syncWorkosMembership(ctx, args.eventType, args.data))
  }

  return syncSkipped(args.eventType, args.data)
})

export const syncWorkosEvent = internalMutation({
  args: {
    eventType: v.string(),
    data: v.any(),
  },
  handler: (ctx, args): Promise<WorkosSyncResult> => runConvex(syncWorkosEventProgram(ctx, args)),
})

// El efecto y el status terminal commitean juntos. Si esta mutation lanza,
// Convex revierte las dos escrituras y la fila sigue en `processing`. Un
// claim vencido ya no puede reaplicar un efecto que sí commiteó.
const commitWorkosWebhookEventProgram = Effect.fn('Users.commitWorkosWebhookEvent')(function* (
  ctx: MutationCtx,
  args: {
    webhookEventId: Id<'webhookEvents'>
    claimVersion: number
    eventType: string
    data: unknown
  }
) {
  const event = yield* convexPromise(() => ctx.db.get(args.webhookEventId))
  if (
    !event ||
    event.provider !== 'workos' ||
    event.status !== 'processing' ||
    (event.claimVersion ?? 0) !== args.claimVersion
  ) {
    return {
      action: 'workos_claim_stale',
      processed: false,
      details: 'The WorkOS event is no longer owned by this attempt.',
    }
  }
  const result = yield* syncWorkosEventProgram(ctx, {
    eventType: args.eventType,
    data: args.data,
  })
  if (result.processed) {
    yield* markCompletedProgram(ctx, {
      eventId: args.webhookEventId,
      action: result.action,
      resourceId: result.resourceId,
      details: result.details || `Processed WorkOS event ${args.eventType}.`,
    })
  } else {
    yield* markSkippedProgram(ctx, {
      eventId: args.webhookEventId,
      reason: result.details || `WorkOS event ${args.eventType} was verified but not handled.`,
    })
  }
  return result
})

export const commitWorkosWebhookEvent = internalMutation({
  args: {
    webhookEventId: v.id('webhookEvents'),
    claimVersion: v.number(),
    eventType: v.string(),
    data: v.any(),
  },
  handler: (ctx, args) => runConvex(commitWorkosWebhookEventProgram(ctx, args)),
})

/**
 * Hacer admin a un usuario por email
 *
 * SEGURIDAD: Esta mutación require autenticación de un admin existente.
 * Solo admins pueden hacer a otros usuarios admins.
 */
const makeAdminProgram = Effect.fn('Users.makeAdmin')(function* (
  ctx: MutationCtx,
  args: { email: string }
) {
  // ===== VERIFICAR AUTORIZACIÓN ADMIN =====
  const { user: callerUser, profile: callerProfile } = yield* convexPromise(() =>
    requireAuthAdmin(ctx)
  )

  // Buscar usuario por email
  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', args.email))
      .first()
  )

  if (!user) {
    return yield* Effect.fail(userNotFound(args.email))
  }

  // Buscar perfil del usuario
  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )

  if (!profile) {
    return yield* Effect.fail(
      new AppError(ErrorCode.PROFILE_NOT_FOUND, `Perfil no encontrado para usuario ${args.email}`)
    )
  }

  const previousRole = profile.role

  // Actualizar rol a ADMIN en profiles
  yield* convexPromise(() => ctx.db.patch(profile._id, { role: 'ADMIN' }))

  // SIEMPRE actualizar en users también (para que useCurrentUser lo detecte)
  yield* convexPromise(() => ctx.db.patch(user._id, { role: 'ADMIN' }))

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: callerProfile._id,
      adminEmail: callerUser.email,
      action: 'USER_ROLE_CHANGE',
      targetType: 'PROFILE',
      targetId: profile._id,
      previousValue: { role: previousRole },
      newValue: {
        role: 'ADMIN',
      },
      notes: `makeAdmin sobre ${args.email}`,
    })
  )

  return {
    success: true,
    userId: user._id,
    profileId: profile._id,
    email: args.email,
    newRole: 'ADMIN',
  }
})

export const makeAdmin = mutation({
  args: {
    email: v.string(),
  },
  handler: (ctx, args) => runConvex(makeAdminProgram(ctx, args)),
})

/**
 * Desactivar la propia cuenta del usuario autenticado (self-service)
 * El usuario puede desactivar su propia cuenta sin necesidad de un admin.
 * Es un soft-delete: isActive = false. No hay mutation que la reactive: hoy se
 * revierte a mano sobre la fila del perfil.
 */
const deactivateOwnAccountProgram = Effect.fn('Users.deactivateOwnAccount')(function* (
  ctx: MutationCtx,
  args: { profileId: Id<'profiles'> }
) {
  // ===== VERIFICAR AUTENTICACION =====
  const { user, profile } = yield* requireAuthEffect(ctx)

  // ===== VERIFICAR OWNERSHIP =====
  // Solo puedes desactivar tu propia cuenta
  if (profile._id !== args.profileId) {
    return yield* Effect.fail(
      unauthorized('No autorizado: solo puedes desactivar tu propia cuenta')
    )
  }

  // ===== DESACTIVAR CUENTA =====
  // Marca USER = pegajosa frente al IdP (un webhook no "des-pausa" una cuenta
  // que su dueño pausó).
  yield* convexPromise(() =>
    ctx.db.patch(args.profileId, { isActive: false, deactivatedBy: 'USER' })
  )

  // ===== TRAZABILIDAD: evento de seguridad self-service =====
  // No es acción admin (no va a adminAuditLogs); queda en securityEvents para
  // que el equipo pueda auditar pausas de cuenta y reactivaciones.
  yield* convexPromise(() =>
    ctx.db.insert('securityEvents', {
      type: 'ACCOUNT_SELF_DEACTIVATION',
      severity: 'INFO',
      userId: profile.userId ?? undefined,
      userEmail: user.email,
      details: { profileId: args.profileId, role: profile.role },
      resolved: false,
    })
  )

  return { success: true }
})

export const deactivateOwnAccount = mutation({
  args: { profileId: v.id('profiles') },
  handler: (ctx, args) => runConvex(deactivateOwnAccountProgram(ctx, args)),
})
