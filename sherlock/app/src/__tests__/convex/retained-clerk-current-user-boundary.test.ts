import { describe, expect, it, vi } from 'vitest'

import { ensureCompanyWorkspace } from '../../../convex/companies'
import { getCurrentUserState, makeAdmin } from '../../../convex/users'

type Row = Record<string, unknown> & { _id: string }
type Filter = { field: string; value: unknown }

const RETAINED_CLERK_IDENTITY = {
  subject: 'user_clerk_admin_retained',
  issuer: 'https://saved-cobra-14.clerk.accounts.dev',
  tokenIdentifier: 'https://saved-cobra-14.clerk.accounts.dev|user_clerk_admin_retained',
  email: 'admin@example.com',
}

const DUAL_LINKED_ADMIN = {
  _id: 'user_admin',
  clerkId: RETAINED_CLERK_IDENTITY.subject,
  authProvider: 'workos',
  providerUserId: 'user_workos_admin',
  workosUserId: 'user_workos_admin',
  email: 'admin@example.com',
  role: 'ADMIN',
}

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []
  const range = {
    eq: (field: string, value: unknown) => {
      filters.push({ field, value })
      return range
    },
  }
  const matchingRows = () => rows.filter((row) => filters.every((f) => row[f.field] === f.value))
  const builder = {
    withIndex: vi.fn((_index: string, callback?: (query: typeof range) => unknown) => {
      filters = []
      callback?.(range)
      return builder
    }),
    first: vi.fn(async () => matchingRows()[0] ?? null),
    unique: vi.fn(async () => matchingRows()[0] ?? null),
    collect: vi.fn(async () => matchingRows()),
  }
  return builder
}

function createRetainedClerkContext() {
  const patch = vi.fn()
  const insert = vi.fn()
  const remove = vi.fn()
  const get = vi.fn()
  const runAfter = vi.fn()
  const db = {
    query: vi.fn((table: string) => {
      if (table !== 'users') {
        throw new Error(`unexpected downstream read: ${table}`)
      }
      return createQueryBuilder([DUAL_LINKED_ADMIN])
    }),
    get,
    patch,
    insert,
    delete: remove,
  }
  const ctx = {
    auth: { getUserIdentity: vi.fn(async () => RETAINED_CLERK_IDENTITY) },
    db,
    scheduler: { runAfter },
  }

  return { ctx, db, get, patch, insert, remove, runAfter }
}

function createOptionalReadContext(identity: Record<string, unknown>, user: Row, profile: Row) {
  const rowsByTable: Record<string, Row[]> = {
    users: [user],
    profiles: [profile],
  }
  return {
    auth: { getUserIdentity: vi.fn(async () => identity) },
    db: {
      query: vi.fn((table: string) => createQueryBuilder(rowsByTable[table] ?? [])),
    },
  }
}

function handlerOf<TArgs, TResult>(value: unknown) {
  return (value as { _handler: (ctx: unknown, args: TArgs) => Promise<TResult> })._handler
}

function expectNoDownstreamStateAccess(context: ReturnType<typeof createRetainedClerkContext>) {
  expect(context.db.query.mock.calls.map(([table]) => table)).toEqual(
    Array(context.db.query.mock.calls.length).fill('users')
  )
  expect(context.get).not.toHaveBeenCalled()
  expect(context.patch).not.toHaveBeenCalled()
  expect(context.insert).not.toHaveBeenCalled()
  expect(context.remove).not.toHaveBeenCalled()
  expect(context.runAfter).not.toHaveBeenCalled()
}

describe('retained Clerk current-user boundary', () => {
  it('rejects an ADMIN role change before target reads, writes, audit, or scheduling', async () => {
    const context = createRetainedClerkContext()

    await expect(
      handlerOf<{ email: string }, unknown>(makeAdmin)(context.ctx, {
        email: 'target@example.com',
      })
    ).rejects.toThrow(/proveedor incompatible/i)

    expectNoDownstreamStateAccess(context)
  })

  it('rejects first-login provisioning before profile reads, bootstrap writes, or scheduling', async () => {
    const context = createRetainedClerkContext()

    await expect(
      handlerOf<Record<string, never>, unknown>(ensureCompanyWorkspace)(context.ctx, {})
    ).rejects.toThrow(/proveedor incompatible/i)

    expectNoDownstreamStateAccess(context)
  })

  it('getCurrentUserState degrades to null before the profile read', async () => {
    const context = createRetainedClerkContext()

    await expect(
      handlerOf<Record<string, never>, unknown>(getCurrentUserState)(context.ctx, {})
    ).resolves.toBe(null)

    expectNoDownstreamStateAccess(context)
  })

  it('preserves an exact WorkOS current-user state', async () => {
    const user = {
      _id: 'user_workos_exact',
      authProvider: 'workos',
      providerUserId: 'user_workos_exact',
      workosUserId: 'user_workos_exact',
      email: 'owner@example.com',
      role: 'COMPANY',
    }
    const profile = {
      _id: 'profile_company',
      userId: user._id,
      role: 'COMPANY',
      isActive: true,
    }
    const ctx = createOptionalReadContext(
      {
        subject: 'user_workos_exact',
        issuer: 'https://api.workos.com/user_management/client_test',
      },
      user,
      profile
    )

    await expect(
      handlerOf<Record<string, never>, unknown>(getCurrentUserState)(ctx, {})
    ).resolves.toEqual({ user, profile })
  })
})
