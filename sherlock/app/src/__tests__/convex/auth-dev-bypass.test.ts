// ============================================================================
// CONVEX AUTH DEV BYPASS TEST SUITE
// ============================================================================
// Tests for convex/_helpers/auth.dev.ts — dev auth bypass functions used
// in local development and E2E testing.
//
// Test Categories:
// 1. isDevAuthBypassedViaEnv() - Environment variable gate
// 2. tryGetDevUser() - Finding/creating dev users
// 3. getDevAuthResult() - Full dev auth flow without automatic company data
// 4. ensureDevRoleEntity() - Role entity creation (tested via behavior)
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMockConvexCtx,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import { createMockUser, createMockProfile, mockId, resetIdCounter } from '../utils/test-factories'

// ============================================================================
// IMPORT THE MODULE UNDER TEST
// ============================================================================

import {
  isDevAuthBypassedViaEnv,
  tryGetDevUser,
  getDevAuthResult,
} from '../../../convex/_helpers/auth.dev'

// ============================================================================
// ENV HELPERS
// ============================================================================

const originalEnv = { ...process.env }

// Helper to modify process.env without TS read-only errors
function setEnv(key: string, value: string) {
  ;(process.env as Record<string, string | undefined>)[key] = value
}
function deleteEnv(key: string) {
  delete (process.env as Record<string, string | undefined>)[key]
}

function setDevBypass(enabled: boolean) {
  setEnv('NODE_ENV', 'development')
  if (enabled) {
    setEnv('BYPASS_AUTH', 'true')
    // El guard fail-closed exige que el deployment se declare dev explícitamente
    setEnv('CONVEX_ENV', 'dev')
  } else {
    deleteEnv('BYPASS_AUTH')
    deleteEnv('CONVEX_ENV')
  }
}

function expectPresent<T>(value: T | null | undefined): asserts value is T {
  expect(value).not.toBeNull()
  expect(value).not.toBeUndefined()
}

// ============================================================================
// TEST SUITE: isDevAuthBypassedViaEnv
// ============================================================================

describe('isDevAuthBypassedViaEnv()', () => {
  afterEach(() => {
    Object.keys(process.env).forEach((k) => deleteEnv(k))
    Object.assign(process.env, originalEnv)
  })

  it('returns false when nothing is set', () => {
    deleteEnv('NODE_ENV')
    deleteEnv('BYPASS_AUTH')
    deleteEnv('CONVEX_ENV')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns false when BYPASS_AUTH is "true" but CONVEX_ENV is not set (stray flag on prod is inert)', () => {
    deleteEnv('NODE_ENV')
    deleteEnv('CONVEX_ENV')
    setEnv('BYPASS_AUTH', 'true')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns false when BYPASS_AUTH is "true" and CONVEX_ENV is "production"', () => {
    setEnv('BYPASS_AUTH', 'true')
    setEnv('CONVEX_ENV', 'production')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns false when CONVEX_ENV is "dev" but BYPASS_AUTH is not set', () => {
    setEnv('CONVEX_ENV', 'dev')
    deleteEnv('BYPASS_AUTH')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns false when CONVEX_ENV is "dev" and BYPASS_AUTH is "false"', () => {
    setEnv('CONVEX_ENV', 'dev')
    setEnv('BYPASS_AUTH', 'false')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns true when BYPASS_AUTH is "true" and CONVEX_ENV is "dev"', () => {
    setEnv('BYPASS_AUTH', 'true')
    setEnv('CONVEX_ENV', 'dev')
    expect(isDevAuthBypassedViaEnv()).toBe(true)
  })

  it('ignores NODE_ENV entirely — CONVEX_ENV is the only runtime gate', () => {
    setEnv('NODE_ENV', 'production')
    setEnv('BYPASS_AUTH', 'true')
    setEnv('CONVEX_ENV', 'dev')
    expect(isDevAuthBypassedViaEnv()).toBe(true)
  })

  it('does NOT trust a dev-prefixed CONVEX_DEPLOYMENT name — only explicit CONVEX_ENV', () => {
    // CONVEX_DEPLOYMENT es convención del CLI local; no existe dentro del
    // runtime de Convex, así que el guard no debe aceptarla como señal.
    deleteEnv('NODE_ENV')
    deleteEnv('CONVEX_ENV')
    setEnv('CONVEX_DEPLOYMENT', 'dev:kindly-mole-736')
    setEnv('BYPASS_AUTH', 'true')
    expect(isDevAuthBypassedViaEnv()).toBe(false)
  })

  it('returns true on a declared dev deployment even when NODE_ENV is production', () => {
    setEnv('NODE_ENV', 'production')
    setEnv('CONVEX_DEPLOYMENT', 'dev:kindly-mole-736')
    setEnv('CONVEX_ENV', 'dev')
    setEnv('BYPASS_AUTH', 'true')
    expect(isDevAuthBypassedViaEnv()).toBe(true)
  })
})

