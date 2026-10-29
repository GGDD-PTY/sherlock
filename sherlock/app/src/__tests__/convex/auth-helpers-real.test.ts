// ============================================================================
// CONVEX AUTH HELPERS — REAL IMPLEMENTATION SUITE
// ============================================================================
// Este archivo ejecuta las implementaciones REALES de convex/_helpers/auth.*
// (roles, ownership, guards, entities). Es la única suite de estos helpers: el
// archivo hermano auth-helpers.test.ts se borró porque sólo ejercitaba el ctx
// mockeado y re-implementaba la lógica, así que no detectaba una regresión —
// invertir el `if` de requireAdmin lo dejaba verde.
//
// Cobertura buscada:
//   1. requireAdmin
//   2. requireOwnership / hasOwnership
//   3. requireAuthAdmin (propaga el throw real)
//   4. getAuthenticatedCompany / requireAuthenticatedCompany
//
// Varios tests congelan a propósito el bypass ADMIN: si alguien lo elimina, el
// test rompe y obliga a tomar la decisión de forma explícita.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { Doc, Id } from '../../../convex/_generated/dataModel'
import { ErrorCode } from '../../../convex/_helpers/errors'
import { requireAdmin } from '../../../convex/_helpers/auth.roles'
import {
  hasOwnership,
  requireOwnership,
} from '../../../convex/_helpers/auth.ownership'
import { requireAuthAdmin } from '../../../convex/_helpers/auth.guards'
import {
  getAuthenticatedCompany,
  requireAuthenticatedCompany,
} from '../../../convex/_helpers/auth.entities'

// requireAuth (auth.identity) tiene su propia suite (auth-provider-identity /
// auth-dev-bypass). Aquí se mockea sólo para inyectar el AuthResult y verificar
// que guards y entities aplican los helpers reales de roles/ownership encima.
const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))

// Desde la adopción de Effect en Convex ([F] 2026-09-08) guards y entities
// consumen el programa, no la promesa. El doble usa el `convexPromise` real
// para que el reparto de canales —AppError al canal de error, cualquier otra
// excepción a defecto— sea el de producción y no una imitación del test.
vi.mock('../../../convex/_helpers/auth.identity', async () => {
  const { convexPromise } = await import('../../../convex/_helpers/effect')

  return {
    requireAuth: requireAuthMock,
    requireAuthEffect: (ctx: unknown) => convexPromise(() => requireAuthMock(ctx)),
  }
})

type ProfileRole = Doc<'profiles'>['role']

const profileId = (value: string) => value as Id<'profiles'>

function makeProfile(id: string, role: ProfileRole): Doc<'profiles'> {
  return {
    _id: profileId(id),
    _creationTime: 1,
    userId: `user_${id}` as Id<'users'>,
    role,
    kycStatus: 'VERIFIED',
    isActive: true,
  } as unknown as Doc<'profiles'>
}

const adminProfile = makeProfile('profile_admin', 'ADMIN')
const companyProfile = makeProfile('profile_company', 'COMPANY')
const otherCompanyProfile = makeProfile('profile_other_company', 'COMPANY')
const otherOwnerId = profileId('profile_other_owner')

function expectAppError(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }

  expect(thrown, 'expected the helper to throw').toBeDefined()
  expect((thrown as { data?: { code?: string } }).data?.code).toBe(code)
}

async function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await fn()
  } catch (error) {
    thrown = error
  }

  expect(thrown, 'expected the helper to throw').toBeDefined()
  expect((thrown as { data?: { code?: string } }).data?.code).toBe(code)
}

// ============================================================================
// 1. ROLES
// ============================================================================

describe('auth.roles (real implementation)', () => {
  describe('requireAdmin', () => {
    it('throws AUTHZ_ADMIN_REQUIRED for a COMPANY profile', () => {
      expectAppError(() => requireAdmin(companyProfile), ErrorCode.AUTHZ_ADMIN_REQUIRED)
    })

    it('throws AUTHZ_ADMIN_REQUIRED for a COMPANY profile', () => {
      expectAppError(() => requireAdmin(otherCompanyProfile), ErrorCode.AUTHZ_ADMIN_REQUIRED)
    })

    it('does not throw for an ADMIN profile', () => {
      expect(() => requireAdmin(adminProfile)).not.toThrow()
    })
  })
})

// ============================================================================
// 2. OWNERSHIP
// ============================================================================

