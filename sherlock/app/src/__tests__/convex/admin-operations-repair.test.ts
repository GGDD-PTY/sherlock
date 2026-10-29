import { describe, expect, it } from 'vitest'

import { COMPANY_NAME_MAX_LENGTH } from '../../../convex/_helpers/companyName'
import { repairUserEmail, setCompanyName, setUserRole } from '../../../convex/admin'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: 1, ...overrides }
}

function repairTables(): Tables {
  return {
    companies: [row({ _id: 'company_owner', ownerId: 'profile_owner', name: 'sampleowner' })],
    users: [
      row({
        _id: 'user_target',
        authProvider: 'workos',
        email: 'viejo@example.com',
        role: 'COMPANY',
      }),
      row({
        _id: 'user_stale',
        authProvider: 'workos',
        email: 'fixture-67bb0a48@example.com',
        role: 'COMPANY',
      }),
    ],
  }
}

function company(tables: Tables) {
  return tables.companies.find((candidate) => candidate._id === 'company_owner')
}

function user(tables: Tables, id: string) {
  return tables.users.find((candidate) => candidate._id === id)
}

describe('setCompanyName', () => {
  it('normalizes the new name and reports the previous one', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(setCompanyName, ctx, {
      companyId: 'company_owner',
      name: '  Sample   Hydro  ',
    })

    expect(result).toEqual({
      companyId: 'company_owner',
      previousName: 'sampleowner',
      name: 'Sample Hydro',
    })
    expect(company(tables)).toMatchObject({ name: 'Sample Hydro' })
  })

  it('rejects an unusable name and leaves the row untouched', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(setCompanyName, ctx, { companyId: 'company_owner', name: '   ' })
    ).rejects.toThrow()
    await expect(
      runHandler(setCompanyName, ctx, {
        companyId: 'company_owner',
        name: 'a'.repeat(COMPANY_NAME_MAX_LENGTH + 1),
      })
    ).rejects.toThrow()
    expect(company(tables)).toMatchObject({ name: 'sampleowner' })
  })

  it('rejects a company that does not exist', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(setCompanyName, ctx, { companyId: 'company_missing', name: 'Sample Hydro' })
    ).rejects.toThrow()
  })
})

describe('repairUserEmail', () => {
  it('sets the email when nothing collides', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(repairUserEmail, ctx, {
      userId: 'user_target',
      email: '  nuevo@example.com  ',
    })

    expect(result).toEqual({
      userId: 'user_target',
      email: 'nuevo@example.com',
      retired: null,
    })
    expect(user(tables, 'user_target')).toMatchObject({ email: 'nuevo@example.com' })
    expect(user(tables, 'user_stale')).toMatchObject({ email: 'fixture-67bb0a48@example.com' })
  })

  it('refuses to overwrite a collision that was not designated for retirement', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(repairUserEmail, ctx, {
        userId: 'user_target',
        email: 'fixture-67bb0a48@example.com',
      })
    ).rejects.toThrow()
    expect(user(tables, 'user_target')).toMatchObject({ email: 'viejo@example.com' })
    expect(user(tables, 'user_stale')).toMatchObject({ email: 'fixture-67bb0a48@example.com' })
  })

  it('retires the designated colliding row before claiming its email', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(repairUserEmail, ctx, {
      userId: 'user_target',
      email: 'fixture-67bb0a48@example.com',
      retireCollidingUserId: 'user_stale',
    })

    expect(result).toEqual({
      userId: 'user_target',
      email: 'fixture-67bb0a48@example.com',
      retired: 'user_stale',
    })
    expect(user(tables, 'user_stale')).toMatchObject({
      email: 'legacy+user_stale@retired.local',
    })
    expect(user(tables, 'user_target')).toMatchObject({ email: 'fixture-67bb0a48@example.com' })
  })

  it('is safe to re-run against the email the target already holds', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(repairUserEmail, ctx, {
      userId: 'user_target',
      email: 'viejo@example.com',
    })

    expect(result).toEqual({
      userId: 'user_target',
      email: 'viejo@example.com',
      retired: null,
    })
    expect(user(tables, 'user_target')).toMatchObject({ email: 'viejo@example.com' })
  })

  it('rejects a malformed email and a missing user', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(repairUserEmail, ctx, { userId: 'user_target', email: 'sin-arroba' })
    ).rejects.toThrow()
    await expect(
      runHandler(repairUserEmail, ctx, { userId: 'user_target', email: 'con fixture-69d5a246@example.com' })
    ).rejects.toThrow()
    await expect(
      runHandler(repairUserEmail, ctx, { userId: 'user_missing', email: 'nuevo@example.com' })
    ).rejects.toThrow()
    expect(user(tables, 'user_target')).toMatchObject({ email: 'viejo@example.com' })
  })
})

type ErrorData = { code: string; details?: { field?: string } }

async function rejectionData(promise: Promise<unknown>): Promise<ErrorData> {
  try {
    await promise
  } catch (error) {
    return (error as { data: ErrorData }).data
  }
  throw new Error('el handler resolvió cuando se esperaba un rechazo')
}

