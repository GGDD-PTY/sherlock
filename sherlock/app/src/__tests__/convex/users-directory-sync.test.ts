import { describe, expect, it } from 'vitest'

import { syncWorkosEvent } from '../../../convex/users'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

type SyncResult = {
  action: string
  resourceId?: string
  details: string
  processed: boolean
}

function runSync(ctx: unknown, eventType: string, data: unknown) {
  return runHandler<{ eventType: string; data: unknown }, SyncResult>(syncWorkosEvent, ctx, {
    eventType,
    data,
  })
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'user_workos_1',
        workosUserId: 'user_workos_1',
        email: 'fixture-befbb74d@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
        fullName: 'Sample Owner',
      },
    ],
    workosDirectories: [],
    workosDirectoryUsers: [],
    workosDirectoryGroups: [],
    workosDirectoryGroupMemberships: [],
    organizationMemberships: [],
    investors: [],
    companies: [],
    ...overrides,
  }
}

describe('users.syncWorkosEvent directory', () => {
  it('skips payloads without ids and unknown event types', async () => {
    const ctx = createConvexCtx(baseTables())

    const missing = await runSync(ctx, 'dsync.activated', { name: 'sin id' })
    const unknown = await runSync(ctx, 'organization.created', { id: 'org_1' })

    expect(missing).toMatchObject({ action: 'workos_event_skipped', processed: false })
    expect(unknown).toMatchObject({ action: 'workos_event_skipped', processed: false })
  })

  it('activates a directory and records domains from the payload', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.activated', {
      id: 'dir_1',
      name: 'Sample Directory',
      type: 'okta',
      organizationId: 'org_1',
      domains: ['sampleenergy.test', 'company.example'],
      state: 'linked',
      updatedAt: '2026-09-01T12:00:00.000Z',
    })

    expect(result).toMatchObject({
      action: 'workos_directory_synced',
      resourceId: 'dir_1',
      processed: true,
    })
    expect(tables.workosDirectories[0]).toMatchObject({
      directoryId: 'dir_1',
      name: 'Sample Directory',
      workosOrgId: 'org_1',
      domains: ['sampleenergy.test', 'company.example'],
      state: 'ACTIVE',
      active: true,
    })
  })

  it('ignores a stale directory event that predates the stored watermark', async () => {
    const tables = baseTables({
      workosDirectories: [
        {
          _id: 'dir_row',
          directoryId: 'dir_1',
          active: true,
          state: 'ACTIVE',
          providerUpdatedAt: Date.parse('2026-09-10T00:00:00.000Z'),
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.deactivated', {
      id: 'dir_1',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })

    expect(result.action).toBe('workos_directory_stale_ignored')
    expect(tables.workosDirectories[0]).toMatchObject({ active: true })
  })

  it('deactivates directory users and the local profile on dsync.deactivated', async () => {
    const tables = baseTables({
      workosDirectories: [
        {
          _id: 'dir_row',
          directoryId: 'dir_1',
          workosOrgId: 'org_1',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'du_1',
          directoryUserId: 'du_1',
          workosDirectoryId: 'dir_1',
          userId: 'user_owner',
          workosOrgId: 'org_1',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          _id: 'mem_1',
          userId: 'user_owner',
          workosDirectoryUserId: 'du_1',
          workosOrgId: 'org_1',
          authProvider: 'workos',
          status: 'ACTIVE',
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.deactivated', {
      id: 'dir_1',
      organizationId: 'org_1',
      state: 'inactive',
    })

    expect(result.action).toBe('workos_directory_deactivated')
    expect(tables.workosDirectoryUsers[0]).toMatchObject({ active: false })
    expect(tables.organizationMemberships[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('syncs a directory group from its product name', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.group.created', {
      id: 'group_1',
      directoryId: 'dir_1',
      organizationId: 'org_1',
      name: 'Sherlock Company Owners',
      state: 'active',
    })

    expect(result.action).toBe('workos_directory_group_synced')
    expect(tables.workosDirectoryGroups[0]).toMatchObject({
      directoryGroupId: 'group_1',
      mappedBetaRole: 'COMPANY_OWNER',
      active: true,
    })
  })

  it('deletes a group and drops its active memberships', async () => {
    const tables = baseTables({
      workosDirectoryGroups: [
        {
          _id: 'group_row',
          directoryGroupId: 'group_1',
          workosDirectoryId: 'dir_1',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryGroupMemberships: [
        {
          _id: 'gm_1',
          directoryGroupId: 'group_1',
          directoryUserId: 'du_1',
          workosOrgId: 'org_1',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.group.deleted', {
      id: 'group_1',
      directory_id: 'dir_1',
    })

    expect(result.action).toBe('workos_directory_group_deactivated')
    expect(tables.workosDirectoryGroupMemberships[0]).toMatchObject({ active: false })
  })

  it('syncs a directory user and deprovisions on delete', async () => {
    const tables = baseTables({
      workosDirectories: [
        {
          _id: 'dir_row',
          directoryId: 'dir_1',
          active: true,
          state: 'ACTIVE',
        },
      ],
    })
    const ctx = createConvexCtx(tables)

    const created = await runSync(ctx, 'dsync.user.created', {
      id: 'du_1',
      directoryId: 'dir_1',
      organizationId: 'org_1',
      email: 'fixture-befbb74d@example.com',
      firstName: 'Sample',
      lastName: 'Owner',
      userId: 'user_workos_1',
      state: 'active',
    })
    expect(created.action).toBe('workos_directory_user_synced')
    expect(tables.workosDirectoryUsers[0]).toMatchObject({
      directoryUserId: 'du_1',
      email: 'fixture-befbb74d@example.com',
      firstName: 'Sample',
      active: true,
    })

    const deleted = await runSync(ctx, 'dsync.user.deleted', {
      id: 'du_1',
      directoryId: 'dir_1',
      userId: 'user_workos_1',
      updatedAt: Date.now() + 1_000,
    })
    expect(deleted.action).toBe('workos_directory_user_deprovisioned')
    expect(tables.workosDirectoryUsers[0]).toMatchObject({ active: false, state: 'DELETED' })
    expect(tables.profiles[0]).toMatchObject({ isActive: false, deactivatedBy: 'PROVIDER' })
  })

  it('adds a mapped group membership and then removes it', async () => {
    const tables = baseTables({
      workosDirectories: [
        {
          _id: 'dir_row',
          directoryId: 'dir_1',
          active: true,
          state: 'ACTIVE',
          workosOrgId: 'org_1',
        },
      ],
    })
    const ctx = createConvexCtx(tables)
    const user = {
      id: 'du_1',
      directoryId: 'dir_1',
      organizationId: 'org_1',
      email: 'fixture-befbb74d@example.com',
      userId: 'user_workos_1',
      state: 'active',
    }
    const group = {
      id: 'group_1',
      directoryId: 'dir_1',
      organizationId: 'org_1',
      name: 'sherlock_company_owners',
      state: 'active',
    }

    const added = await runSync(ctx, 'dsync.group.user_added', { user, group })
    expect(added.action).toBe('workos_directory_group_user_added')
    expect(tables.workosDirectoryGroupMemberships[0]).toMatchObject({
      directoryUserId: 'du_1',
      mappedBetaRole: 'COMPANY_OWNER',
      active: true,
    })
    expect(tables.organizationMemberships[0]).toMatchObject({
      status: 'ACTIVE',
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
    })

    const removed = await runSync(ctx, 'dsync.group.user_removed', { user, group })
    expect(removed.action).toBe('workos_directory_group_user_removed')
    expect(tables.workosDirectoryGroupMemberships[0]).toMatchObject({ active: false })
  })

  it('records an unmapped group membership without promoting a role', async () => {
    const tables = baseTables({
      workosDirectories: [{ _id: 'dir_row', directoryId: 'dir_1', active: true, state: 'ACTIVE' }],
    })
    const ctx = createConvexCtx(tables)

    const result = await runSync(ctx, 'dsync.group.user_added', {
      user: {
        id: 'du_1',
        directoryId: 'dir_1',
        email: 'fixture-befbb74d@example.com',
        userId: 'user_workos_1',
        state: 'active',
      },
      group: {
        id: 'group_other',
        directoryId: 'dir_1',
        name: 'Finance team',
        state: 'active',
      },
    })

    expect(result.action).toBe('workos_directory_group_user_added_unmapped')
  })
})
