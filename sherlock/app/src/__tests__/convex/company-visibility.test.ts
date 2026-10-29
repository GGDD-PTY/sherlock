// ============================================================================
// COMPANY VISIBILITY (isPublic) TEST SUITE
// ============================================================================
// convex/companies.ts — setCompanyVisibility (admin-only, auditada) y el
// contrato de updateCompany: nadie persiste isPublic por ahí, ni el dueño ni
// un admin. El validator no declara el campo y el handler lo descarta.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import { createCompany, setCompanyVisibility, updateCompany } from '../../../convex/companies'
import { convexArgsValidator } from '../utils/convex-test-utils'

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

function createCtx(seed: Tables, identitySubject: string) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )

  return {
    auth: {
      getUserIdentity: vi.fn(async () => ({
        issuer: 'https://api.workos.com/',
        subject: identitySubject,
        email: 'caller@example.com',
      })),
    },
    db: {
      query: vi.fn((table: string) => createQueryBuilder(tables[table] ?? [])),
      get: vi.fn(async (id: string) => {
        for (const rows of Object.values(tables)) {
          const row = rows.find((candidate) => candidate._id === id)
          if (row) return row
        }
        return null
      }),
      patch: vi.fn(),
      insert: vi.fn(),
    },
  }
}

const baseSeed: Tables = {
  users: [
    {
      _id: 'user_admin',
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'admin@example.com',
    },
    {
      _id: 'user_owner',
      authProvider: 'workos',
      providerUserId: 'workos_owner',
      workosUserId: 'workos_owner',
      email: 'owner@example.com',
    },
  ],
  profiles: [
    { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN' },
    { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' },
  ],
  companies: [{ _id: 'company_1', ownerId: 'profile_owner', name: 'Empresa Uno', isPublic: false }],
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

const runSetVisibility = (ctx: unknown, args: Record<string, unknown>) =>
  (
    setCompanyVisibility as unknown as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
  )._handler(ctx, args)

const runCreateCompany = (ctx: unknown, args: Record<string, unknown>) =>
  (
    createCompany as unknown as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
  )._handler(ctx, args)

const runUpdateCompany = (ctx: unknown, args: Record<string, unknown>) =>
  (
    updateCompany as unknown as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
  )._handler(ctx, args)

describe('setCompanyVisibility', () => {
  it('lets an admin publish a company and writes the audit trail', async () => {
    const ctx = createCtx(baseSeed, 'workos_admin')

    await runSetVisibility(ctx, { companyId: 'company_1', isPublic: true })

    expect(ctx.db.patch).toHaveBeenCalledWith('company_1', { isPublic: true })

    const auditInsert = ctx.db.insert.mock.calls.find(([table]) => table === 'adminAuditLogs')
    expect(auditInsert).toBeDefined()
    expect(auditInsert?.[1]).toMatchObject({
      action: 'COMPANY_VISIBILITY_CHANGE',
      targetType: 'COMPANY',
      targetId: 'company_1',
      previousValue: { isPublic: false },
      newValue: { isPublic: true },
    })
  })

  it('is idempotent when visibility is already the requested value', async () => {
    const ctx = createCtx(baseSeed, 'workos_admin')

    await runSetVisibility(ctx, { companyId: 'company_1', isPublic: false })

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('denies the company owner (non-admin)', async () => {
    const ctx = createCtx(baseSeed, 'workos_owner')

    await expect(
      runSetVisibility(ctx, { companyId: 'company_1', isPublic: true })
    ).rejects.toThrow()
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })
})

describe('updateCompany isPublic contract', () => {
  // El validator no declara `isPublic`, así que el cliente generado no lo
  // manda. Pero el handler hace spread de lo que le llega: estos tests entran
  // por `_handler`, como entraría una mutation vecina o un seed.
  it('drops isPublic silently for the non-admin owner', async () => {
    const ctx = createCtx(baseSeed, 'workos_owner')
    const validator = convexArgsValidator(updateCompany)
    const fields = validator.value as Record<string, unknown>

    expect(fields).not.toHaveProperty('isPublic')

    await runUpdateCompany(ctx, {
      companyId: 'company_1',
      name: 'Empresa Uno',
      isPublic: true,
    })

    const companyPatch = ctx.db.patch.mock.calls.find(([id]) => id === 'company_1')
    expect(companyPatch).toBeDefined()
    const patchArgs = companyPatch![1] as Record<string, unknown>
    expect(patchArgs.name).toBe('Empresa Uno')
    // Ni presente en `true` ni presente en `undefined`: un `undefined` en el
    // patch BORRA la columna, y eso también sería cambiar la visibilidad.
    expect(Object.hasOwn(patchArgs, 'isPublic')).toBe(false)
  })

  it('drops isPublic for an admin too: setCompanyVisibility is the only path', async () => {
    const updateCtx = createCtx(baseSeed, 'workos_admin')

    await runUpdateCompany(updateCtx, {
      companyId: 'company_1',
      name: 'Empresa Uno',
      isPublic: true,
    })

    const companyPatch = updateCtx.db.patch.mock.calls.find(([id]) => id === 'company_1')
    expect(companyPatch).toBeDefined()
    expect(Object.hasOwn(companyPatch![1] as Record<string, unknown>, 'isPublic')).toBe(false)
    // Publicar sin auditoría es la mitad del daño: `updateCompany` tampoco
    // escribe la bitácora de admin, porque no publica.
    expect(updateCtx.db.insert).not.toHaveBeenCalledWith('adminAuditLogs', expect.anything())

    const visibilityCtx = createCtx(baseSeed, 'workos_admin')
    await runSetVisibility(visibilityCtx, { companyId: 'company_1', isPublic: true })

    expect(visibilityCtx.db.patch).toHaveBeenCalledWith('company_1', { isPublic: true })
    expect(visibilityCtx.db.insert).toHaveBeenCalledWith(
      'adminAuditLogs',
      expect.objectContaining({
        action: 'COMPANY_VISIBILITY_CHANGE',
        targetId: 'company_1',
      })
    )
  })
})

// `updateCompany` DESCARTA `isPublic` venga de quien venga; el alta es la otra
// escritura y tiene su propia decisión (`profile.role === 'ADMIN' ? … : false`).
// Sin este contrato, una empresa recién creada podría nacer pública.
describe('createCompany isPublic contract', () => {
  const seedWithoutCompany: Tables = { ...baseSeed, companies: [] }

  it('forces isPublic false for a non-admin caller that asks for true', async () => {
    const ctx = createCtx(seedWithoutCompany, 'workos_owner')

    await runCreateCompany(ctx, {
      ownerId: 'profile_owner',
      name: 'Empresa Dos',
      country: 'PA',
      isPublic: true,
    })

    const companyInsert = ctx.db.insert.mock.calls.find(([table]) => table === 'companies')
    expect(companyInsert?.[1]).toMatchObject({ isPublic: false, isFeatured: false })
  })

  it('lets an admin create a public company', async () => {
    const ctx = createCtx(seedWithoutCompany, 'workos_admin')

    await runCreateCompany(ctx, {
      ownerId: 'profile_owner',
      name: 'Empresa Tres',
      country: 'PA',
      isPublic: true,
    })

    const companyInsert = ctx.db.insert.mock.calls.find(([table]) => table === 'companies')
    expect(companyInsert?.[1]).toMatchObject({ isPublic: true })
  })
})
