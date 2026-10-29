import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Doc } from '../../../convex/_generated/dataModel'
import type { AuthResult } from '../../../convex/_helpers/auth.types'
import { evaluateCompanyManagementAuthorization } from '../../../convex/_helpers/companyAuthorization'
import { syncWorkosEvent } from '../../../convex/users'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const MEMBERSHIP_ID = 'om_delete_first'
const ORGANIZATION_ID = 'org_delete_first'
const USER_ID = 'user_delete_first'
const DELETED_AT = Date.parse('2026-07-15T00:00:00.000Z')

function createTables(overrides: Partial<Tables> = {}): Tables {
  return {
    organizationMembershipTombstones: [],
    organizationMemberships: [],
    users: [],
    profiles: [],
    workosDirectoryUsers: [],
    workosDirectories: [],
    ...overrides,
  }
}

function tombstone(providerUpdatedAt: number = DELETED_AT) {
  return {
    _id: 'membership_tombstone_1',
    _creationTime: 1,
    authProvider: 'workos',
    providerMembershipId: MEMBERSHIP_ID,
    providerOrgId: ORGANIZATION_ID,
    providerUserId: USER_ID,
    providerUpdatedAt,
    deletedAt: providerUpdatedAt,
  }
}

function activeMembershipData(updatedAt?: string, roleSlug = 'company_owner') {
  return {
    id: MEMBERSHIP_ID,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    organizationName: 'Issuer Example',
    status: 'active',
    role: { slug: roleSlug },
    ...(updatedAt ? { updatedAt } : {}),
  }
}

