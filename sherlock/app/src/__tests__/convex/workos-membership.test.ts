// ============================================================================
// workos.getMyMembershipForOrg — recorre lo del usuario, no la organización
// ============================================================================
// H16 del informe A2 (cobertura 2026-09-11).
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: vi.fn(),
}))

import { getMyMembershipForOrg } from '../../../convex/workos'
import { requireAuth } from '../../../convex/_helpers/auth'
import { createConvexCtx, runHandler, type Row } from './nda-convex-harness'

const mockRequireAuth = vi.mocked(requireAuth)

function membership(id: string, userId: string, workosOrgId: string): Row {
  return { _id: id, _creationTime: 1, userId, workosOrgId, status: 'ACTIVE' }
}

describe('convex/workos.ts getMyMembershipForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      identity: { subject: 'workos_me' },
      user: { _id: 'users_me', email: 'me@example.com' },
      profile: { _id: 'profiles_me', role: 'COMPANY', userId: 'users_me' },
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)
  })

  it('devuelve la membresía propia en la organización pedida y va por by_userId', async () => {
    const ctx = createConvexCtx({
      organizationMemberships: [
        membership('memberships_other_a', 'users_other', 'org_a'),
        membership('memberships_me_b', 'users_me', 'org_b'),
        membership('memberships_me_a', 'users_me', 'org_a'),
      ],
    })

    const found = await runHandler<{ workosOrgId: string }, Row | null>(
      getMyMembershipForOrg,
      ctx,
      { workosOrgId: 'org_a' }
    )
    const missing = await runHandler<{ workosOrgId: string }, Row | null>(
      getMyMembershipForOrg,
      ctx,
      { workosOrgId: 'org_c' }
    )

    expect(found?._id).toBe('memberships_me_a')
    expect(missing).toBeNull()
    const builder = ctx.db.query.mock.results[0]?.value as {
      withIndex: { mock: { calls: Array<[string]> } }
    }
    expect(builder.withIndex.mock.calls[0]?.[0]).toBe('by_userId')
  })
})
