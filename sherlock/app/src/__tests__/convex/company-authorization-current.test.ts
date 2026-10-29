// ============================================================================
// AUTORIZACIÓN DE EMPRESA — formas que hoy siguen autorizadas, y el fallo
// de un dueño accidental que también es miembro
// ============================================================================
// Producción tiene el control apagado, cero vínculos y cero tombstones. Un
// dueño sin historial de membresía, un dueño con una membresía activa de
// owner, y un admin tienen que seguir autorizados. El otro caso es el que
// estaba mal: si la gestión de la empresa propia no autoriza, el resolutor
// devolvía null y no miraba el carril de miembro.

import { describe, expect, it } from 'vitest'

import type { Doc } from '../../../convex/_generated/dataModel'
import type { AuthResult } from '../../../convex/_helpers/auth.types'
import {
  evaluateCompanyManagementAuthorization,
  resolveCurrentCompanyAuthorization,
} from '../../../convex/_helpers/companyAuthorization'
import { createConvexCtx, type Row, type Tables } from './nda-convex-harness'

function user(id: string, workosUserId: string): Row {
  return {
    _id: id,
    _creationTime: 1,
    authProvider: 'workos',
    providerUserId: workosUserId,
    workosUserId,
    email: `${workosUserId}@example.com`,
    role: 'COMPANY',
  }
}

function profile(id: string, userId: string, role: 'COMPANY' | 'ADMIN' = 'COMPANY'): Row {
  return {
    _id: id,
    _creationTime: 2,
    userId,
    role,
    isActive: true,
  }
}

function company(id: string, ownerId: string): Row {
  return {
    _id: id,
    _creationTime: 3,
    ownerId,
    name: id,
  }
}

function membership(overrides: Partial<Row> & Pick<Row, '_id' | 'userId' | 'profileId'>): Row {
  return {
    _creationTime: 4,
    authProvider: 'workos',
    providerOrgId: 'org_issuer',
    workosOrgId: 'org_issuer',
    betaRole: 'COMPANY_OWNER',
    profileRole: 'COMPANY',
    status: 'ACTIVE',
    createdAt: 4,
    ...overrides,
  }
}

function authFor(tables: Tables, userId: string, profileId: string): AuthResult {
  const userRow = tables.users.find((row) => row._id === userId)
  const profileRow = tables.profiles.find((row) => row._id === profileId)
  if (!userRow || !profileRow) throw new Error('fixture incompleto')
  return {
    identity: {
      subject: String(userRow.workosUserId),
      authProvider: 'workos',
      issuer: 'https://api.workos.com/',
    },
    user: userRow as unknown as Doc<'users'>,
    profile: profileRow as unknown as Doc<'profiles'>,
  }
}

function emptyControlTables(): Pick<
  Tables,
  'companyOrganizationBindings' | 'companyAuthorizationControls' | 'organizationMembershipTombstones'
> {
  return {
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    organizationMembershipTombstones: [],
  }
}

