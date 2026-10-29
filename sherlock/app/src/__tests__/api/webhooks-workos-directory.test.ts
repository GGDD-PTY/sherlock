import { describe, expect, it, vi } from 'vitest'

import { syncWorkosEvent } from '../../../convex/users'

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>

type Filter = {
  field: string
  value: unknown
}

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []

  const indexBuilder = {
    eq: (field: string, value: unknown) => {
      filters.push({ field, value })
      return indexBuilder
    },
  }

  const builder = {
    withIndex: vi.fn(
      (
        _index: string,
        callback?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        filters = []
        callback?.(indexBuilder)
        return builder
      }
    ),
    first: vi.fn(
      async () => rows.find((row) => filters.every((f) => row[f.field] === f.value)) ?? null
    ),
    unique: vi.fn(
      async () => rows.find((row) => filters.every((f) => row[f.field] === f.value)) ?? null
    ),
    collect: vi.fn(async () =>
      rows.filter((row) => filters.every((f) => row[f.field] === f.value))
    ),
    take: vi.fn(async (limit: number) =>
      rows.filter((row) => filters.every((f) => row[f.field] === f.value)).slice(0, limit)
    ),
  }

  return builder
}

function createCtx(seed: Tables = {}) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )
  const insert = vi.fn(async (table: string, doc: Record<string, unknown>) => {
    const id = `${table}_${(tables[table]?.length ?? 0) + 1}`
    tables[table] ??= []
    tables[table].push({ _id: id, ...doc })
    return id
  })
  const patch = vi.fn(async (id: string, doc: Record<string, unknown>) => {
    for (const rows of Object.values(tables)) {
      const row = rows.find((candidate) => candidate._id === id)
      if (row) {
        Object.assign(row, doc)
        return
      }
    }
  })

  const ctx = {
    db: {
      query: vi.fn((table: string) => createQueryBuilder(tables[table] ?? [])),
      insert,
      patch,
      get: vi.fn(async (id: string) => {
        for (const rows of Object.values(tables)) {
          const row = rows.find((candidate) => candidate._id === id)
          if (row) return row
        }
        return { _id: id }
      }),
    },
  }

  return { ctx, tables, insert, patch }
}

const runSyncWorkosEvent = (ctx: unknown, args: { eventType: string; data: unknown }) =>
  (
    syncWorkosEvent as unknown as {
      _handler: (
        ctx: unknown,
        mutationArgs: { eventType: string; data: unknown }
      ) => Promise<unknown>
    }
  )._handler(ctx, args)