// ============================================================================
// TEST SUITE: tryGetDevUser — existing users
// ============================================================================

describe('tryGetDevUser()', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    resetIdCounter()
    ctx = createMockConvexCtx()
  })

  afterEach(() => {
    Object.keys(process.env).forEach((k) => deleteEnv(k))
    Object.assign(process.env, originalEnv)
  })

  describe('when bypass is not enabled', () => {
    it('returns null immediately', async () => {
      setEnv('NODE_ENV', 'production')
      deleteEnv('BYPASS_AUTH')

      const result = await tryGetDevUser(ctx as never)
      expect(result).toBeNull()
      expect(ctx.db.query).not.toHaveBeenCalled()
    })
  })

  describe('existing users (mutation context)', () => {
    beforeEach(() => {
      setDevBypass(true)
    })

    it('finds existing admin@dev.local user and returns AuthResult', async () => {
      const userId = mockId('users')
      const profileId = mockId('profiles')
      const adminUser = createMockUser({
        _id: userId,
        email: 'admin@dev.local',
        name: 'Dev Admin User',
        clerkId: 'dev_admin_001',
        role: 'ADMIN',
      })
      const adminProfile = createMockProfile({
        _id: profileId,
        userId,
        role: 'ADMIN',
        fullName: 'Dev Admin User',
      })

      // First query for users by email returns admin user
      const userQueryBuilder = createMockQueryBuilder([adminUser])
      // Second query for profiles by userId returns profile
      const profileQueryBuilder = createMockQueryBuilder([adminProfile])

      ctx.db.query
        .mockReturnValueOnce(userQueryBuilder) // users query for admin@dev.local
        .mockReturnValueOnce(profileQueryBuilder) // profiles query

      const result = await tryGetDevUser(ctx as never)

      expectPresent(result)
      expect(result.user.email).toBe('admin@dev.local')
      expect(result.profile.role).toBe('ADMIN')
      expect(result.identity.subject).toBe('dev_admin_001')
    })

    it('finds existing company@dev.local user', async () => {
      const userId = mockId('users')
      const profileId = mockId('profiles')
      const companyUser = createMockUser({
        _id: userId,
        email: 'company@dev.local',
        name: 'Test Company User',
        clerkId: 'dev_company_001',
        role: 'COMPANY',
      })
      const companyProfile = createMockProfile({
        _id: profileId,
        userId,
        role: 'COMPANY',
        fullName: 'Test Company User',
      })

      const emptyBuilder = createMockQueryBuilder([])
      const userQueryBuilder = createMockQueryBuilder([companyUser])
      const profileQueryBuilder = createMockQueryBuilder([companyProfile])
      const companyEntityBuilder = createMockQueryBuilder([{ _id: mockId('companies') }])

      ctx.db.query
        .mockReturnValueOnce(emptyBuilder) // users: admin@dev.local
        .mockReturnValueOnce(userQueryBuilder) // users: company@dev.local
        .mockReturnValueOnce(profileQueryBuilder) // profiles by userId
        .mockReturnValueOnce(companyEntityBuilder) // companies by ownerId

      const result = await tryGetDevUser(ctx as never)

      expectPresent(result)
      expect(result.user.email).toBe('company@dev.local')
      expect(result.identity.subject).toBe('dev_company_001')
    })

    it('does not seed companies while resolving an existing identity', async () => {
      const userId = mockId('users')
      const profileId = mockId('profiles')
      const companyUser = createMockUser({
        _id: userId,
        email: 'company@dev.local',
        name: 'Test Company User',
        clerkId: 'dev_company_001',
        role: 'COMPANY',
      })
      const companyProfile = createMockProfile({
        _id: profileId,
        userId,
        role: 'COMPANY',
      })

      const emptyBuilder = createMockQueryBuilder([])
      const userBuilder = createMockQueryBuilder([companyUser])
      const profileBuilder = createMockQueryBuilder([companyProfile])
      const noCompanyBuilder = createMockQueryBuilder([])

      ctx.db.query
        .mockReturnValueOnce(emptyBuilder) // admin@dev.local
        .mockReturnValueOnce(userBuilder) // company@dev.local
        .mockReturnValueOnce(profileBuilder) // profiles
        .mockReturnValueOnce(noCompanyBuilder) // companies by ownerId

      await tryGetDevUser(ctx as never)

      expect(ctx.db.insert).not.toHaveBeenCalled()
    })
  })

  describe('existing users (query context)', () => {
    beforeEach(() => {
      setDevBypass(true)
    })

    it('does NOT call ensureDevRoleEntity in query context', async () => {
      const userId = mockId('users')
      const profileId = mockId('profiles')
      const companyUser = createMockUser({
        _id: userId,
        email: 'company@dev.local',
        name: 'Test Company User',
        clerkId: 'dev_company_001',
        role: 'COMPANY',
      })
      const companyProfile = createMockProfile({
        _id: profileId,
        userId,
        role: 'COMPANY',
      })

      const queryCtx = {
        ...ctx,
        db: { ...ctx.db, insert: undefined },
      }

      const emptyBuilder = createMockQueryBuilder([])
      const userBuilder = createMockQueryBuilder([companyUser])
      const profileBuilder = createMockQueryBuilder([companyProfile])

      queryCtx.db.query
        .mockReturnValueOnce(emptyBuilder) // admin@dev.local
        .mockReturnValueOnce(userBuilder) // company@dev.local
        .mockReturnValueOnce(profileBuilder) // profiles

      const result = await tryGetDevUser(queryCtx as never)

      expectPresent(result)
      expect(result.user.email).toBe('company@dev.local')
      expect(queryCtx.db.query).toHaveBeenCalledTimes(3)
    })
  })

  // ============================================================================
  // tryGetDevUser — auto-creation (mutation context)
  // ============================================================================

  describe('auto-creation (mutation context)', () => {
    beforeEach(() => {
      setDevBypass(true)
    })

    it('creates both dev users when none exist', async () => {
      const emptyBuilder = () => createMockQueryBuilder([])
      ctx.db.query.mockImplementation(() => emptyBuilder())

      const adminUserId = mockId('users')
      const companyUserId = mockId('users')
      const adminProfileId = mockId('profiles')
      const companyProfileId = mockId('profiles')

      const adminUser = createMockUser({
        _id: adminUserId,
        email: 'admin@dev.local',
        name: 'Dev Admin User',
        clerkId: 'dev_admin_001',
        role: 'ADMIN',
      })
      const companyUser = createMockUser({
        _id: companyUserId,
        email: 'company@dev.local',
        name: 'Test Company User',
        clerkId: 'dev_company_001',
        role: 'COMPANY',
      })

      const adminProfile = createMockProfile({
        _id: adminProfileId,
        userId: adminUserId,
        role: 'ADMIN',
      })
      const companyProfile = createMockProfile({
        _id: companyProfileId,
        userId: companyUserId,
        role: 'COMPANY',
      })

      ctx.db.insert
        .mockResolvedValueOnce(adminUserId)
        .mockResolvedValueOnce(adminProfileId)
        .mockResolvedValueOnce(companyUserId)
        .mockResolvedValueOnce(companyProfileId)
        .mockResolvedValueOnce(mockId('companies'))

      ctx.db.get
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(adminProfile)
        .mockResolvedValueOnce(companyUser)
        .mockResolvedValueOnce(companyProfile)

      const result = await tryGetDevUser(ctx as never)

      expect(result).not.toBeNull()
      expect(ctx.db.insert).toHaveBeenCalled()
      const insertCalls = ctx.db.insert.mock.calls
      const userInserts = insertCalls.filter((call) => call[0] === 'users')
      expect(userInserts).toHaveLength(2)
      const investorInserts = insertCalls.filter((call) => call[0] === 'investors')
      expect(investorInserts).toHaveLength(0)
    })

    it('does not create a company while creating dev identities', async () => {
      ctx.db.query.mockImplementation(() => createMockQueryBuilder([]))

      const adminUserId = mockId('users')
      const adminProfileId = mockId('profiles')
      const companyUserId = mockId('users')
      const companyProfileId = mockId('profiles')

      const adminUser = createMockUser({
        _id: adminUserId,
        email: 'admin@dev.local',
        clerkId: 'dev_admin_001',
        role: 'ADMIN',
      })
      const adminProfile = createMockProfile({
        _id: adminProfileId,
        userId: adminUserId,
        role: 'ADMIN',
      })
      const companyUser = createMockUser({
        _id: companyUserId,
        email: 'company@dev.local',
        clerkId: 'dev_company_001',
        role: 'COMPANY',
      })
      const companyProfile = createMockProfile({
        _id: companyProfileId,
        userId: companyUserId,
        role: 'COMPANY',
      })

      ctx.db.insert
        .mockResolvedValueOnce(adminUserId)
        .mockResolvedValueOnce(adminProfileId)
        .mockResolvedValueOnce(companyUserId)
        .mockResolvedValueOnce(companyProfileId)
        .mockResolvedValueOnce(mockId('companies'))

      ctx.db.get
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(adminProfile)
        .mockResolvedValueOnce(companyUser)
        .mockResolvedValueOnce(companyProfile)

      await tryGetDevUser(ctx as never)

      const insertCalls = ctx.db.insert.mock.calls
      const companyInserts = insertCalls.filter((call) => call[0] === 'companies')
      expect(companyInserts).toHaveLength(0)
    })

    it('returns first created user as result', async () => {
      ctx.db.query.mockImplementation(() => createMockQueryBuilder([]))

      const adminUserId = mockId('users')
      const adminProfileId = mockId('profiles')
      const adminUser = createMockUser({
        _id: adminUserId,
        email: 'admin@dev.local',
        name: 'Dev Admin User',
        clerkId: 'dev_admin_001',
        role: 'ADMIN',
      })
      const adminProfile = createMockProfile({
        _id: adminProfileId,
        userId: adminUserId,
        role: 'ADMIN',
        fullName: 'Dev Admin User',
      })

      // Only mock enough for the first user; subsequent creates will use defaults
      ctx.db.insert.mockResolvedValue(mockId('misc'))
      ctx.db.get
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(adminProfile)
        .mockResolvedValue(createMockUser({ email: 'other@dev.local', clerkId: 'other_001' }))

      const result = await tryGetDevUser(ctx as never)

      expectPresent(result)
      expect(result.user.email).toBe('admin@dev.local')
      expect(result.identity.subject).toBe('dev_admin_001')
      expect(result.identity.email).toBe('admin@dev.local')
      expect(result.identity.name).toBe('Dev Admin User')
    })

    it('returns null in query context (no db.insert available)', async () => {
      const queryCtx = {
        ...ctx,
        db: { ...ctx.db, insert: undefined },
      }

      // All user lookups return empty
      queryCtx.db.query.mockImplementation(() => createMockQueryBuilder([]))

      const result = await tryGetDevUser(queryCtx as never)

      expect(result).toBeNull()
    })
  })
})

