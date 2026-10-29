import { describe, expect, it } from 'vitest'

import {
  buildWorkOsAuthSession,
  mapBetaRoleToProfileRole,
  mapWorkOsRoleToBetaRole,
} from '@/lib/auth/provider-boundary'

describe('auth provider boundary', () => {
  it('maps WorkOS organization membership roles to Sherlock beta roles', () => {
    const session = buildWorkOsAuthSession({
      user: {
        id: 'user_workos_123',
        email: 'fixture-49b80e22@example.com',
        firstName: 'Ana',
        lastName: 'Lyst',
      },
      organization: {
        id: 'org_workos_456',
        name: 'Capital Example',
      },
      roleSlug: 'company_member',
    })

    expect(session.identity).toMatchObject({
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'fixture-49b80e22@example.com',
      name: 'Ana Lyst',
    })
    expect(session.memberships).toHaveLength(1)
    expect(session.memberships[0]).toMatchObject({
      authProvider: 'workos',
      providerOrgId: 'org_workos_456',
      name: 'Capital Example',
      betaRole: 'COMPANY_MEMBER',
      profileRole: 'COMPANY',
    })
  })

  it('keeps beta role mapping explicit for private beta permissions', () => {
    expect(mapWorkOsRoleToBetaRole('admin')).toBe('ADMIN')
    expect(mapWorkOsRoleToBetaRole('company_owner')).toBe('COMPANY_OWNER')
    expect(mapWorkOsRoleToBetaRole('company_member')).toBe('COMPANY_MEMBER')
    expect(mapWorkOsRoleToBetaRole('counsel_reviewer')).toBe('COUNSEL_REVIEWER')
    expect(mapWorkOsRoleToBetaRole('unknown_role')).toBeNull()
    // INVESTOR salió del producto ([F] 2026-09-16): sus slugs ya no mapean.
    expect(mapWorkOsRoleToBetaRole('investor_owner')).toBeNull()
    expect(mapWorkOsRoleToBetaRole('investor_analyst')).toBeNull()

    expect(mapBetaRoleToProfileRole('ADMIN')).toBe('ADMIN')
    expect(mapBetaRoleToProfileRole('COMPANY_OWNER')).toBe('COMPANY')
    expect(mapBetaRoleToProfileRole('COMPANY_MEMBER')).toBe('COMPANY')
    expect(mapBetaRoleToProfileRole('COUNSEL_REVIEWER')).toBe('ADMIN')
  })
})
