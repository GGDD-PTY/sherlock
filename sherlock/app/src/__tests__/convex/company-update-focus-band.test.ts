import { describe, expect, it, vi } from 'vitest'

import { updateCompany } from '../../../convex/companies'

// ============================================================================
// MARCA DURABLE DE REVISIÓN — MONTO FUERA DE LA BANDA DE ENFOQUE
// ============================================================================
// Decisión firmada 2026-07-31: la banda USD 250K-5MM avisa, no bloquea. La
// marca de revisión del equipo tiene que persistirse en Convex (activityLogs),
// no en un log.info del servidor Next que producción descarta (nivel mínimo
// `warn` en src/lib/logger.ts).
// ============================================================================

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>
type Filter = { field: string; value: unknown }

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []

  const builder = {
    withIndex: vi.fn(
      (
        _index: string,
        callback?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        filters = []
        callback?.({
          eq: (field: string, value: unknown) => {
            filters.push({ field, value })
            return {
              eq: (nextField: string, nextValue: unknown) => {
                filters.push({ field: nextField, value: nextValue })
                return {}
              },
            }
          },
        })
        return builder
      }
    ),
    first: vi.fn(
      async () => rows.find((row) => filters.every((f) => row[f.field] === f.value)) ?? null
    ),
    unique: vi.fn(
      async () => rows.find((row) => filters.every((f) => row[f.field] === f.value)) ?? null
    ),
    take: vi.fn(async (limit: number) =>
      rows.filter((row) => filters.every((f) => row[f.field] === f.value)).slice(0, limit)
    ),
  }

  return builder
}

function createCtx(seed: Tables) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )

  const findRow = (id: string) => {
    for (const rows of Object.values(tables)) {
      const row = rows.find((candidate) => candidate._id === id)
      if (row) return row
    }
    return null
  }

  return {
    auth: {
      getUserIdentity: vi.fn(async () => ({
        issuer: 'https://api.workos.com/',
        subject: 'user_workos_owner',
        email: 'owner@example.com',
      })),
    },
    db: {
      query: vi.fn((table: string) => createQueryBuilder(tables[table] ?? [])),
      get: vi.fn(async (id: string) => findRow(id)),
      // Patch realista: muta la fila para que la relectura post-patch vea los
      // valores guardados, igual que en Convex de verdad.
      patch: vi.fn(async (id: string, updates: Record<string, unknown>) => {
        const row = findRow(id)
        if (row) Object.assign(row, updates)
      }),
      insert: vi.fn(),
    },
    scheduler: { runAfter: vi.fn() },
  }
}

function seedTables(): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'user_workos_owner',
        workosUserId: 'user_workos_owner',
        email: 'owner@example.com',
      },
    ],
    profiles: [{ _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' }],
    companies: [
      {
        _id: 'company_1',
        ownerId: 'profile_owner',
        name: 'Empresa Uno',
        currency: 'USD',
      },
    ],
    organizationMemberships: [
      {
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company_1',
        workosOrgId: 'org_company_1',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
      },
    ],
    companyOrganizationBindings: [
      {
        _id: 'binding_company_1',
        companyId: 'company_1',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company_1',
      },
    ],
  }
}

const runUpdateCompany = (ctx: unknown, args: Record<string, unknown>) =>
  (
    updateCompany as unknown as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
  )._handler(ctx, args)

function insertsForTable(ctx: ReturnType<typeof createCtx>, table: string) {
  return ctx.db.insert.mock.calls
    .filter((call) => call[0] === table)
    .map((call) => call[1] as Record<string, unknown>)
}