// ============================================================================
// TEST SUITE: getDevAuthResult
// ============================================================================

describe('getDevAuthResult()', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    resetIdCounter()
    ctx = createMockConvexCtx()
  })

  afterEach(() => {
    Object.keys(process.env).forEach((k) => deleteEnv(k))
    Object.assign(process.env, originalEnv)
  })

  it('throws when bypass is not enabled', async () => {
    setEnv('NODE_ENV', 'production')
    deleteEnv('BYPASS_AUTH')

    await expect(getDevAuthResult(ctx as never)).rejects.toThrow(
      'Dev auth no está habilitado en este entorno'
    )
  })

  it('creates an admin identity without companies in mutation context', async () => {
    setDevBypass(true)

    const userId = mockId('users')
    const profileId = mockId('profiles')
    const companyId = mockId('companies')

    const adminUser = createMockUser({
      _id: userId,
      email: 'admin@dev.local',
      name: 'Dev Admin User',
      clerkId: 'dev_admin_001',
      role: 'ADMIN',
    })
    const adminProfile = createMockProfile({
      _id: profileId,
      userId,
      role: 'ADMIN',
      fullName: 'Dev Admin User',
    })

    const emptyUniqueBuilder = () => {
      const b = createMockQueryBuilder([])
      b.unique = vi.fn().mockResolvedValue(null)
      return b
    }

    const companyDoc = {
      _id: companyId,
      ownerId: profileId,
      name: 'Demo Company LATAM',
    }

    ctx.db.query
      .mockReturnValueOnce(emptyUniqueBuilder()) // users by email (ensureDevUserAndProfile)
      .mockReturnValueOnce(emptyUniqueBuilder()) // profiles by userId
      .mockReturnValueOnce(emptyUniqueBuilder()) // companies by ownerId (ensureDevDemoEntities)

    ctx.db.insert
      .mockResolvedValueOnce(userId) // insert user
      .mockResolvedValueOnce(profileId) // insert profile
      .mockResolvedValueOnce(companyId) // insert company

    ctx.db.get
      .mockResolvedValueOnce(adminUser) // get user after insert
      .mockResolvedValueOnce(adminProfile) // get profile after insert
      .mockResolvedValueOnce(companyDoc) // get company after insert

    const result = await getDevAuthResult(ctx as never)

    expect(result.user.email).toBe('admin@dev.local')
    expect(result.identity.subject).toBe('dev_admin_001')
    expect(result.profile).toBeDefined()

    // Authentication must leave company data empty.
    const insertCalls = ctx.db.insert.mock.calls
    const companyInserts = insertCalls.filter((call) => call[0] === 'companies')
    expect(companyInserts).toHaveLength(0)
  })

  it('throws in query context when dev user does not exist', async () => {
    setDevBypass(true)

    const queryCtx = {
      ...ctx,
      db: { ...ctx.db, insert: undefined },
    }

    // users query returns null (user not found)
    const emptyUniqueBuilder = createMockQueryBuilder([])
    emptyUniqueBuilder.unique = vi.fn().mockResolvedValue(null)
    queryCtx.db.query.mockReturnValueOnce(emptyUniqueBuilder)

    await expect(getDevAuthResult(queryCtx as never)).rejects.toThrow(
      'Usuario de desarrollo no encontrado'
    )
  })

  it('returns existing admin user in query context when user exists', async () => {
    setDevBypass(true)

    const userId = mockId('users')
    const profileId = mockId('profiles')
    const adminUser = createMockUser({
      _id: userId,
      email: 'admin@dev.local',
      name: 'Dev Admin User',
      clerkId: 'dev_admin_001',
      role: 'ADMIN',
    })
    const adminProfile = createMockProfile({
      _id: profileId,
      userId,
      role: 'ADMIN',
      fullName: 'Dev Admin User',
    })

    const queryCtx = {
      ...ctx,
      db: { ...ctx.db, insert: undefined },
    }

    // users query returns existing user
    const userUniqueBuilder = createMockQueryBuilder([adminUser])
    userUniqueBuilder.unique = vi.fn().mockResolvedValue(adminUser)
    // profiles query returns existing profile
    const profileUniqueBuilder = createMockQueryBuilder([adminProfile])
    profileUniqueBuilder.unique = vi.fn().mockResolvedValue(adminProfile)

    queryCtx.db.query
      .mockReturnValueOnce(userUniqueBuilder) // users by email
      .mockReturnValueOnce(profileUniqueBuilder) // profiles by userId

    const result = await getDevAuthResult(queryCtx as never)

    expect(result.user.email).toBe('admin@dev.local')
    expect(result.identity.subject).toBe('dev_admin_001')
    expect(result.profile.role).toBe('ADMIN')
  })
})