const runSync = (ctx: unknown, eventType: string, data: ReturnType<typeof activeMembershipData>) =>
  runHandler(syncWorkosEvent, ctx, { eventType, data })

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkOS organization membership tombstones', () => {
  it('persists delete-first evidence when neither a user nor a membership row exists', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-03T12:00:00.000Z')
    const tables = createTables()
    const ctx = createConvexCtx(tables)

    const result = await runSync(
      ctx,
      'organization_membership.deleted',
      activeMembershipData('2026-07-15T00:00:00.000Z')
    )

    expect(result).toMatchObject({
      action: 'workos_membership_tombstoned',
      resourceId: ORGANIZATION_ID,
      processed: true,
    })
    expect(tables.users).toEqual([])
    expect(tables.organizationMemberships).toEqual([])
    expect(tables.organizationMembershipTombstones).toEqual([
      expect.objectContaining({
        authProvider: 'workos',
        providerMembershipId: MEMBERSHIP_ID,
        providerOrgId: ORGANIZATION_ID,
        providerUserId: USER_ID,
        providerUpdatedAt: DELETED_AT,
        deletedAt: Date.parse('2026-08-03T12:00:00.000Z'),
      }),
    ])
  })

  it('does not corrupt a tombstone when the same membership id is deleted for another org and user', async () => {
    const tables = createTables({ organizationMembershipTombstones: [tombstone()] })
    const ctx = createConvexCtx(tables)

    await runSync(ctx, 'organization_membership.deleted', {
      ...activeMembershipData('2026-07-20T00:00:00.000Z'),
      userId: 'user_conflicting',
      organizationId: 'org_conflicting',
    })

    expect(tables.organizationMembershipTombstones).toEqual([
      expect.objectContaining({
        providerMembershipId: MEMBERSHIP_ID,
        providerOrgId: ORGANIZATION_ID,
        providerUserId: USER_ID,
        providerUpdatedAt: DELETED_AT,
      }),
    ])
  })

  it.each([
    ['older', '2026-07-14T23:59:59.999Z'],
    ['equal', '2026-07-15T00:00:00.000Z'],
  ])('blocks an %s ACTIVE event before any local provisioning', async (_label, updatedAt) => {
    const storedTombstone = tombstone()
    const tables = createTables({ organizationMembershipTombstones: [storedTombstone] })
    const ctx = createConvexCtx(tables)

    const result = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData(updatedAt)
    )

    expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([storedTombstone])
    expect(tables.users).toEqual([])
    expect(tables.profiles).toEqual([])
    expect(tables.organizationMemberships).toEqual([])
    expect(ctx.db.insert).not.toHaveBeenCalled()
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.db.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['older', '2026-07-14T23:59:59.999Z'],
    ['equal', '2026-07-15T00:00:00.000Z'],
  ])(
    'blocks an %s ACTIVE regrant with a new membership id for the same org and user',
    async (_label, updatedAt) => {
      const storedTombstone = tombstone()
      const tables = createTables({ organizationMembershipTombstones: [storedTombstone] })
      const ctx = createConvexCtx(tables)

      const result = await runSync(ctx, 'organization_membership.updated', {
        ...activeMembershipData(updatedAt),
        id: 'om_regrant_new',
      })

      expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
      expect(tables.organizationMembershipTombstones).toEqual([storedTombstone])
      expect(tables.organizationMemberships).toEqual([])
      expect(tables.users).toEqual([])
    }
  )

  it('consumes org-user tombstone evidence after a strictly newer regrant with a new membership id', async () => {
    const tables = createTables({ organizationMembershipTombstones: [tombstone()] })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'organization_membership.updated', {
      ...activeMembershipData('2026-07-15T00:00:00.001Z'),
      id: 'om_regrant_new',
    })

    expect(result).toMatchObject({ action: 'workos_membership_synced', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([])
    expect(tables.organizationMemberships).toEqual([
      expect.objectContaining({
        providerMembershipId: 'om_regrant_new',
        providerOrgId: ORGANIZATION_ID,
        userId: expect.any(String),
        status: 'ACTIVE',
      }),
    ])
  })

  it('retains the tombstone until a valid strictly newer ACTIVE regrant succeeds', async () => {
    const tables = createTables({ organizationMembershipTombstones: [tombstone()] })
    const ctx = createConvexCtx(tables)

    const rejected = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData('2026-07-20T00:00:00.000Z', 'admin')
    )

    expect(rejected).toMatchObject({ action: 'workos_event_skipped', processed: false })
    expect(tables.organizationMembershipTombstones).toHaveLength(1)
    expect(ctx.db.delete).not.toHaveBeenCalled()

    const inactive = await runSync(ctx, 'organization_membership.updated', {
      ...activeMembershipData('2026-07-20T00:00:00.001Z'),
      status: 'inactive',
    })

    expect(inactive).toMatchObject({ action: 'workos_membership_synced', processed: true })
    expect(tables.organizationMembershipTombstones).toHaveLength(1)
    expect(tables.organizationMemberships).toEqual([
      expect.objectContaining({ status: 'INACTIVE' }),
    ])
    expect(ctx.db.delete).not.toHaveBeenCalled()

    const regranted = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData('2026-07-20T00:00:00.002Z')
    )

    expect(regranted).toMatchObject({ action: 'workos_membership_synced', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([])
    expect(tables.organizationMemberships).toEqual([
      expect.objectContaining({
        authProvider: 'workos',
        providerMembershipId: MEMBERSHIP_ID,
        providerOrgId: ORGANIZATION_ID,
        status: 'ACTIVE',
        providerUpdatedAt: Date.parse('2026-07-20T00:00:00.002Z'),
      }),
    ])
    expect(tables.profiles).toEqual([expect.objectContaining({ role: 'COMPANY', isActive: true })])
    expect(ctx.db.delete).toHaveBeenCalledTimes(1)
    expect(ctx.db.delete).toHaveBeenCalledWith('membership_tombstone_1')
  })

  it('fails closed when an ACTIVE event has no provider timestamp', async () => {
    const storedTombstone = tombstone()
    const tables = createTables({ organizationMembershipTombstones: [storedTombstone] })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'organization_membership.updated', activeMembershipData())

    expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([storedTombstone])
    expect(ctx.db.insert).not.toHaveBeenCalled()
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.db.delete).not.toHaveBeenCalled()
  })

  it('fails closed when the delete-first evidence itself has no provider timestamp', async () => {
    const tables = createTables()
    const ctx = createConvexCtx(tables)

    const deleted = await runSync(ctx, 'organization_membership.deleted', activeMembershipData())

    expect(deleted).toMatchObject({ action: 'workos_membership_tombstoned', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([
      expect.not.objectContaining({ providerUpdatedAt: expect.anything() }),
    ])

    const laterActive = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData('2030-01-01T00:00:00.000Z')
    )

    expect(laterActive).toMatchObject({
      action: 'workos_membership_stale_ignored',
      processed: true,
    })
    expect(tables.organizationMembershipTombstones).toHaveLength(1)
    expect(tables.users).toEqual([])
    expect(tables.organizationMemberships).toEqual([])
    expect(ctx.db.delete).not.toHaveBeenCalled()
  })

  it('makes timestamped evidence unresolved when a later delete omits its provider timestamp', async () => {
    const tables = createTables({ organizationMembershipTombstones: [tombstone()] })
    const ctx = createConvexCtx(tables)

    await runSync(ctx, 'organization_membership.deleted', activeMembershipData())

    expect.soft(tables.organizationMembershipTombstones[0]).not.toHaveProperty('providerUpdatedAt')

    const laterActive = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData('2030-01-01T00:00:00.000Z')
    )

    expect.soft(laterActive).toMatchObject({
      action: 'workos_membership_stale_ignored',
      processed: true,
    })
    expect.soft(tables.organizationMembershipTombstones).toHaveLength(1)
    expect(tables.organizationMemberships).toEqual([])
  })

  it('keeps unresolved tombstones without an age-based TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2040-01-01T00:00:00.000Z')
    const oldEvidence = tombstone(Date.parse('2020-01-01T00:00:00.000Z'))
    const tables = createTables({ organizationMembershipTombstones: [oldEvidence] })
    const ctx = createConvexCtx(tables)

    const result = await runSync(
      ctx,
      'organization_membership.updated',
      activeMembershipData('2020-01-01T00:00:00.000Z')
    )

    expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
    expect(tables.organizationMembershipTombstones).toEqual([oldEvidence])
    expect(ctx.db.delete).not.toHaveBeenCalled()
  })

  it('does not tombstone a stale inactive update that predates the stored membership', async () => {
    const storedAt = Date.parse('2026-07-15T00:00:00.000Z')
    const tables = createTables({
      users: [
        {
          _id: 'local_user',
          _creationTime: 1,
          authProvider: 'workos',
          providerUserId: USER_ID,
          workosUserId: USER_ID,
          email: 'owner@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'local_profile',
          _creationTime: 2,
          userId: 'local_user',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      organizationMemberships: [
        {
          _id: 'local_membership',
          _creationTime: 3,
          userId: 'local_user',
          profileId: 'local_profile',
          authProvider: 'workos',
          providerMembershipId: MEMBERSHIP_ID,
          providerOrgId: ORGANIZATION_ID,
          workosOrgId: ORGANIZATION_ID,
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          providerUpdatedAt: storedAt,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'organization_membership.updated', {
      ...activeMembershipData('2026-07-14T00:00:00.000Z'),
      status: 'inactive',
    })

    expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
    expect(tables.organizationMemberships[0]).toMatchObject({
      status: 'ACTIVE',
      providerUpdatedAt: storedAt,
    })
    expect(tables.organizationMembershipTombstones).toEqual([])
    expect(tables.profiles[0]).toMatchObject({ isActive: true })
  })

  it('tombstones an inactive update with an unmapped role and denies the owner', async () => {
    const storedAt = Date.parse('2026-07-15T00:00:00.000Z')
    const tables = createTables({
      users: [
        {
          _id: 'local_user',
          _creationTime: 1,
          authProvider: 'workos',
          providerUserId: USER_ID,
          workosUserId: USER_ID,
          email: 'owner@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'local_profile',
          _creationTime: 2,
          userId: 'local_user',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      companies: [
        {
          _id: 'company_owner',
          _creationTime: 4,
          ownerId: 'local_profile',
          name: 'SampleFoods',
        },
      ],
      companyOrganizationBindings: [],
      companyAuthorizationControls: [],
      organizationMemberships: [
        {
          _id: 'local_membership',
          _creationTime: 3,
          userId: 'local_user',
          profileId: 'local_profile',
          authProvider: 'workos',
          providerMembershipId: MEMBERSHIP_ID,
          providerOrgId: ORGANIZATION_ID,
          workosOrgId: ORGANIZATION_ID,
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          providerUpdatedAt: storedAt,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'organization_membership.updated', {
      ...activeMembershipData('2026-07-20T00:00:00.000Z', 'member'),
      status: 'inactive',
    })

    expect(result).toMatchObject({ action: 'workos_event_skipped', processed: false })
    expect(tables.organizationMembershipTombstones).toEqual([
      expect.objectContaining({
        authProvider: 'workos',
        providerMembershipId: MEMBERSHIP_ID,
        providerOrgId: ORGANIZATION_ID,
        providerUserId: USER_ID,
      }),
    ])
    expect(tables.organizationMemberships[0]).toMatchObject({
      status: 'ACTIVE',
      providerUpdatedAt: storedAt,
    })
    expect(tables.profiles[0]).toMatchObject({ isActive: true })

    const auth: AuthResult = {
      identity: {
        subject: USER_ID,
        authProvider: 'workos',
      },
      user: tables.users[0] as unknown as Doc<'users'>,
      profile: tables.profiles[0] as unknown as Doc<'profiles'>,
    }
    await expect(
      evaluateCompanyManagementAuthorization(
        ctx as never,
        auth,
        tables.companies[0] as unknown as Doc<'companies'>
      )
    ).resolves.toMatchObject({ authorized: false, reason: 'MEMBERSHIP_REVOKED' })
  })

  it('deactivates the profile when an updated event makes the last membership inactive', async () => {
    const tables = createTables({
      users: [
        {
          _id: 'local_user',
          _creationTime: 1,
          authProvider: 'workos',
          providerUserId: USER_ID,
          workosUserId: USER_ID,
          email: 'owner@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'local_profile',
          _creationTime: 2,
          userId: 'local_user',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      organizationMemberships: [
        {
          _id: 'local_membership',
          _creationTime: 3,
          userId: 'local_user',
          profileId: 'local_profile',
          authProvider: 'workos',
          providerMembershipId: MEMBERSHIP_ID,
          providerOrgId: ORGANIZATION_ID,
          workosOrgId: ORGANIZATION_ID,
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          providerUpdatedAt: DELETED_AT - 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    await runSync(ctx, 'organization_membership.updated', {
      ...activeMembershipData('2026-07-15T00:00:00.000Z'),
      status: 'inactive',
    })

    expect(tables.organizationMemberships[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles[0]).toMatchObject({ isActive: false, deactivatedBy: 'PROVIDER' })
    expect(tables.organizationMembershipTombstones).toHaveLength(1)
  })

  it('deactivates every duplicated exact membership row on delete', async () => {
    const baseMembership = {
      userId: 'local_user',
      profileId: 'local_profile',
      authProvider: 'workos',
      providerMembershipId: MEMBERSHIP_ID,
      providerOrgId: ORGANIZATION_ID,
      workosOrgId: ORGANIZATION_ID,
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
      providerUpdatedAt: DELETED_AT - 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const tables = createTables({
      users: [
        {
          _id: 'local_user',
          _creationTime: 1,
          authProvider: 'workos',
          providerUserId: USER_ID,
          workosUserId: USER_ID,
          email: 'owner@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'local_profile',
          _creationTime: 2,
          userId: 'local_user',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      organizationMemberships: [
        { ...baseMembership, _id: 'duplicate_membership_1', _creationTime: 3 },
        { ...baseMembership, _id: 'duplicate_membership_2', _creationTime: 4 },
      ],
    })
    const ctx = createConvexCtx(tables)

    await runSync(
      ctx,
      'organization_membership.deleted',
      activeMembershipData('2026-07-15T00:00:00.000Z')
    )

    expect(tables.organizationMemberships).toEqual([
      expect.objectContaining({ _id: 'duplicate_membership_1', status: 'INACTIVE' }),
      expect.objectContaining({ _id: 'duplicate_membership_2', status: 'INACTIVE' }),
    ])
    expect(tables.profiles[0]).toMatchObject({ isActive: false, deactivatedBy: 'PROVIDER' })
  })
})