describe('updateCompany y la banda de enfoque (marca durable de revisión)', () => {
  it('conserva los términos guardados al recibir solo cambios de identidad', async () => {
    const seed = seedTables()
    const financial = {
      seekingType: 'BRIDGE',
      seekingAmount: -1,
      currency: 'USD',
      debtTermYears: 45,
      debtIndicativeRate: 150,
      useOfFunds: 'Plan histórico conservado',
    }
    Object.assign(seed.companies[0], financial)
    const ctx = createCtx(seed)

    await runUpdateCompany(ctx, { companyId: 'company_1', name: 'Agroindustria Demo' })

    expect(await ctx.db.get('company_1')).toMatchObject({
      name: 'Agroindustria Demo',
      ...financial,
    })
  })

  it('persiste la marca cuando el monto guardado excede la banda', async () => {
    const ctx = createCtx(seedTables())

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 12_000_000,
      currency: 'USD',
    })

    const bandLogs = insertsForTable(ctx, 'activityLogs').filter(
      (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
    )

    expect(bandLogs).toHaveLength(1)
    expect(bandLogs[0]).toMatchObject({
      userId: 'profile_owner',
      entityType: 'COMPANY',
      entityId: 'company_1',
      metadata: expect.objectContaining({
        details: expect.objectContaining({
          seekingAmount: 12_000_000,
          currency: 'USD',
          focusBandMin: 250_000,
          focusBandMax: 5_000_000,
        }),
      }),
    })
  })

  it('persiste la marca cuando el monto guardado queda por debajo del mínimo', async () => {
    const ctx = createCtx(seedTables())

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 80_000,
      currency: 'USD',
    })

    const bandLogs = insertsForTable(ctx, 'activityLogs').filter(
      (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
    )

    expect(bandLogs).toHaveLength(1)
    expect(bandLogs[0]).toMatchObject({
      metadata: expect.objectContaining({
        details: expect.objectContaining({ seekingAmount: 80_000 }),
      }),
    })
  })

  it('no deja marca cuando el monto está dentro de la banda', async () => {
    const ctx = createCtx(seedTables())

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 1_500_000,
      currency: 'USD',
    })

    expect(
      insertsForTable(ctx, 'activityLogs').some(
        (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
      )
    ).toBe(false)
  })

  it('no deja marca en monedas sin banda (no hay FX en el producto)', async () => {
    const ctx = createCtx(seedTables())

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 500_000_000,
      currency: 'COP',
    })

    expect(
      insertsForTable(ctx, 'activityLogs').some(
        (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
      )
    ).toBe(false)
  })

  it('no deja marca cuando la actualización no toca el fundraising', async () => {
    const seed = seedTables()
    seed.companies[0].seekingAmount = 12_000_000
    const ctx = createCtx(seed)

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      tagline: 'Nueva descripción corta',
    })

    expect(
      insertsForTable(ctx, 'activityLogs').some(
        (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
      )
    ).toBe(false)
  })

  it('no duplica la marca cuando el form reenvía los mismos valores fuera de banda', async () => {
    // El formulario de la sala (CompanyProfileForm) reenvía seekingAmount y
    // currency existentes en guardados que no los tocan: sin cambio real y con
    // marca ya escrita, no hay evento nuevo.
    const seed = seedTables()
    seed.companies[0].seekingAmount = 12_000_000
    seed.activityLogs = [
      {
        _id: 'log_existing_marker',
        action: 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND',
        entityId: 'company_1',
      },
    ]
    const ctx = createCtx(seed)

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 12_000_000,
      currency: 'USD',
      tagline: 'Nueva descripción corta',
    })

    expect(
      insertsForTable(ctx, 'activityLogs').some(
        (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
      )
    ).toBe(false)
  })

  it('repara la marca faltante cuando el form reenvía valores fuera de banda previos a la política', async () => {
    // Empresas que ya estaban fuera de banda antes del despliegue no tienen
    // marca; un reenvío sin cambio real la escribe una única vez.
    const seed = seedTables()
    seed.companies[0].seekingAmount = 12_000_000
    const ctx = createCtx(seed)

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 12_000_000,
      currency: 'USD',
      tagline: 'Nueva descripción corta',
    })

    const bandLogs = insertsForTable(ctx, 'activityLogs').filter(
      (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
    )

    expect(bandLogs).toHaveLength(1)
    expect(bandLogs[0]).toMatchObject({
      entityId: 'company_1',
      metadata: expect.objectContaining({
        details: expect.objectContaining({ seekingAmount: 12_000_000, currency: 'USD' }),
      }),
    })
  })

  it('sí deja marca cuando el monto cambia a otro valor fuera de banda', async () => {
    const seed = seedTables()
    seed.companies[0].seekingAmount = 12_000_000
    const ctx = createCtx(seed)

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      seekingAmount: 20_000_000,
      currency: 'USD',
    })

    const bandLogs = insertsForTable(ctx, 'activityLogs').filter(
      (entry) => entry.action === 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND'
    )

    expect(bandLogs).toHaveLength(1)
    expect(bandLogs[0]).toMatchObject({
      metadata: expect.objectContaining({
        details: expect.objectContaining({ seekingAmount: 20_000_000 }),
      }),
    })
  })
})