describe('WorkOS Directory Sync webhook processing', () => {
  it('persists activated directories and maps approved directory groups to Sherlock roles', async () => {
    const { ctx, tables } = createCtx()

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.activated',
      data: {
        id: 'directory_123',
        organizationId: 'org_123',
        name: 'Acme Capital Directory',
        state: 'active',
        type: 'okta scim v2.0',
        domains: ['acme.example'],
      },
    })

    const groupResult = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.created',
      data: {
        id: 'directory_group_company_member',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        name: 'sherlock:company-member',
      },
    })

    expect(groupResult).toMatchObject({
      action: 'workos_directory_group_synced',
      resourceId: 'directory_group_company_member',
      processed: true,
    })
    expect(tables.workosDirectories?.[0]).toMatchObject({
      directoryId: 'directory_123',
      workosOrgId: 'org_123',
      name: 'Acme Capital Directory',
      active: true,
      state: 'ACTIVE',
    })
    expect(tables.workosDirectoryGroups?.[0]).toMatchObject({
      directoryGroupId: 'directory_group_company_member',
      workosDirectoryId: 'directory_123',
      workosOrgId: 'org_123',
      name: 'sherlock:company-member',
      active: true,
      mappedBetaRole: 'COMPANY_MEMBER',
    })
  })

  it('activates Sherlock membership when a directory user joins an approved role group', async () => {
    const { ctx, tables } = createCtx({
      // dsync.activated siempre llega antes que sus usuarios: la membership
      // solo se escribe ACTIVE con directorio padre verificado activo.
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'issuer@example.com',
          firstName: 'Ana',
          lastName: 'Issuer',
          state: 'active',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(result).toEqual({
      action: 'workos_directory_group_user_added',
      resourceId: 'directory_user_123',
      details: 'Activated Directory Sync membership for directory_user_123',
      processed: true,
    })
    expect(tables.users?.[0]).toMatchObject({
      authProvider: 'workos',
      email: 'issuer@example.com',
      role: 'COMPANY',
    })
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      directoryUserId: 'directory_user_123',
      workosDirectoryId: 'directory_123',
      workosOrgId: 'org_123',
      email: 'issuer@example.com',
      active: true,
      state: 'ACTIVE',
    })
    expect(tables.workosDirectoryGroupMemberships?.[0]).toMatchObject({
      directoryUserId: 'directory_user_123',
      directoryGroupId: 'directory_group_company_owner',
      workosDirectoryId: 'directory_123',
      workosOrgId: 'org_123',
      active: true,
      mappedBetaRole: 'COMPANY_OWNER',
    })
    expect(tables.organizationMemberships?.[0]).toMatchObject({
      workosOrgId: 'org_123',
      workosDirectoryId: 'directory_123',
      workosDirectoryUserId: 'directory_user_123',
      workosDirectoryGroupId: 'directory_group_company_owner',
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
    })
  })

  it('records admin-named directory groups as unmapped and does not create local admins', async () => {
    const { ctx, tables } = createCtx()

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_admin_attempt',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'external-admin@example.com',
          firstName: 'External',
          lastName: 'Admin',
          state: 'active',
        },
        group: {
          id: 'directory_group_admin',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:admin',
        },
      },
    })

    expect(result).toEqual({
      action: 'workos_directory_group_user_added_unmapped',
      resourceId: 'directory_user_admin_attempt',
      details: 'Recorded unmapped Directory Sync group membership for directory_user_admin_attempt',
      processed: true,
    })
    expect(tables.workosDirectoryGroups?.[0]).toMatchObject({
      directoryGroupId: 'directory_group_admin',
      name: 'sherlock:admin',
      active: true,
    })
    expect(tables.workosDirectoryGroups?.[0]).not.toHaveProperty('mappedBetaRole')
    expect(tables.workosDirectoryGroupMemberships?.[0]).not.toHaveProperty('mappedBetaRole')
    expect(tables.users ?? []).toEqual([])
    expect(tables.profiles ?? []).toEqual([])
    expect(tables.organizationMemberships ?? []).toEqual([])
  })

  it('deprovisions directory users by inactivating memberships without deleting local history', async () => {
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryGroupMemberships: [
        {
          _id: 'directory_group_membership_row_1',
          directoryUserId: 'directory_user_123',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          workosDirectoryId: 'directory_123',
          workosDirectoryUserId: 'directory_user_123',
          workosDirectoryGroupId: 'directory_group_company_owner',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    expect(result).toEqual({
      action: 'workos_directory_user_deprovisioned',
      resourceId: 'directory_user_123',
      details: 'Deprovisioned Directory Sync user directory_user_123',
      processed: true,
    })
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      active: false,
      state: 'DELETED',
    })
    expect(tables.organizationMemberships?.[0]).toMatchObject({
      status: 'INACTIVE',
      userId: 'user_row_1',
      profileId: 'profile_row_1',
    })
    expect(tables.users?.[0]).toBeDefined()
    // El deprovision del IdP TIENE que alcanzar el perfil: sin esto, el usuario
    // dado de baja en el directorio seguía autenticándose (hallazgo
    // deprovision-dsync-no-desactiva-perfil). Se marca PROVIDER para que un
    // re-provisioning legítimo del IdP pueda revertirla.
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    expect(patch).toHaveBeenCalledWith(
      'profile_row_1',
      expect.objectContaining({ isActive: false, deactivatedBy: 'PROVIDER' })
    )
  })

  it('keeps the profile active when the user still has an active membership in another organization', async () => {
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          workosDirectoryId: 'directory_123',
          workosDirectoryUserId: 'directory_user_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
        {
          _id: 'membership_row_2',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_456',
          workosOrgId: 'org_456',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    // Multi-org: dar de baja UNA identidad de directorio solo puede alcanzar el
    // perfil cuando no queda ninguna otra presencia activa del proveedor. Con
    // una membership ACTIVE en org_456, el usuario conserva acceso allí.
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.organizationMemberships?.[1]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({ isActive: true })
    expect(patch).not.toHaveBeenCalledWith('profile_row_1', expect.anything())
  })

  it('deactivates the profile when the remaining directory identity belongs to an inactive directory', async () => {
    // Una identidad marcada activa por un dsync.user.* retrasado tras un
    // dsync.deactivated de su directorio NO es presencia vigente: al caer la
    // última presencia genuina, el perfil debe desactivarse (requireAuth gatea
    // por profiles.isActive).
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_2',
          directoryId: 'directory_456',
          workosOrgId: 'org_456',
          active: false,
          state: 'DELETED',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
        {
          // Identidad "activa" stale: su directorio padre (directory_456) ya
          // fue desactivado.
          _id: 'directory_user_row_2',
          directoryUserId: 'directory_user_456',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_456',
          workosOrgId: 'org_456',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          workosDirectoryId: 'directory_123',
          workosDirectoryUserId: 'directory_user_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('still deactivates the profile when the only remaining ACTIVE membership is a legacy clerk row', async () => {
    // Una fila ACTIVE legada de Clerk no es presencia utilizable en el IdP
    // activo (WorkOS): no debe bloquear que el deprovision de dsync alcance el
    // perfil. Sin este filtro, el usuario dado de baja seguía autenticándose.
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          workosDirectoryId: 'directory_123',
          workosDirectoryUserId: 'directory_user_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
        {
          _id: 'membership_row_2',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'clerk',
          providerOrgId: 'org_clerk_legacy',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    expect(patch).toHaveBeenCalledWith(
      'profile_row_1',
      expect.objectContaining({ isActive: false, deactivatedBy: 'PROVIDER' })
    )
  })

  it('does not lift a PROVIDER hold on a delayed group.user_added without verified active state', async () => {
    // Entrega fuera de orden: un dsync.group.user_added retrasado (payload sin
    // `state` explícito) llega después del dsync.user.deleted. El estado
    // guardado del directory user es pegajoso y el hold PROVIDER no se levanta
    // hasta un re-provisioning verificado (state activo explícito).
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'PROVIDER',
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: false,
          state: 'DELETED',
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'issuer@example.com',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({ active: false })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    expect(patch).not.toHaveBeenCalledWith(
      'profile_row_1',
      expect.objectContaining({ isActive: true })
    )
    // Y tampoco reinstala la org membership como ACTIVE: una membership activa
    // autoriza superficies downstream (p.ej. el admin portal de WorkOS).
    for (const membership of tables.organizationMemberships ?? []) {
      expect(membership).toMatchObject({ status: 'INACTIVE' })
    }
  })

  it('does not rewrite roles from a delayed group.user_added on a deprovisioned user', async () => {
    // Un refresh sin estado verificado activo tampoco es autoridad de rol: el
    // grupo mapea COMPANY_OWNER, pero el usuario deprovisionado conserva su rol
    // local (users.role y profiles.role) hasta un re-provisioning verificado.
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'investor@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'PROVIDER',
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'investor@example.com',
          active: false,
          state: 'DELETED',
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'investor@example.com',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(tables.users?.[0]).toMatchObject({ role: 'COMPANY' })
    expect(tables.profiles?.[0]).toMatchObject({
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    expect(patch).not.toHaveBeenCalledWith(
      'user_row_1',
      expect.objectContaining({ role: 'COMPANY' })
    )
  })

  it('deactivates direct org memberships on a directory shutdown when the identity lacks its own org mapping', async () => {
    // dsync.deactivated de directorio completo: la identidad guardada no tiene
    // workosOrgId propio (payload dsync aceptado sin organizationId), así que
    // la org se resuelve vía el PADRE. Sin esa resolución, la membership
    // directa (sin workosDirectoryUserId) de esa misma org quedaba ACTIVE y
    // bloqueaba la desactivación del perfil.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          // Sin workosOrgId propio: la org solo es conocible vía el padre.
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          // Membership directa (sin workosDirectoryUserId) de la misma org.
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.deactivated',
      data: {
        // Payload sin organizationId: se ejercita el fallback a la fila
        // almacenada del directorio.
        id: 'directory_123',
      },
    })

    expect(tables.workosDirectories?.[0]).toMatchObject({ active: false })
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({ active: false })
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('ignores a stale directory shutdown that predates the stored provider watermark', async () => {
    // Entrega invertida: un dsync.deactivated viejo (T1) llega DESPUÉS de la
    // re-activación (T3, watermark providerUpdatedAt persistido). Sin ordenación
    // causal del propio directorio, el shutdown retrasado marcaría cada hijo
    // inactivo con deprovisionedAt=T1 y tumbaría sus perfiles con marca
    // PROVIDER sin que nada los restaurara.
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
          providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.deactivated',
      data: {
        id: 'directory_123',
        organizationId: 'org_123',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    })

    expect(result).toMatchObject({
      action: 'workos_directory_stale_ignored',
      processed: true,
    })
    // Nada se toca: ni el directorio ni sus hijos ni la membership ni el perfil.
    expect(patch).not.toHaveBeenCalled()
    expect(tables.workosDirectories?.[0]).toMatchObject({
      active: true,
      state: 'ACTIVE',
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
    })
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({ active: true, state: 'ACTIVE' })
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({ isActive: true })
  })

  it('persists the directory provider watermark on activation and applies a genuinely newer shutdown', async () => {
    // Round-trip legítimo: dsync.activated (T3) persiste el watermark del
    // proveedor y un dsync.deactivated POSTERIOR (T4) sí aplica el shutdown.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.activated',
      data: {
        id: 'directory_123',
        organizationId: 'org_123',
        state: 'active',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    })

    expect(tables.workosDirectories?.[0]).toMatchObject({
      active: true,
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
    })

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.deactivated',
      data: {
        id: 'directory_123',
        organizationId: 'org_123',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    })

    expect(result).toMatchObject({
      action: 'workos_directory_deactivated',
      processed: true,
    })
    expect(tables.workosDirectories?.[0]).toMatchObject({
      active: false,
      providerUpdatedAt: Date.parse('2026-07-20T00:00:00.000Z'),
    })
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      active: false,
      deprovisionedAt: Date.parse('2026-07-20T00:00:00.000Z'),
    })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('deactivates direct org memberships on dsync.user.deleted when only the parent knows the org', async () => {
    // Payload sin organizationId E identidad almacenada sin workosOrgId: la
    // org solo es conocible vía el directorio PADRE. Sin esa resolución, la
    // membership directa (sin workosDirectoryUserId) quedaba ACTIVE y
    // bloqueaba la desactivación del perfil.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          // Sin workosOrgId propio: la org solo es conocible vía el padre.
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          // Membership directa (sin workosDirectoryUserId) de la misma org.
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        // Payload sin organizationId.
        id: 'directory_user_123',
        directoryId: 'directory_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({ active: false })
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'INACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('does not rewrite roles from an explicitly active child under an inactive parent directory', async () => {
    // Un dsync.group.user_added retrasado puede embeber al usuario con state
    // activo EXPLÍCITO después de que el directorio padre fue desactivado. El
    // estado verificado del padre manda también para la autoridad de rol:
    // ni users.role ni profiles.role se reescriben, ni se levanta el hold.
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'investor@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'PROVIDER',
        },
      ],
      workosDirectories: [
        {
          // Directorio padre YA desactivado.
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: false,
          state: 'DELETED',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'investor@example.com',
          active: false,
          state: 'DELETED',
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'investor@example.com',
          // Estado activo EXPLÍCITO embebido en el evento retrasado.
          state: 'active',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(tables.users?.[0]).toMatchObject({ role: 'COMPANY' })
    expect(tables.profiles?.[0]).toMatchObject({
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    expect(patch).not.toHaveBeenCalledWith(
      'user_row_1',
      expect.objectContaining({ role: 'COMPANY' })
    )
    for (const membership of tables.organizationMemberships ?? []) {
      expect(membership).toMatchObject({ status: 'INACTIVE' })
    }
  })

  it('rejects a stale explicitly active child that predates the stored dsync deprovision', async () => {
    // Un dsync.group.user_added retrasado puede embeber al hijo con state
    // 'active' EXPLÍCITO después de un dsync.user.deleted individual ya
    // aplicado, con el directorio padre todavía activo. El estado explícito
    // también se ordena causalmente: si los timestamps del proveedor no
    // postdatan el deprovisionedAt almacenado, el evento es viejo y no levanta
    // el hold PROVIDER ni reescribe roles ni reinstala la membership.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'investor@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'PROVIDER',
        },
      ],
      workosDirectories: [
        {
          // El directorio padre sigue ACTIVO: fue un dsync.user.deleted
          // individual, no un shutdown del directorio.
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'investor@example.com',
          active: false,
          state: 'DELETED',
          deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'investor@example.com',
          state: 'active',
          // Timestamps del OBJETO anteriores al deprovision almacenado.
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(tables.users?.[0]).toMatchObject({ role: 'COMPANY' })
    expect(tables.profiles?.[0]).toMatchObject({
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
    // La identidad sigue deprovisionada y el watermark no se mueve.
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      active: false,
      deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
    })
    for (const membership of tables.organizationMemberships ?? []) {
      expect(membership).toMatchObject({ status: 'INACTIVE' })
    }
  })

  it('lifts the hold when the explicitly active child postdates the stored dsync deprovision', async () => {
    // Round-trip legítimo del IdP: un re-alta cuyos timestamps del proveedor
    // POSTDATAN el deprovisionedAt almacenado sí prueba re-provisioning y
    // levanta el hold PROVIDER.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'investor@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'PROVIDER',
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'investor@example.com',
          active: false,
          state: 'DELETED',
          deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
        },
      ],
      workosDirectoryGroups: [
        {
          _id: 'directory_group_row_1',
          directoryGroupId: 'directory_group_company_owner',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          name: 'sherlock:company-owner',
          active: true,
          mappedBetaRole: 'COMPANY_OWNER',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.group.user_added',
      data: {
        directoryId: 'directory_123',
        user: {
          id: 'directory_user_123',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          email: 'investor@example.com',
          state: 'active',
          // Timestamps del OBJETO posteriores al deprovision almacenado.
          updatedAt: '2026-07-15T00:00:00.000Z',
        },
        group: {
          id: 'directory_group_company_owner',
          directoryId: 'directory_123',
          organizationId: 'org_123',
          name: 'sherlock:company-owner',
        },
      },
    })

    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({ active: true })
    expect(tables.users?.[0]).toMatchObject({ role: 'COMPANY' })
    expect(tables.profiles?.[0]).toMatchObject({ role: 'COMPANY', isActive: true })
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'ACTIVE' })
  })

  it('does not regress the deprovision watermark on a stale dsync.user.deleted redelivery', async () => {
    // Entrega retrasada de un deprovision MÁS VIEJO que la evidencia
    // almacenada: no se re-ejecuta el deprovision con su timestamp. Si
    // retrocediera el watermark (T2 → T1), una réplica apenas más nueva (pero
    // aún anterior al deprovision real) pasaría a postdatarlo y levantaría el
    // hold; y la membership re-otorgada después del deprovision (T3) no debe
    // tumbarse.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          // Hold ya levantado por el alta directa posterior al deprovision.
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: false,
          state: 'DELETED',
          deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          providerUpdatedAt: Date.parse('2026-07-12T00:00:00.000Z'),
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
        // Más viejo que el deprovisionedAt almacenado.
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    })

    // El watermark almacenado no retrocede ni avanza.
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      active: false,
      deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
    })
    // La membership re-otorgada tras el deprovision y el perfil sobreviven.
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({ isActive: true })
  })

  it('keeps a newer direct membership alive when an older dsync deprovision arrives late', async () => {
    // Entrega INVERTIDA: el alta directa (posterior según el proveedor) se
    // procesó primero; el dsync.user.deleted más viejo llega después. El
    // evento retrasado no puede tumbar la membership ni el perfil cuya
    // evidencia almacenada (providerUpdatedAt) postdata el deprovision.
    const { ctx, tables } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: true,
        },
      ],
      workosDirectories: [
        {
          _id: 'directory_row_1',
          directoryId: 'directory_123',
          workosOrgId: 'org_123',
          active: true,
          state: 'ACTIVE',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
      organizationMemberships: [
        {
          // Alta directa YA procesada, con evidencia causal del proveedor
          // posterior al deprovision que llega tarde.
          _id: 'membership_row_1',
          userId: 'user_row_1',
          profileId: 'profile_row_1',
          authProvider: 'workos',
          providerOrgId: 'org_123',
          workosOrgId: 'org_123',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
          createdAt: 1,
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    })

    // La identidad de directorio sí cae, con el momento del PROVEEDOR.
    expect(tables.workosDirectoryUsers?.[0]).toMatchObject({
      active: false,
      deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
    })
    // Pero la membership directa más nueva y el perfil sobreviven.
    expect(tables.organizationMemberships?.[0]).toMatchObject({ status: 'ACTIVE' })
    expect(tables.profiles?.[0]).toMatchObject({ isActive: true })
  })

  it('does not overwrite an admin (AML) deactivation mark when the IdP deprovisions the same user', async () => {
    const { ctx, tables, patch } = createCtx({
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'directory_user_123',
          workosUserId: 'directory_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [
        {
          _id: 'profile_row_1',
          userId: 'user_row_1',
          role: 'COMPANY',
          isActive: false,
          deactivatedBy: 'ADMIN',
          deactivationReason: 'AML review',
        },
      ],
      workosDirectoryUsers: [
        {
          _id: 'directory_user_row_1',
          directoryUserId: 'directory_user_123',
          userId: 'user_row_1',
          workosDirectoryId: 'directory_123',
          workosOrgId: 'org_123',
          email: 'issuer@example.com',
          active: true,
          state: 'ACTIVE',
        },
      ],
    })

    await runSyncWorkosEvent(ctx, {
      eventType: 'dsync.user.deleted',
      data: {
        id: 'directory_user_123',
        directoryId: 'directory_123',
        organizationId: 'org_123',
        email: 'issuer@example.com',
        state: 'inactive',
      },
    })

    // La marca ADMIN sobrevive al deprovision: si no, el round-trip
    // deprovision→re-provision del IdP la relavaría a PROVIDER y la
    // reactivación automática volvería a estar permitida.
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'ADMIN',
      deactivationReason: 'AML review',
    })
    expect(patch).not.toHaveBeenCalledWith('profile_row_1', expect.anything())
  })
})