describe('operator repair contract', () => {
  it('reports a missing company as not-found, not as a bad name', async () => {
    const ctx = createConvexCtx(repairTables())

    const data = await rejectionData(
      runHandler(setCompanyName, ctx, { companyId: 'company_missing', name: '   ' })
    )

    expect(data.code).toBe('NOT_FOUND')
  })

  it('tags the rejected name with its field', async () => {
    const ctx = createConvexCtx(repairTables())

    const data = await rejectionData(
      runHandler(setCompanyName, ctx, { companyId: 'company_owner', name: '   ' })
    )

    expect(data.code).toBe('VALIDATION_FAILED')
    expect(data.details?.field).toBe('name')
  })

  it('accepts a name of exactly the maximum length', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)
    const atLimit = 'a'.repeat(COMPANY_NAME_MAX_LENGTH)

    await runHandler(setCompanyName, ctx, { companyId: 'company_owner', name: atLimit })

    expect(company(tables)).toMatchObject({ name: atLimit })
  })

  it('tags the rejected email with its field', async () => {
    const ctx = createConvexCtx(repairTables())

    const data = await rejectionData(
      runHandler(repairUserEmail, ctx, { userId: 'user_target', email: 'sin-arroba' })
    )

    expect(data.code).toBe('VALIDATION_FAILED')
    expect(data.details?.field).toBe('email')
  })

  it('stores the email verbatim, because by_email is an exact-string index', async () => {
    const tables = repairTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler<
      { userId: string; email: string },
      { email: string; retired: string | null }
    >(repairUserEmail, ctx, { userId: 'user_target', email: '  fixture-dcc6dd58@example.com  ' })

    expect(result.email).toBe('fixture-dcc6dd58@example.com')
    expect(user(tables, 'user_target')).toMatchObject({ email: 'fixture-dcc6dd58@example.com' })
    expect(user(tables, 'user_stale')).toMatchObject({ email: 'fixture-67bb0a48@example.com' })
  })

  it('reports an undesignated collision as a conflict', async () => {
    const ctx = createConvexCtx(repairTables())

    const data = await rejectionData(
      runHandler(repairUserEmail, ctx, {
        userId: 'user_target',
        email: 'fixture-67bb0a48@example.com',
        retireCollidingUserId: 'user_absent',
      })
    )

    expect(data.code).toBe('CONFLICT_ALREADY_EXISTS')
  })

  it('retires the stale row before the target claims the email', async () => {
    const ctx = createConvexCtx(repairTables())

    await runHandler(repairUserEmail, ctx, {
      userId: 'user_target',
      email: 'fixture-67bb0a48@example.com',
      retireCollidingUserId: 'user_stale',
    })

    expect(ctx.db.patch.mock.calls.map((call) => call[0])).toEqual(['user_stale', 'user_target'])
  })
})

// Prod 2026-09-01: sampleowner@ y samplereviewer@ existían con perfil
// INVESTOR y ningún perfil era ADMIN, así que `makeAdmin` (exige admin
// llamante) no podía arrancar. Este es el camino del operador.
describe('setUserRole', () => {
  function roleTables(): Tables {
    return {
      users: [
        row({
          _id: 'user_fg',
          authProvider: 'workos',
          email: 'fixture-74d1e48e@example.com',
          role: 'COMPANY',
        }),
      ],
      profiles: [row({ _id: 'profile_fg', userId: 'user_fg', role: 'COMPANY' })],
    }
  }

  it('sets the role on the profile and the user and reports the previous one', async () => {
    const tables = roleTables()
    const ctx = createConvexCtx(tables)
    const result = await runHandler(setUserRole, ctx, { userId: 'user_fg', role: 'ADMIN' })
    expect(result).toEqual({
      userId: 'user_fg',
      email: 'fixture-74d1e48e@example.com',
      previousRole: 'COMPANY',
      role: 'ADMIN',
    })
    expect(tables.profiles[0]?.role).toBe('ADMIN')
    expect(tables.users[0]?.role).toBe('ADMIN')
  })

  // `isActive` es opcional y su default es "activo", pero el índice
  // `by_role_isActive` NO lo sabe: un perfil sin el campo no entra en el rango
  // de los ADMIN activos y el aviso al equipo lo salta en silencio. El camino
  // que fija el rol es el mismo que tiene que normalizar la bandera.
  it('normaliza isActive al promover, para que el aviso al equipo lo encuentre', async () => {
    const tables = roleTables()
    const ctx = createConvexCtx(tables)

    await runHandler(setUserRole, ctx, { userId: 'user_fg', role: 'ADMIN' })

    expect(tables.profiles[0]?.isActive).toBe(true)
  })

  // Normalizar `undefined` es una cosa; levantar un `false` explícito es otra.
  // `deactivateOwnAccount` y el `user.deleted` de WorkOS son pegajosas a
  // propósito: ni un webhook del IdP las revierte. Un cambio de rol tampoco.
  it('no levanta una desactivación pegajosa: isActive false se queda en false', async () => {
    const tables = roleTables()
    tables.profiles[0].isActive = false
    tables.profiles[0].deactivatedBy = 'ADMIN'
    const ctx = createConvexCtx(tables)

    await runHandler(setUserRole, ctx, { userId: 'user_fg', role: 'ADMIN' })

    expect(tables.profiles[0]?.role).toBe('ADMIN')
    expect(tables.profiles[0]?.isActive).toBe(false)
    expect(tables.profiles[0]?.deactivatedBy).toBe('ADMIN')
  })

  it('refuses a user without a profile', async () => {
    const tables = roleTables()
    tables.profiles = []
    const ctx = createConvexCtx(tables)
    await expect(
      runHandler(setUserRole, ctx, { userId: 'user_fg', role: 'ADMIN' })
    ).rejects.toThrow()
  })
})