// ============================================================================
// TEST SUITE: company creation requires an explicit seed
// ============================================================================

describe('dev auth does not seed company data', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    resetIdCounter()
    ctx = createMockConvexCtx()
    setDevBypass(true)
  })

  afterEach(() => {
    Object.keys(process.env).forEach((k) => deleteEnv(k))
    Object.assign(process.env, originalEnv)
  })

  it('keeps companies empty when a company identity signs in', async () => {
    const userId = mockId('users')
    const profileId = mockId('profiles')
    const companyUser = createMockUser({
      _id: userId,
      email: 'company@dev.local',
      name: 'Test Company User',
      clerkId: 'dev_company_001',
      role: 'COMPANY',
    })
    const companyProfile = createMockProfile({
      _id: profileId,
      userId,
      role: 'COMPANY',
    })

    const emptyBuilder = createMockQueryBuilder([])
    const userBuilder = createMockQueryBuilder([companyUser])
    const profileBuilder = createMockQueryBuilder([companyProfile])
    const noCompanyBuilder = createMockQueryBuilder([])

    ctx.db.query
      .mockReturnValueOnce(emptyBuilder) // admin@dev.local
      .mockReturnValueOnce(userBuilder) // company@dev.local
      .mockReturnValueOnce(profileBuilder) // profiles
      .mockReturnValueOnce(noCompanyBuilder) // companies by ownerId

    await tryGetDevUser(ctx as never)

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('does not create entity when one already exists (idempotent)', async () => {
    const userId = mockId('users')
    const profileId = mockId('profiles')
    const companyUser = createMockUser({
      _id: userId,
      email: 'company@dev.local',
      name: 'Test Company User',
      clerkId: 'dev_company_001',
      role: 'COMPANY',
    })
    const companyProfile = createMockProfile({
      _id: profileId,
      userId,
      role: 'COMPANY',
    })
    const existingCompany = { _id: mockId('companies'), ownerId: profileId }

    const emptyBuilder = createMockQueryBuilder([])
    const userBuilder = createMockQueryBuilder([companyUser])
    const profileBuilder = createMockQueryBuilder([companyProfile])
    const companyBuilder = createMockQueryBuilder([existingCompany])

    ctx.db.query
      .mockReturnValueOnce(emptyBuilder) // admin@dev.local
      .mockReturnValueOnce(userBuilder) // company@dev.local
      .mockReturnValueOnce(profileBuilder) // profiles
      .mockReturnValueOnce(companyBuilder) // companies by ownerId — already exists

    await tryGetDevUser(ctx as never)

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })
})
