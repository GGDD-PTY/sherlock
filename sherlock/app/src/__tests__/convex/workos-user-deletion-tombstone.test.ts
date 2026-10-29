// user.deleted sin fila local no dejaba marca. El membership siguiente
// creaba usuario y perfil activos. El marcador tiene que sobrevivir a
// ese orden y bloquear el alta.

import { describe, expect, it } from 'vitest'

import { syncWorkosEvent } from '../../../convex/users'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const WORKOS_USER_ID = 'user_deleted_before_local'

function emptyTables(): Tables {
  return {
    users: [],
    profiles: [],
    organizationMemberships: [],
    organizationMembershipTombstones: [],
    providerUserTombstones: [],
    companies: [],
  }
}

function runSync(ctx: unknown, eventType: string, data: unknown) {
  return runHandler<{ eventType: string; data: unknown }, { action: string; processed: boolean }>(
    syncWorkosEvent,
    ctx,
    { eventType, data }
  )
}

describe('WorkOS user.deleted without a local row', () => {
  it('leaves a provider-user tombstone and refuses a later active membership', async () => {
    const tables = emptyTables()
    const ctx = createConvexCtx(tables)

    const deleted = await runSync(ctx, 'user.deleted', { id: WORKOS_USER_ID })

    expect(deleted).toMatchObject({ action: 'workos_user_delete_noop', processed: true })
    expect(tables.providerUserTombstones).toEqual([
      expect.objectContaining({
        authProvider: 'workos',
        providerUserId: WORKOS_USER_ID,
      }),
    ])
    expect(tables.users).toEqual([])

    const membership = await runSync(ctx, 'organization_membership.created', {
      id: 'om_after_delete',
      userId: WORKOS_USER_ID,
      organizationId: 'org_after_delete',
      organizationName: 'Emisora',
      status: 'active',
      role: { slug: 'company_owner' },
      updatedAt: '2026-08-01T00:00:00.000Z',
    })

    expect(membership).toMatchObject({ action: 'workos_user_deleted_ignored', processed: true })
    expect(tables.users).toEqual([])
    expect(tables.profiles).toEqual([])
    expect(tables.organizationMemberships).toEqual([])
    expect(tables.providerUserTombstones).toHaveLength(1)
  })

  it('refuses user.created after a delete that arrived first', async () => {
    const tables = emptyTables()
    const ctx = createConvexCtx(tables)

    await runSync(ctx, 'user.deleted', { id: WORKOS_USER_ID })
    const created = await runSync(ctx, 'user.created', {
      id: WORKOS_USER_ID,
      email: 'deleted@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    })

    expect(created).toMatchObject({ action: 'workos_user_deleted_ignored', processed: true })
    expect(tables.users).toEqual([])
    expect(tables.profiles).toEqual([])
  })

  it('still deactivates a local profile and records the same marker', async () => {
    const tables = emptyTables()
    tables.users = [
      {
        _id: 'user_local',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: WORKOS_USER_ID,
        workosUserId: WORKOS_USER_ID,
        email: 'deleted@example.com',
        role: 'COMPANY',
      },
    ]
    tables.profiles = [
      {
        _id: 'profile_local',
        _creationTime: 2,
        userId: 'user_local',
        role: 'COMPANY',
        isActive: true,
      },
    ]
    const ctx = createConvexCtx(tables)

    const deleted = await runSync(ctx, 'user.deleted', { id: WORKOS_USER_ID })

    expect(deleted).toMatchObject({ action: 'workos_user_deactivated', processed: true })
    expect(tables.profiles[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
      deactivationReason: 'workos:user.deleted',
    })
    expect(tables.providerUserTombstones).toHaveLength(1)

    const membership = await runSync(ctx, 'organization_membership.updated', {
      id: 'om_after_local_delete',
      userId: WORKOS_USER_ID,
      organizationId: 'org_after_delete',
      status: 'active',
      role: { slug: 'company_owner' },
      updatedAt: '2026-08-02T00:00:00.000Z',
    })

    expect(membership).toMatchObject({ action: 'workos_user_deleted_ignored', processed: true })
    expect(tables.profiles[0]).toMatchObject({ isActive: false })
    expect(tables.organizationMemberships).toEqual([])
  })
})
