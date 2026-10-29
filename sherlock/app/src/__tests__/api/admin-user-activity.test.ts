// ============================================================================
// Admin User Activity API Route Tests
// Tests for GET /api/admin/activity/user/[userId] endpoint
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// MOCK SETUP
// ============================================================================

// Mock Convex auth bridge
const mockConvexQuery = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

// Guard against regressing to unauthenticated Convex server calls
const mockFetchQuery = vi.fn((..._args: unknown[]) => {
  throw new Error('fetchQuery must not be used for protected admin user activity queries')
})
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
}))

// Mock requireApiAuth
const mockRequireApiAuth = vi.fn()
let adminStepUpFresh = true
vi.mock('@/lib/api/with-auth', async () => {
  const { createWithAuthAdminMock } = await import('../mocks/admin-api-auth')
  return createWithAuthAdminMock({
    requireApiAuth: () => mockRequireApiAuth(),
    hasRecentAdminStepUp: () => adminStepUpFresh,
  })
})

// Mock rate limiting
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn().mockResolvedValue({
    success: true,
    remaining: 99,
    resetAt: new Date(),
    retryAfterSec: 0,
  }),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
  RATE_LIMIT_PRESETS: { api: { maxRequests: 100, windowMs: 60000 } },
}))

// Mock Convex API
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    activityLogs: {
      getByUserId: 'activityLogs.getByUserId',
    },
  },
}))

// Import after mocks
import { GET } from '@/app/api/admin/activity/user/[userId]/route'

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(queryParams: Record<string, string> = {}): NextRequest {
  const params = new URLSearchParams(queryParams)
  const url = `http://localhost:3000/api/admin/activity/user/profile_123?${params}`
  return new NextRequest(url, { method: 'GET' })
}

function createMockUser(overrides = {}) {
  return {
    id: 'user_123',
    profileId: 'profile_123',
    role: 'ADMIN',
    email: 'admin@example.com',
    ...overrides,
  }
}

function createMockActivityLogs() {
  return [
    {
      _id: 'log_1',
      userId: 'profile_456',
      action: 'LOGIN',
      entityId: null,
      entityType: null,
      metadata: { details: 'User logged in' },
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      _creationTime: Date.now() - 3600000,
    },
    {
      _id: 'log_2',
      userId: 'profile_456',
      action: 'VIEW_DEAL',
      entityId: 'deal_123',
      entityType: 'deals',
      metadata: { details: 'Viewed deal' },
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      _creationTime: Date.now() - 7200000,
    },
    {
      _id: 'log_3',
      userId: 'profile_456',
      action: 'CREATE_INTEREST',
      entityId: 'interest_123',
      entityType: 'dealInterests',
      metadata: { details: 'Expressed interest' },
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      _creationTime: Date.now() - 10800000,
    },
  ]
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/admin/activity/user/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adminStepUpFresh = true
    mockRequireApiAuth.mockResolvedValue({
      user: createMockUser(),
      error: null,
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
      isAuthenticated: true,
    })
  })

  // =========================================================================
  // AUTHENTICATION
  // =========================================================================
  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      // ===== ARRANGE =====
      mockRequireApiAuth.mockResolvedValue({
        user: null,
        error: new Response(JSON.stringify({ error: 'No autorizado' }), {
          status: 401,
        }),
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(401)
      expect(data.error).toBe('No autorizado')
    })
  })

  // =========================================================================
  // AUTHORIZATION
  // =========================================================================
  describe('Authorization', () => {
    it('should return 403 when user is not admin', async () => {
      // ===== ARRANGE =====
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser({ role: 'COMPANY' }),
        error: null,
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No autorizado')
    })

    it('should return 403 for INVESTOR role', async () => {
      // ===== ARRANGE =====
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser({ role: 'COMPANY' }),
        error: null,
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No autorizado')
    })
  })

  // =========================================================================
  // VALIDATION
  // =========================================================================
  describe('Validation', () => {
    it('should return 400 for invalid userId format (too short)', async () => {
      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'abc' }), // Too short
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('ID de usuario inválido')
    })

    it('should return 400 when userId is empty', async () => {
      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: '' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('ID de usuario inválido')
    })
  })

  // =========================================================================
  // SUCCESS
  // =========================================================================
  describe('Success', () => {
    it('should return user activity logs with default limit', async () => {
      // ===== ARRANGE =====
      const mockLogs = createMockActivityLogs()
      mockConvexQuery.mockResolvedValue(mockLogs)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBe(3)
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getByUserId',
        expect.objectContaining({ limit: 50 })
      )
      expect(mockFetchQuery).not.toHaveBeenCalled()
    })

    it('should use custom limit parameter', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockActivityLogs().slice(0, 1))

      // ===== ACT =====
      const request = createMockRequest({ limit: '10' })
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getByUserId',
        expect.objectContaining({ limit: 10 })
      )
    })

    it('should format activity logs correctly', async () => {
      // ===== ARRANGE =====
      const mockLogs = createMockActivityLogs()
      mockConvexQuery.mockResolvedValue(mockLogs)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data[0]).toHaveProperty('id')
      expect(data[0]).toHaveProperty('user_id')
      expect(data[0]).toHaveProperty('activity_type')
      expect(data[0]).toHaveProperty('metadata')
      expect(data[0]).toHaveProperty('created_at')
      expect(data[0].activity_type).toBe('LOGIN')
    })

    it('should return empty array when no logs found', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue([])

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data).toEqual([])
    })

    it('should return 500 when an authenticated Convex client is unavailable', async () => {
      // ===== ARRANGE =====
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: null,
        isAuthenticated: false,
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('No se pudo verificar la sesión administrativa')
      expect(mockConvexQuery).not.toHaveBeenCalled()
      expect(mockFetchQuery).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // ERROR HANDLING
  // =========================================================================
  describe('Error Handling', () => {
    it('should return 500 on database error', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockRejectedValue(new Error('Database error'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request, {
        params: Promise.resolve({ userId: 'profile_456_long_enough' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error al obtener actividades del usuario')

      errorSpy.mockRestore()
    })
  })
})
