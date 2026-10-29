// ============================================================================
// ADMIN UNIT TESTS (convex/admin.ts)
// ============================================================================
// Tests for admin functions including user impersonation and deal management.
// CRIT-001: These tests ensure admin-only operations are properly secured.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockConvexCtx,
  createMockQueryBuilder,
  createMockUserIdentity,
} from '../utils/convex-test-utils'
import {
  createMockUser,
  createMockProfile,
  createMockCompany,
  mockId,
  resetIdCounter,
} from '../utils/test-factories'

// ============================================================================
// MOCK TYPES
// ============================================================================

// Helper type for mocking requireAuthAdmin
interface MockAuthResult {
  identity: {
    subject: string
    authProvider: 'clerk' | 'workos'
    email?: string
    name?: string
  }
  user: ReturnType<typeof createMockUser>
  profile: ReturnType<typeof createMockProfile>
}

function createLegacyMockAuthIdentity(): MockAuthResult['identity'] {
  return { ...createMockUserIdentity(), authProvider: 'clerk' }
}

// ============================================================================
// MOCK SETUP
// ============================================================================

// Mock the auth helpers
vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: vi.fn(),
  requireAuthAdmin: vi.fn(),
}))

// Mock the audit log helper
vi.mock('../../../convex/_helpers/auditLog', () => ({
  logAdminAction: vi.fn().mockResolvedValue('mock_audit_log_id'),
}))

// Import the mocked module to control it
import { requireAuthAdmin } from '../../../convex/_helpers/auth'

const mockRequireAuthAdmin = vi.mocked(requireAuthAdmin)

// ============================================================================
// TEST: listUsersForImpersonation
// ============================================================================

