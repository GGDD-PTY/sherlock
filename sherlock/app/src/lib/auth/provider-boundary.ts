// ============================================================================
// FRONTERA DE PROVEEDOR DE IDENTIDAD
// ============================================================================
// Acá se decide qué es una sesión de WorkOS en términos de Sherlock: qué rol de
// la beta trae, a qué rol de producto mapea y qué membresía produce. Es una
// frontera de seguridad, así que los tres catálogos —proveedor, rol de beta y
// rol de producto— se declaran una sola vez con `Schema.Literals` y el guardia
// que estrecha entrada ajena sale del mismo catálogo.
//
// El `roleSlug` lo escribe el directorio de WorkOS, no nosotros: es entrada
// ajena y se estrecha contra el catálogo ANTES de tocar el mapa. Indexar un
// objeto plano con un string ajeno devuelve miembros heredados —`__proto__`
// entrega `Object.prototype` y `constructor` entrega `Object`, ambos truthy—,
// así que un rol llamado así en el directorio salía de `mapWorkOsRoleToBetaRole`
// como si fuera un `PrivateBetaRole` válido y llegaba a la membresía.
// ============================================================================

import { Schema } from 'effect'

/** El catálogo canónico vive en `convex/schema.ts` (`AuthProvider`). Clerk
 *  sobrevive solo en filas históricas; esta frontera solo construye WorkOS, y
 *  el literal sale del catálogo en vez de estar escrito en cada objeto. */
const AuthProviderSchema = Schema.Literals(['clerk', 'workos'])
const WORKOS_PROVIDER = AuthProviderSchema.pick(['workos']).literals[0]
type AuthProvider = typeof WORKOS_PROVIDER

export type PrivateBetaRole =
  | 'ADMIN'
  | 'COMPANY_OWNER'
  | 'COMPANY_MEMBER'
  | 'COUNSEL_REVIEWER'

export type SherlockProfileRole = 'ADMIN' | 'COMPANY'

interface AuthIdentity {
  authProvider: AuthProvider
  providerUserId: string
  email: string
  name: string | null
  imageUrl: string | null
  workosUserId?: string
}

interface AuthOrg {
  authProvider: AuthProvider
  providerOrgId: string
  name: string
  workosOrgId?: string
}

interface AuthMembership extends AuthOrg {
  betaRole: PrivateBetaRole
  profileRole: SherlockProfileRole
}

export interface AuthSession {
  identity: AuthIdentity
  profileId: string | null
  profileRole: SherlockProfileRole | null
  memberships: AuthMembership[]
}

export interface WorkOsSessionInput {
  user: {
    id: string
    email: string
    firstName?: string | null
    lastName?: string | null
  }
  organization?: {
    id: string
    name: string
  } | null
  roleSlug?: string | null
  profileId?: string | null
}

/** Los slugs que el directorio de WorkOS puede traer, escritos una vez. */
const WorkOsRoleSlugSchema = Schema.Literals([
  'admin',
  'company_owner',
  'company_member',
  'counsel_reviewer',
])
const isWorkOsRoleSlug = Schema.is(WorkOsRoleSlugSchema)

const WORKOS_ROLE_MAP: Record<typeof WorkOsRoleSlugSchema.Type, PrivateBetaRole> = {
  admin: 'ADMIN',
  company_owner: 'COMPANY_OWNER',
  company_member: 'COMPANY_MEMBER',
  counsel_reviewer: 'COUNSEL_REVIEWER',
}

export function mapWorkOsRoleToBetaRole(roleSlug: string | null | undefined) {
  return isWorkOsRoleSlug(roleSlug) ? WORKOS_ROLE_MAP[roleSlug] : null
}

export function mapBetaRoleToProfileRole(betaRole: PrivateBetaRole): SherlockProfileRole {
  switch (betaRole) {
    case 'ADMIN':
    case 'COUNSEL_REVIEWER':
      return 'ADMIN'
    case 'COMPANY_OWNER':
    case 'COMPANY_MEMBER':
      return 'COMPANY'
  }
}

export function buildWorkOsAuthSession(input: WorkOsSessionInput): AuthSession {
  const name = [input.user.firstName, input.user.lastName].filter(Boolean).join(' ') || null
  const betaRole = mapWorkOsRoleToBetaRole(input.roleSlug)
  const membership =
    input.organization && betaRole
      ? [
          {
            authProvider: WORKOS_PROVIDER,
            providerOrgId: input.organization.id,
            workosOrgId: input.organization.id,
            name: input.organization.name,
            betaRole,
            profileRole: mapBetaRoleToProfileRole(betaRole),
          },
        ]
      : []

  return {
    identity: {
      authProvider: WORKOS_PROVIDER,
      providerUserId: input.user.id,
      workosUserId: input.user.id,
      email: input.user.email,
      name,
      imageUrl: null,
    },
    profileId: input.profileId ?? null,
    profileRole: membership[0]?.profileRole ?? null,
    memberships: membership,
  }
}
