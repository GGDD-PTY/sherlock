import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeAdmin } from '../../../convex/users'
import {
  createMockConvexCtx,
  createMockQueryBuilder,
  createMockUserIdentity,
  mockAuthenticatedUser,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import {
  createMockProfile,
  createMockUser,
  resetIdCounter,
} from '../utils/test-factories'

type MutationWithHandler<Args, Result> = {
  _handler: (ctx: MockConvexCtx, args: Args) => Promise<Result>
}

const makeAdminHandler = (
  makeAdmin as unknown as MutationWithHandler<{ email: string }, { success: boolean }>
)._handler

describe('admin audit wiring — makeAdmin', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  it('persists a USER_ROLE_CHANGE entry in adminAuditLogs', async () => {
    const adminAuthId = 'auth_admin_wiring'
    mockAuthenticatedUser(ctx, createMockUserIdentity({ subject: adminAuthId }))

    const adminUser = createMockUser({
      clerkId: adminAuthId,
      role: 'ADMIN',
      email: 'fixture-14e4636f@example.com',
    })
    const adminProfile = createMockProfile({
      userId: adminUser._id,
      role: 'ADMIN',
      isVerified: true,
    })
    const targetUser = createMockUser({
      role: 'COMPANY',
      email: 'fixture-57e5edf1@example.com',
    })
    const targetProfile = createMockProfile({
      userId: targetUser._id,
      role: 'COMPANY',
      isVerified: true,
    })
    let usersQueryCount = 0
    let profilesQueryCount = 0

    ctx.db.query.mockImplementation((table: string) => {
      if (table === 'users') {
        usersQueryCount += 1
        return createMockQueryBuilder([usersQueryCount === 1 ? adminUser : targetUser])
      }
      if (table === 'profiles') {
        profilesQueryCount += 1
        return createMockQueryBuilder([profilesQueryCount === 1 ? adminProfile : targetProfile])
      }
      return createMockQueryBuilder([])
    })

    await makeAdminHandler(ctx, { email: targetUser.email })

    expect(ctx.db.insert).toHaveBeenCalledWith(
      'adminAuditLogs',
      expect.objectContaining({
        action: 'USER_ROLE_CHANGE',
        targetType: 'PROFILE',
        targetId: targetProfile._id,
        adminEmail: 'fixture-14e4636f@example.com',
        previousValue: { role: 'COMPANY' },
        newValue: { role: 'ADMIN' },
      })
    )
  })
})
