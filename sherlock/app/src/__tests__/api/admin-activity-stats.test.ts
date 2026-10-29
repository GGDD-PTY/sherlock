// ============================================================================
// Admin Activity Stats API Route Tests
// Tests for GET /api/admin/activity/stats endpoint
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
  throw new Error('fetchQuery must not be used for protected admin activity stats queries')
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
      getStats: 'activityLogs.getStats',
    },
  },
}))

// Import after mocks
import { GET } from '@/app/api/admin/activity/stats/route'

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(queryParams: Record<string, string> = {}): NextRequest {
  const params = new URLSearchParams(queryParams)
  const url = `http://localhost:3000/api/admin/activity/stats?${params}`
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

function createMockStats() {
  return {
    total: 150,
    byType: {
      LOGIN: 50,
      VIEW_DEAL: 40,
      CREATE_DEAL: 30,
      MESSAGE: 30,
    },
    byDay: {
      '2024-01-01': 20,
      '2024-01-02': 25,
      '2024-01-03': 30,
    },
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/admin/activity/stats', () => {
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
      const response = await GET(request)
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
      const response = await GET(request)
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
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No autorizado')
    })
  })

  // =========================================================================
  // SUCCESS
  // =========================================================================
  describe('Success', () => {
    it('should return stats with default days (7)', async () => {
      // ===== ARRANGE =====
      const mockStats = createMockStats()
      mockConvexQuery.mockResolvedValue(mockStats)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data.total).toBe(150)
      expect(data.byType).toBeDefined()
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 7,
      })
      expect(mockFetchQuery).not.toHaveBeenCalled()
    })

    it('should use custom days parameter', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: '30' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 30,
      })
    })

    it('should limit days to maximum of 365', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: '1000' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 365,
      })
    })

    it('should return 500 when an authenticated Convex client is unavailable', async () => {
      // ===== ARRANGE =====
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: null,
        isAuthenticated: false,
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('No se pudo verificar la sesión administrativa')
      expect(mockConvexQuery).not.toHaveBeenCalled()
      expect(mockFetchQuery).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // PARAMETER VALIDATION
  // =========================================================================
  describe('Parameter Validation', () => {
    it('should use default when days is invalid (NaN)', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: 'invalid' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 7,
      })
    })

    it('should use default when days is negative', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: '-5' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 7,
      })
    })

    it('should use default when days is zero', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: '0' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 7,
      })
    })

    it('should use default when days is a float', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue(createMockStats())

      // ===== ACT =====
      const request = createMockRequest({ days: '7.5' })
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      // parseInt will parse "7.5" as 7
      expect(mockConvexQuery).toHaveBeenCalledWith('activityLogs.getStats', {
        days: 7,
      })
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
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error al obtener estadísticas')

      errorSpy.mockRestore()
    })
  })
})
