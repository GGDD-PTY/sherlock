import { describe, expect, it, vi } from 'vitest'

import { syncWorkosEvent } from '../../../convex/users'

type QueryRow = Record<string, unknown>
type QueryResult = QueryRow | QueryRow[] | null

type QueryCall = {
  table: string
  index?: string
  values?: unknown[]
}

function createQueryBuilder(
  result: QueryResult | ((index?: string) => QueryResult),
  calls: QueryCall[],
  table: string
) {
  let selectedIndex: string | undefined
  const rows = () => {
    const resolved = typeof result === 'function' ? result(selectedIndex) : result
    return Array.isArray(resolved) ? resolved : resolved ? [resolved] : []
  }
  const builder = {
    withIndex: vi.fn(
      (
        index: string,
        callback?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        selectedIndex = index
        const values: unknown[] = []
        const indexBuilder = {
          eq: (_field: string, value: unknown) => {
            values.push(value)
            return indexBuilder
          },
        }
        callback?.(indexBuilder)
        calls.push({ table, index, values })
        return builder
      }
    ),
    first: vi.fn(async () => rows()[0] ?? null),
    unique: vi.fn(async () => rows()[0] ?? null),
    collect: vi.fn(async () => rows()),
    take: vi.fn(async (count: number) => rows().slice(0, count)),
  }

  return builder
}

