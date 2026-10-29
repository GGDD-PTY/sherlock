import { afterEach, describe, expect, it, vi } from 'vitest'

import { bootstrapUsers } from '../../../convex/devAuth'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

function enableLocal() {
  vi.stubEnv('BYPASS_AUTH', 'true')
  vi.stubEnv('CONVEX_ENV', 'dev')
}

afterEach(() => vi.unstubAllEnvs())

describe('dev login identity bootstrap', () => {
  it('creates the fixed identities with real profiles and no companies or documents', async () => {
    enableLocal()
    const tables: Tables = {}
    const ctx = createConvexCtx(tables)
    await expect(runHandler(bootstrapUsers, ctx, {})).resolves.toEqual({ ready: true })
    expect(tables.users).toHaveLength(2)
    expect(tables.profiles).toHaveLength(2)
    expect(tables.users.map((user) => [user.email, user.workosUserId])).toEqual([
      ['admin@dev.local', 'dev_admin_001_workos'],
      ['company@dev.local', 'dev_company_001_workos'],
    ])
    expect(ctx.inserted.map((entry) => entry.table)).toEqual([
      'users',
      'profiles',
      'users',
      'profiles',
    ])

    await runHandler(bootstrapUsers, ctx, {})
    expect(tables.users).toHaveLength(2)
    expect(tables.profiles).toHaveLength(2)
    expect(ctx.inserted).toHaveLength(4)
  })

  it.each(['production', 'prod', ''])(
    'cannot provision identities with CONVEX_ENV=%s',
    async (environment) => {
      vi.stubEnv('BYPASS_AUTH', 'true')
      vi.stubEnv('CONVEX_ENV', environment)
      const ctx = createConvexCtx({})
      await expect(runHandler(bootstrapUsers, ctx, {})).rejects.toThrow(/no está habilitado/)
      expect(ctx.db.insert).not.toHaveBeenCalled()
      expect(ctx.db.query).not.toHaveBeenCalled()
    }
  )
})