describe('company authorization keeps the live owner shapes', () => {
  it('authorizes an owner with no membership history while the rollout switch is off', async () => {
    const tables: Tables = {
      ...emptyControlTables(),
      users: [user('user_owner', 'workos_owner')],
      profiles: [profile('profile_owner', 'user_owner')],
      companies: [company('company_owner', 'profile_owner')],
      organizationMemberships: [],
    }
    const ctx = createConvexCtx(tables)
    const auth = authFor(tables, 'user_owner', 'profile_owner')
    const companyRow = tables.companies[0] as unknown as Doc<'companies'>

    await expect(
      evaluateCompanyManagementAuthorization(ctx as never, auth, companyRow)
    ).resolves.toMatchObject({
      authorized: true,
      enforcement: 'UNENFORCED',
      reason: 'FIRST_LOGIN_OWNER',
    })
    await expect(resolveCurrentCompanyAuthorization(ctx as never, auth)).resolves.toMatchObject({
      access: 'MANAGE',
      enforcement: 'UNENFORCED',
      company: { _id: 'company_owner' },
    })
  })

  it('authorizes an owner with one active owner membership and no binding', async () => {
    const tables: Tables = {
      ...emptyControlTables(),
      users: [user('user_owner', 'workos_owner')],
      profiles: [profile('profile_owner', 'user_owner')],
      companies: [company('company_owner', 'profile_owner')],
      organizationMemberships: [
        membership({
          _id: 'membership_owner',
          userId: 'user_owner',
          profileId: 'profile_owner',
        }),
      ],
    }
    const ctx = createConvexCtx(tables)
    const auth = authFor(tables, 'user_owner', 'profile_owner')
    const companyRow = tables.companies[0] as unknown as Doc<'companies'>

    await expect(
      evaluateCompanyManagementAuthorization(ctx as never, auth, companyRow)
    ).resolves.toMatchObject({
      authorized: true,
      enforcement: 'UNENFORCED',
      reason: 'CUTOVER_COMPATIBILITY',
    })
    await expect(resolveCurrentCompanyAuthorization(ctx as never, auth)).resolves.toMatchObject({
      access: 'MANAGE',
      company: { _id: 'company_owner' },
    })
  })

  it('authorizes an admin on a company they do not own', async () => {
    const tables: Tables = {
      ...emptyControlTables(),
      users: [user('user_admin', 'workos_admin'), user('user_owner', 'workos_owner')],
      profiles: [
        profile('profile_admin', 'user_admin', 'ADMIN'),
        profile('profile_owner', 'user_owner'),
      ],
      companies: [company('company_owner', 'profile_owner')],
      organizationMemberships: [],
    }
    tables.users[0].role = 'ADMIN'
    const ctx = createConvexCtx(tables)
    const auth = authFor(tables, 'user_admin', 'profile_admin')
    const companyRow = tables.companies[0] as unknown as Doc<'companies'>

    await expect(
      evaluateCompanyManagementAuthorization(ctx as never, auth, companyRow)
    ).resolves.toMatchObject({
      authorized: true,
      enforcement: 'ADMIN',
      reason: 'ADMIN',
    })
  })
})

describe('resolveCurrentCompanyAuthorization member fallthrough', () => {
  it('grants read-only on the issuer when the owned company is not manageable', async () => {
    // El miembro abrió la app antes de que llegara organization_membership.created,
    // así que ya tiene una empresa con ownerId propio. La gestión de esa fila
    // no autoriza (su única membresía es COMPANY_MEMBER). Tiene que entrar a
    // la empresa emisora en solo lectura.
    const tables: Tables = {
      ...emptyControlTables(),
      users: [user('user_issuer', 'workos_issuer'), user('user_member', 'workos_member')],
      profiles: [
        profile('profile_issuer', 'user_issuer'),
        profile('profile_member', 'user_member'),
      ],
      companies: [
        company('company_issuer', 'profile_issuer'),
        company('company_accidental', 'profile_member'),
      ],
      organizationMemberships: [
        membership({
          _id: 'membership_issuer',
          userId: 'user_issuer',
          profileId: 'profile_issuer',
          betaRole: 'COMPANY_OWNER',
        }),
        membership({
          _id: 'membership_member',
          userId: 'user_member',
          profileId: 'profile_member',
          betaRole: 'COMPANY_MEMBER',
        }),
      ],
    }
    const ctx = createConvexCtx(tables)
    const auth = authFor(tables, 'user_member', 'profile_member')

    await expect(resolveCurrentCompanyAuthorization(ctx as never, auth)).resolves.toMatchObject({
      access: 'READ_ONLY',
      enforcement: 'UNENFORCED',
      company: { _id: 'company_issuer' },
    })
  })

  it('does not grant management to a revoked owner who is not a member anywhere', async () => {
    const tables: Tables = {
      ...emptyControlTables(),
      users: [user('user_owner', 'workos_owner')],
      profiles: [profile('profile_owner', 'user_owner')],
      companies: [company('company_owner', 'profile_owner')],
      organizationMemberships: [
        membership({
          _id: 'membership_owner',
          userId: 'user_owner',
          profileId: 'profile_owner',
          status: 'INACTIVE',
        }),
      ],
    }
    const ctx = createConvexCtx(tables)
    const auth = authFor(tables, 'user_owner', 'profile_owner')
    const companyRow = tables.companies[0] as unknown as Doc<'companies'>

    await expect(
      evaluateCompanyManagementAuthorization(ctx as never, auth, companyRow)
    ).resolves.toMatchObject({ authorized: false, reason: 'MEMBERSHIP_REVOKED' })
    await expect(resolveCurrentCompanyAuthorization(ctx as never, auth)).resolves.toBeNull()
  })
})
