import { describe, expect, it } from 'vitest'

import { deactivateOwnAccount } from '../../../convex/users'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const WORKOS_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_self',
  email: 'owner@example.com',
}

function selfServiceSeed(): Tables {
  return {
    users: [
      {
        _id: 'user_self',
        authProvider: 'workos',
        providerUserId: 'workos_self',
        workosUserId: 'workos_self',
        email: 'owner@example.com',
      },
    ],
    profiles: [
      {
        _id: 'profile_self',
        userId: 'user_self',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_other',
        userId: 'user_other',
        role: 'COMPANY',
        isActive: true,
      },
    ],
  }
}

describe('deactivateOwnAccount', () => {
  it('soft-deletes the caller with a sticky USER hold and a security event', async () => {
    const ctx = createConvexCtx(selfServiceSeed(), { identity: WORKOS_IDENTITY })

    await expect(
      runHandler(deactivateOwnAccount, ctx, { profileId: 'profile_self' })
    ).resolves.toEqual({ success: true })

    expect(ctx.tables.profiles[0]).toMatchObject({
      _id: 'profile_self',
      isActive: false,
      deactivatedBy: 'USER',
    })
    expect(ctx.tables.securityEvents).toEqual([
      expect.objectContaining({
        type: 'ACCOUNT_SELF_DEACTIVATION',
        severity: 'INFO',
        userId: 'user_self',
        userEmail: 'owner@example.com',
        details: { profileId: 'profile_self', role: 'COMPANY' },
        resolved: false,
      }),
    ])
    expect(ctx.db.patch).toHaveBeenCalledTimes(1)
  })

  it('rejects a cross-profile id before any write', async () => {
    const ctx = createConvexCtx(selfServiceSeed(), { identity: WORKOS_IDENTITY })

    await expect(
      runHandler(deactivateOwnAccount, ctx, { profileId: 'profile_other' })
    ).rejects.toThrow(/solo puedes desactivar tu propia cuenta/i)

    expect(ctx.tables.profiles[0]).toMatchObject({ _id: 'profile_self', isActive: true })
    expect(ctx.tables.profiles[1]).toMatchObject({ _id: 'profile_other', isActive: true })
    expect(ctx.tables.securityEvents ?? []).toHaveLength(0)
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller before reading profiles', async () => {
    const ctx = createConvexCtx(selfServiceSeed(), { identity: null })

    await expect(
      runHandler(deactivateOwnAccount, ctx, { profileId: 'profile_self' })
    ).rejects.toThrow(/autenticad/i)

    expect(ctx.tables.profiles[0]).toMatchObject({ isActive: true })
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('cannot be used again once the account is already paused', async () => {
    const tables = selfServiceSeed()
    tables.profiles[0] = { ...tables.profiles[0]!, isActive: false, deactivatedBy: 'USER' }
    const ctx = createConvexCtx(tables, { identity: WORKOS_IDENTITY })

    await expect(
      runHandler(deactivateOwnAccount, ctx, { profileId: 'profile_self' })
    ).rejects.toThrow(/desactivada o inactiva/i)

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.tables.securityEvents ?? []).toHaveLength(0)
  })
})