describe('auth.ownership (real implementation)', () => {
  describe('requireOwnership', () => {
    it('throws AUTHZ_UNAUTHORIZED when a non-admin targets a resource it does not own', () => {
      expectAppError(
        () => requireOwnership(otherCompanyProfile, otherOwnerId),
        ErrorCode.AUTHZ_UNAUTHORIZED
      )
    })

    it('does not throw for the owner', () => {
      expect(() => requireOwnership(otherCompanyProfile, otherCompanyProfile._id)).not.toThrow()
    })

    it('does not throw for ADMIN over a third-party resource (deliberate bypass)', () => {
      expect(() => requireOwnership(adminProfile, otherOwnerId)).not.toThrow()
    })

    it('propagates the custom message', () => {
      expect(() => requireOwnership(otherCompanyProfile, otherOwnerId, 'no es tuyo')).toThrow(
        /no es tuyo/
      )
    })
  })

  describe('hasOwnership', () => {
    it('returns true for the owner', () => {
      expect(hasOwnership(companyProfile, companyProfile._id)).toBe(true)
    })

    it('returns true for ADMIN over a third-party resource', () => {
      expect(hasOwnership(adminProfile, otherOwnerId)).toBe(true)
    })

    it('returns false for a non-admin third party', () => {
      expect(hasOwnership(companyProfile, otherOwnerId)).toBe(false)
    })
  })

})

// ============================================================================
// 3. GUARDS (requireAuth + role/ownership real)
// ============================================================================

describe('auth.guards (real implementation)', () => {
  const ctx = {} as never

  beforeEach(() => {
    requireAuthMock.mockReset()
  })

  it('requireAuthAdmin propagates the real requireAdmin throw for non-admins', async () => {
    requireAuthMock.mockResolvedValue({ profile: companyProfile })

    await expectAppErrorAsync(() => requireAuthAdmin(ctx), ErrorCode.AUTHZ_ADMIN_REQUIRED)
  })

  it('requireAuthAdmin returns the auth result for admins', async () => {
    const result = { identity: { subject: 'admin' }, user: {}, profile: adminProfile }
    requireAuthMock.mockResolvedValue(result)

    await expect(requireAuthAdmin(ctx)).resolves.toBe(result)
  })

  it('requireAuthAdmin surfaces the unauthenticated error from requireAuth', async () => {
    requireAuthMock.mockRejectedValue(new Error('No autenticado'))

    await expect(requireAuthAdmin(ctx)).rejects.toThrow(/No autenticado/)
  })
})

// ============================================================================
// 4. ENTITIES (company / investor lookup)
// ============================================================================

function createEntityCtx(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    db: {
      query: vi.fn((table: string) => {
        let ownerId: unknown
        const tableRows = rows[table] ?? []
        const builder = {
          withIndex: vi.fn(
            (
              _index: string,
              callback?: (q: { eq: (f: string, v: unknown) => unknown }) => unknown
            ) => {
              const indexBuilder = {
                eq: (_field: string, value: unknown) => {
                  ownerId = value
                  return indexBuilder
                },
              }
              callback?.(indexBuilder)
              return builder
            }
          ),
          unique: vi.fn(async () => tableRows.find((row) => row.ownerId === ownerId) ?? null),
          // El evaluador de empresa lee vínculos, membresías y el control.
          // Este ctx no siembra esas tablas: vacío es primer login, autorizado.
          // `take` sí filtra companies: resolveCurrent las carga así, no con unique.
          first: vi.fn(async () => null),
          take: vi.fn(async () =>
            table === 'companies' ? tableRows.filter((row) => row.ownerId === ownerId) : []
          ),
          collect: vi.fn(async () => []),
        }
        return builder
      }),
    },
  } as never
}

describe('auth.entities (real implementation)', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
  })

  it('getAuthenticatedCompany returns null company when the profile has none', async () => {
    requireAuthMock.mockResolvedValue({ profile: companyProfile })
    const ctx = createEntityCtx({ companies: [] })

    await expect(getAuthenticatedCompany(ctx)).resolves.toEqual({
      profile: companyProfile,
      company: null,
    })
  })

  it('requireAuthenticatedCompany throws BUSINESS_MISSING_PROFILE when there is no company row', async () => {
    requireAuthMock.mockResolvedValue({ profile: companyProfile })
    const ctx = createEntityCtx({ companies: [] })

    await expectAppErrorAsync(
      () => requireAuthenticatedCompany(ctx),
      ErrorCode.BUSINESS_MISSING_PROFILE
    )
  })

  it('requireAuthenticatedCompany returns the company owned by the caller', async () => {
    const company = { _id: 'company_1', ownerId: companyProfile._id }
    requireAuthMock.mockResolvedValue({
      profile: companyProfile,
      user: {
        _id: companyProfile.userId,
        authProvider: 'workos',
        providerUserId: 'workos_company',
        workosUserId: 'workos_company',
        email: 'company@example.com',
      },
      identity: {
        subject: 'workos_company',
        authProvider: 'workos',
        issuer: 'https://api.workos.com/',
      },
    })
    const ctx = createEntityCtx({ companies: [company, { _id: 'company_2', ownerId: 'other' }] })

    await expect(requireAuthenticatedCompany(ctx)).resolves.toEqual({
      profile: companyProfile,
      company,
    })
  })

  it('never returns another profile company (ownership scoping of the index lookup)', async () => {
    requireAuthMock.mockResolvedValue({ profile: companyProfile })
    const ctx = createEntityCtx({ companies: [{ _id: 'company_2', ownerId: otherOwnerId }] })

    const { company } = await getAuthenticatedCompany(ctx)
    expect(company).toBeNull()
  })
})