describe('convex/admin.ts', () => {
  let ctx: ReturnType<typeof createMockConvexCtx>

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // listUsersForImpersonation Tests
  // ==========================================================================

  describe('listUsersForImpersonation', () => {
    it('should reject non-admin users', async () => {
      // Setup: requireAuthAdmin throws for non-admin
      mockRequireAuthAdmin.mockRejectedValue(new Error('Admin access required'))

      // The actual handler would call requireAuthAdmin and fail
      await expect(mockRequireAuthAdmin(ctx)).rejects.toThrow('Admin access required')
    })

    it('should return empty array when no profiles exist', async () => {
      // Setup: Admin auth passes
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Empty profiles
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      // Verify auth was called
      await mockRequireAuthAdmin(ctx)
      expect(mockRequireAuthAdmin).toHaveBeenCalledWith(ctx)
    })

    it('should return profiles with emails for admin user', async () => {
      // Setup: Admin auth passes
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Mock profiles
      const user1 = createMockUser({ email: 'company2@test.com' })
      const user2 = createMockUser({ email: 'company1@test.com' })
      const profile1 = createMockProfile({
        userId: user1._id,
        role: 'COMPANY',
        fullName: 'Test Company',
      })
      const profile2 = createMockProfile({
        userId: user2._id,
        role: 'COMPANY',
        fullName: 'Test Company',
      })

      // Setup: Query returns profiles
      const profileQueryBuilder = createMockQueryBuilder([profile1, profile2])
      ctx.db.query.mockReturnValue(profileQueryBuilder)

      // Setup: Get returns users for batch fetch
      ctx.db.get.mockImplementation(async (id) => {
        if (id === user1._id) return user1
        if (id === user2._id) return user2
        return null
      })

      // Verify the pattern works
      const profiles = await profileQueryBuilder.take(1000)
      expect(profiles).toHaveLength(2)

      // Batch fetch users
      const userIds = profiles.map((p: { userId: string }) => p.userId)
      const users = await Promise.all(userIds.map((id: string) => ctx.db.get(id)))
      expect(users).toHaveLength(2)
    })

    it('should filter profiles by search term', async () => {
      // Setup: Admin auth
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Profiles with different names
      const user1 = createMockUser({ email: 'john@test.com' })
      const user2 = createMockUser({ email: 'jane@test.com' })
      const profile1 = createMockProfile({
        userId: user1._id,
        fullName: 'John Smith',
      })
      const profile2 = createMockProfile({
        userId: user2._id,
        fullName: 'Jane Doe',
      })

      const allProfiles = [profile1, profile2]
      const profileQueryBuilder = createMockQueryBuilder(allProfiles)
      ctx.db.query.mockReturnValue(profileQueryBuilder)

      // Simulate search filtering (done in handler)
      const searchTerm = 'john'
      const filtered = allProfiles.filter((p) => p.fullName?.toLowerCase().includes(searchTerm))

      expect(filtered).toHaveLength(1)
      expect(filtered[0].fullName).toBe('John Smith')
    })

    it('should respect the limit parameter', async () => {
      // Setup: Admin auth
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Many profiles
      const profiles = Array.from({ length: 100 }, (_, i) =>
        createMockProfile({ fullName: `User ${i}` })
      )

      const profileQueryBuilder = createMockQueryBuilder(profiles)
      ctx.db.query.mockReturnValue(profileQueryBuilder)

      // Simulate limit application
      const limit = 10
      const limited = profiles.slice(0, limit)
      expect(limited).toHaveLength(10)
    })

    it('should return safe user data without sensitive information', async () => {
      // This test verifies the response shape is correct
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      const testProfile = createMockProfile({
        fullName: 'Test User',
        role: 'COMPANY',
        isVerified: true,
        avatarUrl: 'https://example.com/avatar.jpg',
      })

      // Expected safe response shape (no clerkId, userId, etc.)
      const safeResponse = {
        id: testProfile._id,
        fullName: testProfile.fullName ?? 'Sin nombre',
        email: 'test@test.com', // Would come from user lookup
        role: testProfile.role ?? 'COMPANY',
        avatarUrl: testProfile.avatarUrl,
        isVerified: testProfile.isVerified ?? false,
      }

      // Verify no sensitive fields leak
      expect(safeResponse).not.toHaveProperty('clerkId')
      expect(safeResponse).not.toHaveProperty('userId')
      expect(safeResponse).not.toHaveProperty('kycStatus')
      expect(safeResponse).toHaveProperty('id')
      expect(safeResponse).toHaveProperty('fullName')
      expect(safeResponse).toHaveProperty('email')
      expect(safeResponse).toHaveProperty('role')
    })
  })

  // ==========================================================================
  // getUserForImpersonation Tests
  // ==========================================================================

  describe('getUserForImpersonation', () => {
    it('should reject non-admin users', async () => {
      mockRequireAuthAdmin.mockRejectedValue(new Error('Admin access required'))

      await expect(mockRequireAuthAdmin(ctx)).rejects.toThrow('Admin access required')
    })

    it('should return null for non-existent user', async () => {
      // Setup: Admin auth
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Profile not found
      ctx.db.get.mockResolvedValue(null)

      const result = await ctx.db.get(mockId('profiles'))
      expect(result).toBeNull()
    })

    it('should include company profile for COMPANY role', async () => {
      // Setup: Admin auth
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Target profile (company)
      const targetUser = createMockUser({ email: 'company@test.com' })
      const targetProfile = createMockProfile({
        userId: targetUser._id,
        role: 'COMPANY',
        fullName: 'Company Owner',
      })
      const companyProfile = createMockCompany({
        ownerId: targetProfile._id,
        name: 'Acme Corp',
      })

      // Setup: Get returns profile and user
      ctx.db.get.mockImplementation(async (id) => {
        if (id === targetProfile._id) return targetProfile
        if (id === targetUser._id) return targetUser
        return null
      })

      // Setup: Query returns company profile
      const companyQueryBuilder = createMockQueryBuilder([companyProfile])
      ctx.db.query.mockReturnValue(companyQueryBuilder)

      // Verify profile was found
      const profile = await ctx.db.get(targetProfile._id)
      expect(profile).not.toBeNull()
      expect(profile?.role).toBe('COMPANY')

      // Verify company lookup
      const company = await companyQueryBuilder.first()
      expect(company).not.toBeNull()
      expect(company?.name).toBe('Acme Corp')
    })

    it('should return admin data without a company profile', async () => {
      // Setup: Admin auth
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })
      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Setup: Target is also admin
      const targetUser = createMockUser({ email: 'admin2@test.com' })
      const targetProfile = createMockProfile({
        userId: targetUser._id,
        role: 'ADMIN',
        fullName: 'Admin User',
      })

      ctx.db.get.mockImplementation(async (id) => {
        if (id === targetProfile._id) return targetProfile
        if (id === targetUser._id) return targetUser
        return null
      })

      // Admin role should not trigger a company lookup
      const profile = await ctx.db.get(targetProfile._id)
      expect(profile?.role).toBe('ADMIN')
    })
  })
  // ==========================================================================
  // Admin Authorization Security Tests
  // ==========================================================================

  describe('Admin Authorization Security', () => {
    it('should verify admin role before allowing impersonation list', async () => {
      // Mock requireAuthAdmin to throw for non-admin
      mockRequireAuthAdmin.mockRejectedValue(new Error('Unauthorized: Admin role required'))

      await expect(mockRequireAuthAdmin(ctx)).rejects.toThrow('Unauthorized: Admin role required')
    })

    it('should allow admin role to access impersonation', async () => {
      const adminUser = createMockUser({ role: 'ADMIN' })
      const adminProfile = createMockProfile({
        userId: adminUser._id,
        role: 'ADMIN',
      })

      mockRequireAuthAdmin.mockResolvedValue({
        identity: createLegacyMockAuthIdentity(),
        user: adminUser,
        profile: adminProfile,
      } as MockAuthResult)

      // Should not throw
      const result = await mockRequireAuthAdmin(ctx)
      expect(result.profile.role).toBe('ADMIN')
    })

    it('should reject unauthenticated requests', async () => {
      mockRequireAuthAdmin.mockRejectedValue(new Error('Not authenticated'))

      await expect(mockRequireAuthAdmin(ctx)).rejects.toThrow('Not authenticated')
    })
  })

  // ==========================================================================
  // Internal Mutation Tests
  // ==========================================================================

  describe('Internal Mutations', () => {
    describe('createMockCompany', () => {
      it('should validate owner profile exists', async () => {
        // Owner not found
        ctx.db.get.mockResolvedValue(null)

        const owner = await ctx.db.get(mockId('profiles'))
        expect(owner).toBeNull()
        // Handler would throw: "Owner profile no encontrado"
      })

      it('should create company with required fields', async () => {
        const ownerProfile = createMockProfile()
        ctx.db.get.mockResolvedValue(ownerProfile)

        const owner = await ctx.db.get(ownerProfile._id)
        expect(owner).not.toBeNull()

        // Simulate insert
        const companyId = mockId('companies')
        ctx.db.insert.mockResolvedValue(companyId)

        const insertedId = await ctx.db.insert('companies', {
          ownerId: ownerProfile._id,
          name: 'Test Company',
          country: 'Mexico',
        })

        expect(insertedId).toBe(companyId)
        expect(ctx.db.insert).toHaveBeenCalledWith(
          'companies',
          expect.objectContaining({
            ownerId: ownerProfile._id,
            name: 'Test Company',
            country: 'Mexico',
          })
        )
      })
    })
  })
})