function createCtx(results: QueryResult[] = []) {
  const calls: QueryCall[] = []
  const insert = vi.fn(async (table: string) => `new_${table}_id`)
  const patch = vi.fn()
  const deleteRow = vi.fn()
  let queryCount = 0

  const ctx = {
    db: {
      query: vi.fn((table: string) => {
        // Membership tombstones are covered with the stateful Convex harness
        // in workos-membership-tombstones.test.ts. Keep this legacy
        // queue-based harness backwards-compatible for the pre-existing sync
        // cases: the new guard must observe an empty tombstone set without
        // shifting every later query fixture.
        if (
          table === 'organizationMembershipTombstones' ||
          table === 'providerUserTombstones'
        ) {
          return createQueryBuilder([], calls, table)
        }
        if (table === 'organizationMemberships') {
          let loaded = false
          let queuedResult: QueryResult = null
          return createQueryBuilder(
            (index) => {
              // Exact provider-membership lookup is new. Existing queue-based
              // fixtures model legacy rows, so an empty exact result must not
              // consume or shift the historical organization query fixture.
              if (index === 'by_providerMembershipId') return []
              if (!loaded) {
                queuedResult = results[queryCount] ?? null
                queryCount += 1
                loaded = true
              }
              return queuedResult
            },
            calls,
            table
          )
        }
        const result = results[queryCount] ?? null
        queryCount += 1
        return createQueryBuilder(result, calls, table)
      }),
      insert,
      patch,
      delete: deleteRow,
      get: vi.fn(async (id: string) => ({ _id: id })),
    },
  }

  return { ctx, calls, insert, patch, deleteRow }
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

describe('WorkOS Convex sync', () => {
  it('upserts WorkOS users by provider id', async () => {
    const { ctx, insert, patch, calls } = createCtx([null, null, null, null, null])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'user.created',
      data: {
        id: 'user_workos_123',
        email: 'founder@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: true,
        profilePictureUrl: 'https://example.com/ada.png',
      },
    })

    expect(result).toEqual({
      action: 'workos_user_synced',
      resourceId: 'user_workos_123',
      details: 'Synced WorkOS user user_workos_123',
      processed: true,
    })
    expect(calls.map((call) => call.index)).toEqual([
      'by_providerUserId',
      'by_providerUserId',
      'by_workosUserId',
      'by_clerkId',
      'by_email',
      // ensureWorkosUser mira el marcador de user.deleted antes de insertar.
      'by_providerUserId',
      'by_userId',
      'by_userId',
    ])
    expect(insert).toHaveBeenCalledWith(
      'users',
      expect.objectContaining({
        authProvider: 'workos',
        providerUserId: 'user_workos_123',
        workosUserId: 'user_workos_123',
        email: 'founder@example.com',
        name: 'Ada Lovelace',
        image: 'https://example.com/ada.png',
        emailVerified: true,
      })
    )
    // La semilla del perfil nuevo es COMPANY desde el pivot sell-side
    // ([F] 2026-08-15): el signup self-serve es siempre una empresa.
    expect(insert).toHaveBeenCalledWith(
      'profiles',
      expect.objectContaining({
        userId: 'new_users_id',
        role: 'COMPANY',
        language: 'es',
        timezone: 'America/Panama',
        isActive: true,
      })
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('does not downgrade an existing COMPANY profile on user.updated', async () => {
    // Los usuarios creados por el webhook `user.created` quedan sin `role` en
    // `users`; el rol de producto real vive en `profiles.role`. Un
    // `user.updated` (cambio de nombre, verificación de email, reset de
    // password) NO debe re-derivar el rol desde `users.role`.
    const existingUser = {
      _id: 'user_convex_company',
      authProvider: 'workos',
      providerUserId: 'user_workos_company',
      workosUserId: 'user_workos_company',
      email: 'founder@example.com',
    }
    const existingProfile = {
      _id: 'profile_convex_company',
      userId: 'user_convex_company',
      role: 'COMPANY',
      isActive: true,
    }
    const { ctx, insert, patch } = createCtx([existingUser, existingProfile])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'user.updated',
      data: {
        id: 'user_workos_company',
        email: 'founder@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: true,
      },
    })

    expect(result).toMatchObject({ action: 'workos_user_synced', processed: true })
    expect(insert).not.toHaveBeenCalled()
    // El perfil no se toca en absoluto: ni rol ni ningún otro campo.
    expect(patch).not.toHaveBeenCalledWith('profile_convex_company', expect.anything())
  })

  it('does not downgrade an existing ADMIN profile on user.updated', async () => {
    const existingUser = {
      _id: 'user_convex_admin',
      authProvider: 'workos',
      providerUserId: 'user_workos_admin',
      workosUserId: 'user_workos_admin',
      email: 'admin@example.com',
      // `users.role` stale: el admin fue promovido vía `setProfileRole` cuando
      // esa mutación todavía no sincronizaba `users.role`.
      role: 'COMPANY',
    }
    const existingProfile = {
      _id: 'profile_convex_admin',
      userId: 'user_convex_admin',
      role: 'ADMIN',
      isActive: true,
    }
    const { ctx, patch } = createCtx([existingUser, existingProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'user.updated',
      data: {
        id: 'user_workos_admin',
        email: 'admin@example.com',
        firstName: 'Admin',
        lastName: 'Sherlock',
        emailVerified: true,
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_admin',
      expect.objectContaining({ role: 'COMPANY' })
    )
  })

  it('does not reactivate a deactivated profile on user.updated', async () => {
    // Un `user.updated` de WorkOS llega por eventos triviales (foto nueva,
    // verificación de email, reset de password). Si ese path reactivara la
    // cuenta, ninguna desactivación administrativa sobreviviría al siguiente
    // cambio de perfil que el propio usuario haga en el IdP.
    const existingUser = {
      _id: 'user_convex_disabled',
      authProvider: 'workos',
      providerUserId: 'user_workos_disabled',
      workosUserId: 'user_workos_disabled',
      email: 'suspendido@example.com',
    }
    const existingProfile = {
      _id: 'profile_convex_disabled',
      userId: 'user_convex_disabled',
      role: 'COMPANY',
      isActive: false,
    }
    const { ctx, patch } = createCtx([existingUser, existingProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'user.updated',
      data: {
        id: 'user_workos_disabled',
        email: 'suspendido@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: true,
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_disabled',
      expect.objectContaining({ isActive: true })
    )
  })

  it('BRECHA CERRADA (2026-07-30): un evento con rol autoritativo ya NO reactiva una cuenta desactivada sin marca PROVIDER', async () => {
    // La versión anterior de este test documentaba la brecha abierta y exigía
    // que quien implementara la desactivación pegajosa viniera a actualizarlo.
    // Hecho: `profiles.deactivatedBy` separa el origen — solo una desactivación
    // marcada PROVIDER (user.deleted / deprovision dsync) se deja pisar por el
    // sync. ADMIN/USER y los perfiles legacy sin marca (como este, desactivado
    // por AML antes del cambio) son pegajosos: la reactivación es humana.
    // El caso PROVIDER-sí-reactiva vive en webhooks-workos-directory.test.ts.
    const existingUser = {
      _id: 'user_convex_aml',
      authProvider: 'workos',
      providerUserId: 'user_workos_aml',
      workosUserId: 'user_workos_aml',
      email: 'aml-hold@example.com',
    }
    const existingProfile = {
      _id: 'profile_convex_aml',
      userId: 'user_convex_aml',
      role: 'COMPANY',
      isActive: false,
    }
    const { ctx, patch } = createCtx([existingUser, [], [], existingProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_aml',
        userId: 'user_workos_aml',
        organizationId: 'org_workos_aml',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_aml',
      expect.objectContaining({ isActive: true })
    )
  })

  it('does not lift a PROVIDER hold on a membership event whose status is not active', async () => {
    // Un membership con status inactivo (o llegado fuera de orden tras un
    // deprovision) no prueba presencia vigente en el IdP: solo un evento
    // autoritativo ACTIVO puede levantar un hold PROVIDER.
    const existingUser = {
      _id: 'user_convex_provider_hold',
      authProvider: 'workos',
      providerUserId: 'user_workos_provider_hold',
      workosUserId: 'user_workos_provider_hold',
      email: 'deprovisioned@example.com',
    }
    const existingProfile = {
      _id: 'profile_convex_provider_hold',
      userId: 'user_convex_provider_hold',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([existingUser, [], existingProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_provider_hold',
        userId: 'user_workos_provider_hold',
        organizationId: 'org_workos_hold',
        organizationName: 'Capital Example',
        status: 'inactive',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_provider_hold',
      expect.objectContaining({ isActive: true })
    )
  })

  it('does not lift a PROVIDER hold on a stale active membership event after a dsync deprovision', async () => {
    // Un `organization_membership.*` con status `active` puede llegar DESPUÉS
    // (fuera de orden o reintentado) de que dsync deprovisionó al usuario. El
    // status del payload no basta: si TODAS las identidades de directorio
    // almacenadas están inactivas, el evento es stale y no prueba presencia.
    const existingUser = {
      _id: 'user_convex_stale',
      authProvider: 'workos',
      providerUserId: 'user_workos_stale',
      workosUserId: 'user_workos_stale',
      email: 'stale@example.com',
    }
    const inactiveDirectoryUser = {
      _id: 'wdu_convex_stale',
      directoryUserId: 'directory_user_stale',
      userId: 'user_convex_stale',
      workosOrgId: 'org_workos_stale',
      active: false,
      state: 'DELETED',
    }
    const existingProfile = {
      _id: 'profile_convex_stale',
      userId: 'user_convex_stale',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, insert, patch } = createCtx([
      existingUser,
      [],
      [inactiveDirectoryUser],
      existingProfile,
    ])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_stale',
        userId: 'user_workos_stale',
        organizationId: 'org_workos_stale',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_stale',
      expect.objectContaining({ isActive: true })
    )
    // Y la membership tampoco se persiste ACTIVE: una fila activa autoriza
    // superficies downstream (p.ej. el admin portal de WorkOS).
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({ status: 'INACTIVE' })
    )
  })

  it('lifts a PROVIDER hold when a direct membership postdates the dsync deprovision in the same org', async () => {
    // La señal dsync no veta la org para siempre: un alta directa NUEVA
    // (createdAt del objeto membership POSTERIOR al deprovisionedAt almacenado)
    // es el round-trip legítimo del IdP y sí prueba presencia vigente.
    const existingUser = {
      _id: 'user_convex_regrant',
      authProvider: 'workos',
      providerUserId: 'user_workos_regrant',
      workosUserId: 'user_workos_regrant',
      email: 'regrant@example.com',
    }
    const inactiveDirectoryUser = {
      _id: 'wdu_convex_regrant',
      directoryUserId: 'directory_user_regrant',
      userId: 'user_convex_regrant',
      workosOrgId: 'org_workos_regrant',
      active: false,
      state: 'DELETED',
      deprovisionedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-07-01T00:00:00.000Z'),
    }
    const heldProfile = {
      _id: 'profile_convex_regrant',
      userId: 'user_convex_regrant',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, insert, patch } = createCtx([
      existingUser,
      [],
      [inactiveDirectoryUser],
      heldProfile,
    ])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_regrant',
        userId: 'user_workos_regrant',
        organizationId: 'org_workos_regrant',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    })

    expect(patch).toHaveBeenCalledWith(
      'profile_convex_regrant',
      expect.objectContaining({ isActive: true })
    )
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({ status: 'ACTIVE' })
    )
  })

  it('keeps the hold when the membership object predates the stored dsync deprovision', async () => {
    // Un evento retrasado o reintentado conserva los timestamps del objeto
    // original: si preceden al deprovision almacenado, sigue siendo stale.
    const existingUser = {
      _id: 'user_convex_predate',
      authProvider: 'workos',
      providerUserId: 'user_workos_predate',
      workosUserId: 'user_workos_predate',
      email: 'predate@example.com',
    }
    const inactiveDirectoryUser = {
      _id: 'wdu_convex_predate',
      directoryUserId: 'directory_user_predate',
      userId: 'user_convex_predate',
      workosOrgId: 'org_workos_predate',
      active: false,
      state: 'DELETED',
      deprovisionedAt: Date.parse('2026-07-10T00:00:00.000Z'),
      updatedAt: Date.parse('2026-07-10T00:00:00.000Z'),
    }
    const heldProfile = {
      _id: 'profile_convex_predate',
      userId: 'user_convex_predate',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, insert, patch } = createCtx([
      existingUser,
      [],
      [inactiveDirectoryUser],
      heldProfile,
    ])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_predate',
        userId: 'user_workos_predate',
        organizationId: 'org_workos_predate',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_predate',
      expect.objectContaining({ isActive: true })
    )
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({ status: 'INACTIVE' })
    )
  })

  it('ignores a delayed membership event that predates the stored provider watermark', async () => {
    // Watermark monotónico: una entrega retrasada (T1) de un estado ya
    // superado no puede pisar la fila persistida con evidencia T3. Si
    // retrocediera providerUpdatedAt, un deprovision dsync intermedio (T2)
    // entregado después ya no vería la prueba del alta legítima T3 y tumbaría
    // membership y perfil.
    const existingUser = {
      _id: 'user_convex_watermark',
      authProvider: 'workos',
      providerUserId: 'user_workos_watermark',
      workosUserId: 'user_workos_watermark',
      email: 'watermark@example.com',
      role: 'COMPANY',
    }
    const storedMembership = {
      _id: 'om_convex_watermark',
      userId: 'user_convex_watermark',
      profileId: 'profile_convex_watermark',
      authProvider: 'workos',
      providerOrgId: 'org_workos_watermark',
      workosOrgId: 'org_workos_watermark',
      betaRole: 'COMPANY_MEMBER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
      createdAt: 1,
    }
    const { ctx, insert, patch } = createCtx([existingUser, [storedMembership]])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_watermark',
        userId: 'user_workos_watermark',
        organizationId: 'org_workos_watermark',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    })

    expect(result).toMatchObject({
      action: 'workos_membership_stale_ignored',
      processed: true,
    })
    // El descarte ocurre ANTES de cualquier escritura: ni status/watermark de
    // la membership, ni rol del usuario, ni hold del perfil se tocan.
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('rejects a stale membership event before any user or profile write', async () => {
    // La guarda del watermark corre ANTES del patch de rol y de
    // ensureWorkosProfile: un evento retrasado (T1) con otro rol no puede
    // re-rolear al usuario ni tocar el hold del perfil aunque después se
    // descarte su persistencia.
    const existingUser = {
      _id: 'user_convex_prewrite',
      authProvider: 'workos',
      providerUserId: 'user_workos_prewrite',
      workosUserId: 'user_workos_prewrite',
      email: 'prewrite@example.com',
      role: 'COMPANY',
    }
    const storedMembership = {
      _id: 'om_convex_prewrite',
      userId: 'user_convex_prewrite',
      profileId: 'profile_convex_prewrite',
      authProvider: 'workos',
      providerOrgId: 'org_workos_prewrite',
      workosOrgId: 'org_workos_prewrite',
      betaRole: 'COMPANY_MEMBER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
      createdAt: 1,
    }
    const { ctx, insert, patch } = createCtx([existingUser, [storedMembership]])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_prewrite',
        userId: 'user_workos_prewrite',
        organizationId: 'org_workos_prewrite',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_owner' },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    })

    expect(result).toMatchObject({
      action: 'workos_membership_stale_ignored',
      processed: true,
    })
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('does not lift a PROVIDER hold when the directory identity is active but its parent directory is not', async () => {
    // Entrega fuera de orden: un dsync.user.updated retrasado con state activo
    // puede marcar la identidad activa DESPUÉS de un dsync.deactivated del
    // directorio. La identidad solo cuenta como presencia si el directorio
    // padre almacenado sigue activo (verificado, fail-closed).
    const existingUser = {
      _id: 'user_convex_dirdown',
      authProvider: 'workos',
      providerUserId: 'user_workos_dirdown',
      workosUserId: 'user_workos_dirdown',
      email: 'dirdown@example.com',
    }
    const activeDirectoryUser = {
      _id: 'wdu_convex_dirdown',
      directoryUserId: 'directory_user_dirdown',
      userId: 'user_convex_dirdown',
      workosDirectoryId: 'directory_dirdown',
      workosOrgId: 'org_workos_dirdown',
      active: true,
      state: 'ACTIVE',
    }
    const inactiveDirectory = {
      _id: 'wd_convex_dirdown',
      directoryId: 'directory_dirdown',
      workosOrgId: 'org_workos_dirdown',
      active: false,
      state: 'DELETED',
    }
    const existingProfile = {
      _id: 'profile_convex_dirdown',
      userId: 'user_convex_dirdown',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([
      existingUser,
      [],
      [activeDirectoryUser],
      inactiveDirectory,
      existingProfile,
    ])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_dirdown',
        userId: 'user_workos_dirdown',
        organizationId: 'org_workos_dirdown',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_dirdown',
      expect.objectContaining({ isActive: true })
    )
  })

  it('creates an inactive PROVIDER-held profile when the first membership event is not active', async () => {
    // Un membership inactivo como PRIMER evento de un usuario sin perfil local
    // no debe crear un perfil admitido: sin presencia activa en el IdP, el
    // perfil nace desactivado con marca PROVIDER (un re-provisioning verificado
    // puede levantarlo solo).
    const existingUser = {
      _id: 'user_convex_firstinactive',
      authProvider: 'workos',
      providerUserId: 'user_workos_firstinactive',
      workosUserId: 'user_workos_firstinactive',
      email: 'firstinactive@example.com',
      role: 'COMPANY',
    }
    const { ctx, insert } = createCtx([existingUser, [], null])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_firstinactive',
        userId: 'user_workos_firstinactive',
        organizationId: 'org_workos_firstinactive',
        organizationName: 'Capital Example',
        status: 'inactive',
        role: { slug: 'company_member' },
      },
    })

    expect(insert).toHaveBeenCalledWith(
      'profiles',
      expect.objectContaining({ isActive: false, deactivatedBy: 'PROVIDER' })
    )
  })

  it('does not rewrite roles from a stale membership event', async () => {
    // Un evento stale (status activo que contradice el estado dsync almacenado
    // de esa org) tampoco es autoridad de rol: no puede re-rolear a un usuario
    // que sigue vivo a través de otra organización.
    const existingUser = {
      _id: 'user_convex_stalerole',
      authProvider: 'workos',
      providerUserId: 'user_workos_stalerole',
      workosUserId: 'user_workos_stalerole',
      email: 'stalerole@example.com',
      role: 'COMPANY',
    }
    const inactiveDirectoryUser = {
      _id: 'wdu_convex_stalerole',
      directoryUserId: 'directory_user_stalerole',
      userId: 'user_convex_stalerole',
      workosOrgId: 'org_workos_stalerole',
      active: false,
      state: 'DELETED',
    }
    const existingProfile = {
      _id: 'profile_convex_stalerole',
      userId: 'user_convex_stalerole',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([existingUser, [], [inactiveDirectoryUser], existingProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_stalerole',
        userId: 'user_workos_stalerole',
        organizationId: 'org_workos_stalerole',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_owner' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'user_convex_stalerole',
      expect.objectContaining({ role: 'COMPANY' })
    )
    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_stalerole',
      expect.objectContaining({ role: 'COMPANY' })
    )
    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_stalerole',
      expect.objectContaining({ isActive: true })
    )
  })

  it('resolves the identity org via the parent directory when the child mapping is missing', async () => {
    // Un payload dsync aceptado sin organizationId deja la identidad sin
    // workosOrgId propio; su org se resuelve vía el directorio padre. Sin esa
    // resolución, el filtro por org descartaba la identidad deprovisionada y
    // un membership activo retrasado levantaba el hold PROVIDER.
    const existingUser = {
      _id: 'user_convex_noorg',
      authProvider: 'workos',
      providerUserId: 'user_workos_noorg',
      workosUserId: 'user_workos_noorg',
      email: 'noorg@example.com',
    }
    const directoryUserWithoutOrg = {
      _id: 'wdu_convex_noorg',
      directoryUserId: 'directory_user_noorg',
      userId: 'user_convex_noorg',
      workosDirectoryId: 'directory_noorg',
      active: false,
      state: 'DELETED',
    }
    const parentDirectory = {
      _id: 'wd_convex_noorg',
      directoryId: 'directory_noorg',
      workosOrgId: 'org_workos_noorg',
      active: true,
      state: 'ACTIVE',
    }
    const heldProfile = {
      _id: 'profile_convex_noorg',
      userId: 'user_convex_noorg',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, insert, patch } = createCtx([
      existingUser,
      [],
      [directoryUserWithoutOrg],
      parentDirectory,
      heldProfile,
    ])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_noorg',
        userId: 'user_workos_noorg',
        organizationId: 'org_workos_noorg',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_noorg',
      expect.objectContaining({ isActive: true })
    )
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({ status: 'INACTIVE' })
    )
  })

  it('lifts a PROVIDER hold on an active membership in an organization without stale directory signal', async () => {
    // Usuario deprovisionado vía dsync en la org A y luego dado de alta como
    // miembro directo (sin dsync) en la org B: la identidad inactiva de A no
    // debe clasificar como stale el evento legítimo de B — sin identidades de
    // directorio EN B, el status del membership manda y el hold se levanta.
    const existingUser = {
      _id: 'user_convex_crossorg',
      authProvider: 'workos',
      providerUserId: 'user_workos_crossorg',
      workosUserId: 'user_workos_crossorg',
      email: 'crossorg@example.com',
    }
    const inactiveDirectoryUserOrgA = {
      _id: 'wdu_convex_crossorg',
      directoryUserId: 'directory_user_crossorg',
      userId: 'user_convex_crossorg',
      workosDirectoryId: 'directory_org_a',
      workosOrgId: 'org_workos_a',
      active: false,
      state: 'DELETED',
    }
    const heldProfile = {
      _id: 'profile_convex_crossorg',
      userId: 'user_convex_crossorg',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([existingUser, [], [inactiveDirectoryUserOrgA], heldProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_crossorg',
        userId: 'user_workos_crossorg',
        organizationId: 'org_workos_b',
        organizationName: 'Capital Example B',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(patch).toHaveBeenCalledWith(
      'profile_convex_crossorg',
      expect.objectContaining({ isActive: true })
    )
  })

  it('marks user.deleted holds with a terminal reason that membership events cannot lift', async () => {
    // WorkOS no reutiliza ids de usuario y un usuario recreado colisiona por
    // email, así que ningún evento posterior puede referirse legítimamente a un
    // usuario borrado: ese hold PROVIDER solo lo revierte un admin.
    const existingUser = {
      _id: 'user_convex_deleted',
      authProvider: 'workos',
      providerUserId: 'user_workos_deleted',
      workosUserId: 'user_workos_deleted',
      email: 'deleted@example.com',
    }
    const activeProfile = {
      _id: 'profile_convex_deleted',
      userId: 'user_convex_deleted',
      role: 'COMPANY',
      isActive: true,
    }
    const { ctx, patch } = createCtx([existingUser, activeProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'user.deleted',
      data: { id: 'user_workos_deleted' },
    })

    expect(patch).toHaveBeenCalledWith('profile_convex_deleted', {
      isActive: false,
      deactivatedBy: 'PROVIDER',
      deactivationReason: 'workos:user.deleted',
    })

    // Y un membership activo posterior (id ya imposible en WorkOS) no lo levanta.
    const heldProfile = {
      ...activeProfile,
      isActive: false,
      deactivatedBy: 'PROVIDER',
      deactivationReason: 'workos:user.deleted',
    }
    const { ctx: laterCtx, patch: laterPatch } = createCtx([existingUser, [], [], heldProfile])

    await runSyncWorkosEvent(laterCtx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_deleted',
        userId: 'user_workos_deleted',
        organizationId: 'org_workos_deleted',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(laterPatch).not.toHaveBeenCalledWith(
      'profile_convex_deleted',
      expect.objectContaining({ isActive: true })
    )
  })

  it('does not patch investor discovery when WorkOS deletes the profile identity', async () => {
    const existingUser = {
      _id: 'user_convex_deleted_investor',
      authProvider: 'workos',
      providerUserId: 'user_workos_deleted_investor',
      workosUserId: 'user_workos_deleted_investor',
      email: 'deleted-investor@example.com',
    }
    const activeProfile = {
      _id: 'profile_convex_deleted_investor',
      userId: 'user_convex_deleted_investor',
      role: 'COMPANY',
      isActive: true,
    }
    const publicInvestor = {
      _id: 'investor_public_deleted',
      ownerId: 'profile_convex_deleted_investor',
      isPublic: true,
    }
    const privateInvestor = {
      _id: 'investor_private_deleted',
      ownerId: 'profile_convex_deleted_investor',
      isPublic: false,
    }
    const { ctx, patch } = createCtx([
      existingUser,
      activeProfile,
      [publicInvestor, privateInvestor],
    ])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'user.deleted',
      data: { id: 'user_workos_deleted_investor' },
    })

    expect(patch).not.toHaveBeenCalledWith('investor_public_deleted', expect.anything())
    expect(patch).not.toHaveBeenCalledWith('investor_private_deleted', expect.anything())
    expect(result).toMatchObject({
      action: 'workos_user_deactivated',
      details: 'Deactivated local WorkOS user user_workos_deleted_investor',
    })
  })

  it('keeps repeated WorkOS deletion quarantine idempotent for an already private investor', async () => {
    const existingUser = {
      _id: 'user_convex_deleted_private',
      authProvider: 'workos',
      providerUserId: 'user_workos_deleted_private',
      workosUserId: 'user_workos_deleted_private',
      email: 'deleted-private@example.com',
    }
    const heldProfile = {
      _id: 'profile_convex_deleted_private',
      userId: 'user_convex_deleted_private',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
      deactivationReason: 'workos:user.deleted',
    }
    const privateInvestor = {
      _id: 'investor_already_private',
      ownerId: 'profile_convex_deleted_private',
      isPublic: false,
    }
    const { ctx, patch } = createCtx([existingUser, heldProfile, [privateInvestor]])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'user.deleted',
      data: { id: 'user_workos_deleted_private' },
    })

    expect(patch).not.toHaveBeenCalled()
    expect(result).toEqual({
      action: 'workos_user_deactivated',
      resourceId: 'user_workos_deleted_private',
      details: 'Deactivated local WorkOS user user_workos_deleted_private',
      processed: true,
    })
  })

  it('escalates an existing PROVIDER hold to terminal on user.deleted without touching admin holds', async () => {
    // Un perfil ya desactivado por deprovision de dsync (PROVIDER, sin razón
    // terminal) que luego recibe el user.deleted global debe quedar terminal:
    // si no, un membership activo stale en una org sin señal de directorio
    // podría levantar el hold de un usuario borrado.
    const existingUser = {
      _id: 'user_convex_escalate',
      authProvider: 'workos',
      providerUserId: 'user_workos_escalate',
      workosUserId: 'user_workos_escalate',
      email: 'escalate@example.com',
    }
    const providerHeldProfile = {
      _id: 'profile_convex_escalate',
      userId: 'user_convex_escalate',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([existingUser, providerHeldProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'user.deleted',
      data: { id: 'user_workos_escalate' },
    })

    expect(patch).toHaveBeenCalledWith('profile_convex_escalate', {
      deactivationReason: 'workos:user.deleted',
    })

    // Un hold ADMIN (AML) no se toca: el borrado en el IdP no reescribe su
    // origen ni su razón.
    const adminHeldProfile = {
      _id: 'profile_convex_admin_hold',
      userId: 'user_convex_escalate',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'ADMIN',
      deactivationReason: 'AML review',
    }
    const { ctx: adminCtx, patch: adminPatch } = createCtx([existingUser, adminHeldProfile])

    await runSyncWorkosEvent(adminCtx, {
      eventType: 'user.deleted',
      data: { id: 'user_workos_escalate' },
    })

    expect(adminPatch).not.toHaveBeenCalledWith('profile_convex_admin_hold', expect.anything())
  })

  it('still seeds the profile role when the WorkOS user has no local profile yet', async () => {
    const existingUser = {
      _id: 'user_convex_new',
      authProvider: 'workos',
      providerUserId: 'user_workos_new',
      workosUserId: 'user_workos_new',
      email: 'new@example.com',
    }
    const { ctx, insert } = createCtx([existingUser, null])

    await runSyncWorkosEvent(ctx, {
      eventType: 'user.created',
      data: {
        id: 'user_workos_new',
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'User',
        emailVerified: true,
      },
    })

    expect(insert).toHaveBeenCalledWith(
      'profiles',
      expect.objectContaining({ userId: 'user_convex_new', role: 'COMPANY' })
    )
  })

  it('skips WorkOS user sync when the email belongs to a different local account', async () => {
    const existingUser = {
      _id: 'user_local_123',
      authProvider: 'clerk',
      providerUserId: 'user_clerk_123',
      clerkId: 'user_clerk_123',
      email: 'founder@example.com',
      role: 'COMPANY',
    }
    const { ctx, insert, patch } = createCtx([null, null, null, null, existingUser])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'user.created',
      data: {
        id: 'user_workos_123',
        email: 'founder@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: true,
      },
    })

    expect(result).toEqual({
      action: 'workos_user_email_collision',
      resourceId: 'user_workos_123',
      details:
        'Skipped WorkOS user user_workos_123 because its email is already linked to a different local user',
      processed: false,
    })
    expect(insert).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('upserts active organization memberships with mapped beta roles', async () => {
    const existingUser = {
      _id: 'user_convex_123',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'analyst@example.com',
    }
    const existingProfile = {
      _id: 'profile_convex_123',
      userId: 'user_convex_123',
      role: 'COMPANY',
    }
    const { ctx, insert, patch } = createCtx([existingUser, [], [], existingProfile])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_workos_123',
        userId: 'user_workos_123',
        organizationId: 'org_workos_456',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'company_member' },
      },
    })

    expect(result).toEqual({
      action: 'workos_membership_synced',
      resourceId: 'org_workos_456',
      details: 'Synced WorkOS membership om_workos_123',
      processed: true,
    })
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({
        userId: 'user_convex_123',
        profileId: 'profile_convex_123',
        authProvider: 'workos',
        providerOrgId: 'org_workos_456',
        workosOrgId: 'org_workos_456',
        name: 'Capital Example',
        betaRole: 'COMPANY_MEMBER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
      })
    )
    expect(patch).toHaveBeenCalledWith(
      'user_convex_123',
      expect.objectContaining({ role: 'COMPANY' })
    )
  })

  it('deactivates the profile when WorkOS deletes its last active organization membership', async () => {
    const existingUser = {
      _id: 'user_convex_departed',
      authProvider: 'workos',
      providerUserId: 'user_workos_departed',
      workosUserId: 'user_workos_departed',
      email: 'departed@example.com',
    }
    const membership = {
      _id: 'membership_departed',
      userId: 'user_convex_departed',
      profileId: 'profile_convex_departed',
      authProvider: 'workos',
      providerOrgId: 'org_workos_departed',
      workosOrgId: 'org_workos_departed',
      status: 'ACTIVE',
    }
    const activeProfile = {
      _id: 'profile_convex_departed',
      userId: 'user_convex_departed',
      role: 'COMPANY',
      isActive: true,
    }
    // Results model the same-transaction state after the membership patch:
    // no other active membership or directory identity remains.
    const { ctx, patch } = createCtx([existingUser, [membership], [], [], activeProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.deleted',
      data: {
        id: 'om_workos_departed',
        userId: 'user_workos_departed',
        organizationId: 'org_workos_departed',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    })

    expect(patch).toHaveBeenCalledWith(
      'membership_departed',
      expect.objectContaining({
        status: 'INACTIVE',
        providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
      })
    )
    expect(patch).toHaveBeenCalledWith('profile_convex_departed', {
      isActive: false,
      deactivatedBy: 'PROVIDER',
    })
  })

  it('does not revive a deleted membership from an older active update delivered late', async () => {
    const existingUser = {
      _id: 'user_convex_deleted_watermark',
      authProvider: 'workos',
      providerUserId: 'user_workos_deleted_watermark',
      workosUserId: 'user_workos_deleted_watermark',
      email: 'deleted-watermark@example.com',
      role: 'COMPANY',
    }
    const deletedMembership = {
      _id: 'membership_deleted_watermark',
      userId: 'user_convex_deleted_watermark',
      profileId: 'profile_convex_deleted_watermark',
      authProvider: 'workos',
      providerOrgId: 'org_workos_deleted_watermark',
      workosOrgId: 'org_workos_deleted_watermark',
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
      status: 'INACTIVE',
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
    }
    const { ctx, insert, patch } = createCtx([existingUser, [deletedMembership]])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_deleted_watermark',
        userId: 'user_workos_deleted_watermark',
        organizationId: 'org_workos_deleted_watermark',
        status: 'active',
        role: { slug: 'company_owner' },
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    })

    expect(result).toMatchObject({ action: 'workos_membership_stale_ignored', processed: true })
    expect(patch).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('allows a newer provider regrant after a membership delete watermark', async () => {
    const existingUser = {
      _id: 'user_convex_newer_regrant',
      authProvider: 'workos',
      providerUserId: 'user_workos_newer_regrant',
      workosUserId: 'user_workos_newer_regrant',
      email: 'newer-regrant@example.com',
      role: 'COMPANY',
    }
    const deletedMembership = {
      _id: 'membership_newer_regrant',
      userId: 'user_convex_newer_regrant',
      profileId: 'profile_convex_newer_regrant',
      authProvider: 'workos',
      providerOrgId: 'org_workos_newer_regrant',
      workosOrgId: 'org_workos_newer_regrant',
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
      status: 'INACTIVE',
      providerUpdatedAt: Date.parse('2026-07-15T00:00:00.000Z'),
    }
    const heldProfile = {
      _id: 'profile_convex_newer_regrant',
      userId: 'user_convex_newer_regrant',
      role: 'COMPANY',
      isActive: false,
      deactivatedBy: 'PROVIDER',
    }
    const { ctx, patch } = createCtx([existingUser, [deletedMembership], [], heldProfile])

    await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.updated',
      data: {
        id: 'om_workos_newer_regrant',
        userId: 'user_workos_newer_regrant',
        organizationId: 'org_workos_newer_regrant',
        status: 'active',
        role: { slug: 'company_owner' },
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    })

    expect(patch).toHaveBeenCalledWith(
      'profile_convex_newer_regrant',
      expect.objectContaining({ isActive: true })
    )
    expect(patch).toHaveBeenCalledWith(
      'membership_newer_regrant',
      expect.objectContaining({
        status: 'ACTIVE',
        providerUpdatedAt: Date.parse('2026-07-20T00:00:00.000Z'),
      })
    )
  })

  it('skips WorkOS organization admin role slugs instead of granting platform admin', async () => {
    const existingUser = {
      _id: 'user_convex_123',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'founder@example.com',
      role: 'COMPANY',
    }
    const { ctx, insert, patch } = createCtx([existingUser])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_admin_123',
        userId: 'user_workos_123',
        organizationId: 'org_workos_456',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'admin' },
      },
    })

    expect(result).toEqual({
      action: 'workos_event_skipped',
      resourceId: 'om_admin_123',
      details: 'WorkOS membership om_admin_123 has no mapped Sherlock beta role',
      processed: false,
    })
    expect(insert).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalledWith(
      'user_convex_123',
      expect.objectContaining({ role: 'ADMIN' })
    )
  })

  it('keeps WorkOS counsel reviewer memberships out of the platform admin profile role', async () => {
    const existingUser = {
      _id: 'user_convex_123',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'counsel@example.com',
      role: 'COMPANY',
    }
    const existingProfile = {
      _id: 'profile_convex_123',
      userId: 'user_convex_123',
      role: 'COMPANY',
    }
    const { ctx, insert, patch } = createCtx([existingUser, [], [], existingProfile])

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization_membership.created',
      data: {
        id: 'om_counsel_123',
        userId: 'user_workos_123',
        organizationId: 'org_workos_456',
        organizationName: 'Capital Example',
        status: 'active',
        role: { slug: 'counsel_reviewer' },
      },
    })

    expect(result).toMatchObject({
      action: 'workos_membership_synced',
      resourceId: 'org_workos_456',
      processed: true,
    })
    expect(insert).toHaveBeenCalledWith(
      'organizationMemberships',
      expect.objectContaining({
        betaRole: 'COUNSEL_REVIEWER',
        profileRole: 'COMPANY',
      })
    )
    expect(patch).not.toHaveBeenCalledWith(
      'user_convex_123',
      expect.objectContaining({ role: 'ADMIN' })
    )
    expect(patch).not.toHaveBeenCalledWith(
      'profile_convex_123',
      expect.objectContaining({ role: 'ADMIN' })
    )
  })

  it('skips WorkOS events without local sync behavior', async () => {
    const { ctx, insert, patch } = createCtx()

    const result = await runSyncWorkosEvent(ctx, {
      eventType: 'organization.created',
      data: { id: 'org_workos_456', name: 'Capital Example' },
    })

    expect(result).toEqual({
      action: 'workos_event_skipped',
      resourceId: 'org_workos_456',
      details: 'No local sync handler for WorkOS event organization.created',
      processed: false,
    })
    expect(insert).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })
})