describe('WorkOS authoritative reactivation guard', () => {
  const membershipEvent = {
    eventType: 'organization_membership.created',
    data: {
      id: 'membership_123',
      userId: 'workos_user_123',
      organizationId: 'org_123',
      // OJO: el mapa de membership (WORKOS_ROLE_MAP) usa guion bajo y NO
      // normaliza el slug — 'company-owner' haría syncSkipped y el test
      // pasaría sin ejercitar el guard de reactivación.
      role: { slug: 'company_owner' },
      status: 'active',
      user: {
        id: 'workos_user_123',
        email: 'issuer@example.com',
        firstName: 'Ana',
        lastName: 'Issuer',
      },
    },
  }

  function seedForMembership(profile: Row) {
    return {
      users: [
        {
          _id: 'user_row_1',
          authProvider: 'workos',
          providerUserId: 'workos_user_123',
          workosUserId: 'workos_user_123',
          email: 'issuer@example.com',
          role: 'COMPANY',
        },
      ],
      profiles: [profile],
    }
  }

  it('does not let an authoritative membership event reactivate a profile deactivated by an admin', async () => {
    // Este es el blocker dsync-reactiva-perfil-suspendido: un evento con rol
    // autoritativo (organization_membership.* / dsync.*) reactivaba
    // incondicionalmente un perfil suspendido por AML/fraude.
    const { ctx, tables } = createCtx(
      seedForMembership({
        _id: 'profile_row_1',
        userId: 'user_row_1',
        role: 'COMPANY',
        isActive: false,
        deactivatedBy: 'ADMIN',
        deactivationReason: 'AML review',
      })
    )

    await runSyncWorkosEvent(ctx, membershipEvent)

    expect(tables.profiles?.[0]).toMatchObject({
      isActive: false,
      deactivatedBy: 'ADMIN',
    })
  })

  it('does not reactivate a legacy deactivated profile without an origin mark (fail closed)', async () => {
    const { ctx, tables } = createCtx(
      seedForMembership({
        _id: 'profile_row_1',
        userId: 'user_row_1',
        role: 'COMPANY',
        isActive: false,
      })
    )

    await runSyncWorkosEvent(ctx, membershipEvent)

    // Un perfil desactivado antes de que existiera deactivatedBy pudo haberlo
    // sido por un admin: sin origen conocido, la reactivación queda en manos
    // humanas, nunca de un webhook.
    expect(tables.profiles?.[0]).toMatchObject({ isActive: false })
  })

  it('reactivates a provider-deactivated profile on an authoritative event and clears the mark', async () => {
    const { ctx, tables } = createCtx(
      seedForMembership({
        _id: 'profile_row_1',
        userId: 'user_row_1',
        role: 'COMPANY',
        isActive: false,
        deactivatedBy: 'PROVIDER',
      })
    )

    await runSyncWorkosEvent(ctx, membershipEvent)

    // El round-trip del IdP (deprovision → re-provision) sí debe funcionar solo.
    expect(tables.profiles?.[0]).toMatchObject({
      isActive: true,
      deactivatedBy: undefined,
      deactivationReason: undefined,
    })
  })
})
