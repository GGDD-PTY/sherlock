import { describe, expect, it, vi } from 'vitest'
import {
  findUserByAuthIdentity,
  getIdentityAuthProvider,
  requireAuth,
} from '../../../convex/_helpers/auth.identity'

type QueryCall = {
  table: string
  index?: string
  values?: unknown[]
}

function createQueryBuilder(result: unknown, calls: QueryCall[], table: string) {
  const builder = {
    withIndex: vi.fn(
      (
        index: string,
        callback: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        const values: unknown[] = []
        callback({
          eq: (_field: string, value: unknown) => {
            values.push(value)
            return {
              eq: (_nextField: string, nextValue: unknown) => {
                values.push(nextValue)
                return {}
              },
            }
          },
        })
        calls.push({ table, index, values })
        return builder
      }
    ),
    first: vi.fn(async () => result),
    unique: vi.fn(async () => result),
  }

  return builder
}

function createCtx(results: Record<string, unknown>) {
  const calls: QueryCall[] = []
  const patch = vi.fn()
  const ctx = {
    db: {
      query: vi.fn((table: string) => createQueryBuilder(results[table] ?? null, calls, table)),
      patch,
      insert: vi.fn(),
    },
  }

  return { ctx, calls, patch }
}

describe('Convex provider-neutral auth identity resolver', () => {
  it('detects WorkOS identities from both WorkOS issuers', () => {
    expect(getIdentityAuthProvider({ issuer: 'https://api.workos.com/' })).toBe('workos')
    expect(
      getIdentityAuthProvider({
        issuer: 'https://api.workos.com/user_management/client_123',
      })
    ).toBe('workos')
    expect(getIdentityAuthProvider({ issuer: 'https://example.clerk.accounts.dev' })).toBe('clerk')
    expect(() => getIdentityAuthProvider({ issuer: 'https://unknown-idp.example.com/' })).toThrow(
      /no soportado/i
    )
  })

  it('resolves WorkOS users by authProvider + providerUserId first', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      email: 'ada@example.com',
    }
    const { ctx, calls, patch } = createCtx({ users: existingUser })

    const user = await findUserByAuthIdentity(ctx as never, {
      issuer: 'https://api.workos.com/',
      subject: 'user_workos_123',
      email: 'ada@example.com',
    })

    expect(user).toBe(existingUser)
    expect(calls[0]).toEqual({
      table: 'users',
      index: 'by_providerUserId',
      values: ['workos', 'user_workos_123'],
    })
    expect(patch).not.toHaveBeenCalled()
  })

  it('does not let a WorkOS identity claim an existing local account by email only', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      clerkId: 'user_clerk_old',
      email: 'ada@example.com',
    }
    const calls: QueryCall[] = []
    const patch = vi.fn()
    let queryCount = 0
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          queryCount += 1
          const result = queryCount === 3 ? existingUser : null
          return createQueryBuilder(result, calls, table)
        }),
        patch,
        insert: vi.fn(),
      },
    }

    const user = await findUserByAuthIdentity(ctx as never, {
      issuer: 'https://api.workos.com/',
      subject: 'user_workos_123',
      email: 'ada@example.com',
    })

    expect(user).toBeNull()
    expect(calls.map((call) => call.index)).toEqual(['by_providerUserId', 'by_workosUserId'])
    expect(patch).not.toHaveBeenCalled()
  })

  it('keeps Clerk fallback lookup for historical rows', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      clerkId: 'user_clerk_123',
      email: 'ada@example.com',
    }
    const calls: QueryCall[] = []
    const patch = vi.fn()
    let queryCount = 0
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          queryCount += 1
          const result = queryCount === 2 ? existingUser : null
          return createQueryBuilder(result, calls, table)
        }),
        patch,
        insert: vi.fn(),
      },
    }

    const user = await findUserByAuthIdentity(ctx as never, {
      issuer: 'https://saved-cobra-14.clerk.accounts.dev',
      subject: 'user_clerk_123',
      email: 'ada@example.com',
    })

    expect(user).toBe(existingUser)
    expect(calls.map((call) => call.index)).toEqual(['by_providerUserId', 'by_clerkId'])
    expect(patch).toHaveBeenCalledWith('user_convex_1', {
      authProvider: 'clerk',
      providerUserId: 'user_clerk_123',
    })
  })

  it('rejects a retained Clerk mutation before patching or reading business state', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      clerkId: 'user_clerk_123',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'ada@example.com',
    }
    const calls: QueryCall[] = []
    const patch = vi.fn()
    let userQueryCount = 0
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          issuer: 'https://saved-cobra-14.clerk.accounts.dev',
          subject: 'user_clerk_123',
          email: 'ada@example.com',
        }),
      },
      db: {
        query: vi.fn((table: string) => {
          if (table === 'users') {
            userQueryCount += 1
            return createQueryBuilder(userQueryCount === 2 ? existingUser : null, calls, table)
          }
          throw new Error(`unexpected business-state read: ${table}`)
        }),
        patch,
        insert: vi.fn(),
      },
    }

    await expect(requireAuth(ctx as never)).rejects.toThrow(/proveedor incompatible/i)

    expect(calls.map((call) => call.index)).toEqual(['by_providerUserId', 'by_clerkId'])
    expect(patch).not.toHaveBeenCalled()
    expect(ctx.db.query).toHaveBeenCalledTimes(2)
  })

  it('rejects a retained Clerk query before any profile or business-state read', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      clerkId: 'user_clerk_123',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      email: 'ada@example.com',
    }
    const calls: QueryCall[] = []
    const patch = vi.fn()
    let userQueryCount = 0
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          issuer: 'https://saved-cobra-14.clerk.accounts.dev',
          subject: 'user_clerk_123',
          email: 'ada@example.com',
        }),
      },
      db: {
        query: vi.fn((table: string) => {
          if (table === 'users') {
            userQueryCount += 1
            return createQueryBuilder(userQueryCount === 2 ? existingUser : null, calls, table)
          }
          throw new Error(`unexpected business-state read: ${table}`)
        }),
        patch,
      },
    }

    await expect(requireAuth(ctx as never)).rejects.toThrow(/proveedor incompatible/i)

    expect(calls.map((call) => call.index)).toEqual(['by_providerUserId', 'by_clerkId'])
    expect(patch).not.toHaveBeenCalled()
    expect(ctx.db.query).toHaveBeenCalledTimes(2)
  })

  it('still reconciles a WorkOS-linked row to the live WorkOS provider', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      clerkId: 'user_clerk_123',
      authProvider: 'clerk',
      providerUserId: 'user_clerk_123',
      workosUserId: 'user_workos_123',
      email: 'ada@example.com',
    }
    const calls: QueryCall[] = []
    const patch = vi.fn()
    let queryCount = 0
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          queryCount += 1
          return createQueryBuilder(queryCount === 2 ? existingUser : null, calls, table)
        }),
        patch,
        insert: vi.fn(),
      },
    }

    const user = await findUserByAuthIdentity(ctx as never, {
      issuer: 'https://api.workos.com/',
      subject: 'user_workos_123',
      email: 'ada@example.com',
    })

    expect(user).toBe(existingUser)
    expect(calls.map((call) => call.index)).toEqual(['by_providerUserId', 'by_workosUserId'])
    expect(patch).toHaveBeenCalledWith('user_convex_1', {
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      workosUserId: 'user_workos_123',
      emailVerified: true,
    })
  })

  it('rejects inactive profiles after resolving the provider identity', async () => {
    const existingUser = {
      _id: 'user_convex_1',
      authProvider: 'workos',
      providerUserId: 'user_workos_123',
      email: 'ada@example.com',
    }
    const inactiveProfile = {
      _id: 'profile_1',
      userId: 'user_convex_1',
      role: 'COMPANY',
      isActive: false,
    }
    const calls: QueryCall[] = []
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          issuer: 'https://api.workos.com/',
          subject: 'user_workos_123',
          email: 'ada@example.com',
        }),
      },
      db: {
        query: vi.fn((table: string) =>
          createQueryBuilder(table === 'users' ? existingUser : inactiveProfile, calls, table)
        ),
        patch: vi.fn(),
        insert: vi.fn(),
      },
    }

    await expect(requireAuth(ctx as never)).rejects.toThrow(/desactivada|inactiva/i)
  })
})
