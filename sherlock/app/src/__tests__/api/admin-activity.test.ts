// ============================================================================
// Admin Activity API Route Tests
// Tests for GET /api/admin/activity endpoint
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// MOCK SETUP
// ============================================================================

// Mock requireApiAuth from with-auth
const mockRequireApiAuth = vi.fn()
let adminStepUpFresh = true
vi.mock('@/lib/api/with-auth', async () => {
  const { createWithAuthAdminMock } = await import('../mocks/admin-api-auth')
  return createWithAuthAdminMock({
    requireApiAuth: () => mockRequireApiAuth(),
    hasRecentAdminStepUp: () => adminStepUpFresh,
  })
})

// Mock Convex auth bridge
const mockConvexQuery = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

// Guard against regressing to unauthenticated Convex server calls
const mockFetchQuery = vi.fn((..._args: unknown[]) => {
  throw new Error('fetchQuery must not be used for protected admin activity queries')
})
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
}))

// Mock rate limiter
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn().mockResolvedValue({
    success: true,
    remaining: 99,
    resetAt: new Date(),
    retryAfterSec: 0,
  }),
  createRateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
    }),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: {
    api: { windowMs: 60000, maxRequests: 100 },
  },
}))

// Mock Convex API
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    activityLogs: {
      getAll: 'activityLogs.getAll',
    },
  },
}))

// Import after mocks
import { GET } from '@/app/api/admin/activity/route'

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(queryParams: Record<string, string> = {}): NextRequest {
  const searchParams = new URLSearchParams(queryParams)
  const url = `http://localhost:3000/api/admin/activity?${searchParams.toString()}`
  return new NextRequest(url, { method: 'GET' })
}

interface MockUser {
  id: string
  profileId: string
  role: string
}

function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'user_123',
    profileId: 'profile_123',
    role: 'ADMIN',
    ...overrides,
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/admin/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adminStepUpFresh = true
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
      isAuthenticated: true,
    })
  })

  // =========================================================================
  // AUTHENTICATION & AUTHORIZATION
  // =========================================================================
  describe('Authentication & Authorization', () => {
    it('should return auth error when not authenticated', async () => {
      // ===== ARRANGE =====
      const authError = new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
      mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(401)
    })

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

    it('should return 403 when the admin step-up re-authentication expired', async () => {
      // ===== ARRANGE =====
      adminStepUpFresh = false
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser({ role: 'ADMIN' }),
        error: null,
      })

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.code).toBe('ADMIN_STEP_UP_REQUIRED')
      expect(mockConvexQuery).not.toHaveBeenCalled()
    })

    it('should allow admin to access endpoint', async () => {
      // ===== ARRANGE =====
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser({ role: 'ADMIN' }),
        error: null,
      })
      mockConvexQuery.mockResolvedValue([])

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
    })
  })

  // =========================================================================
  // VALIDATION
  // =========================================================================
  describe('Date Validation', () => {
    beforeEach(() => {
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser(),
        error: null,
      })
    })

    it('should return 400 for invalid startDate', async () => {
      // ===== ARRANGE =====
      const request = createMockRequest({ startDate: 'invalid-date' })

      // ===== ACT =====
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toContain('Fecha de inicio inválida')
    })

    it('should return 400 for invalid endDate', async () => {
      // ===== ARRANGE =====
      const request = createMockRequest({ endDate: 'not-a-date' })

      // ===== ACT =====
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toContain('Fecha de fin inválida')
    })

    it('should return 400 for invalid activityType filter', async () => {
      const request = createMockRequest({ activityType: 'page_view' })

      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('activityType inválido')
    })

    it('should accept valid ISO date format', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue([])
      const request = createMockRequest({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      })

      // ===== ACT =====
      const response = await GET(request)

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getAll',
        expect.objectContaining({
          startDate: expect.any(Number),
          endDate: expect.any(Number),
        })
      )
    })
  })

  // =========================================================================
  // SUCCESS
  // =========================================================================
  describe('Success', () => {
    beforeEach(() => {
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser(),
        error: null,
      })
    })

    it('should return formatted activity logs', async () => {
      // ===== ARRANGE =====
      const mockLogs = [
        {
          _id: 'log_123',
          userId: 'user_456',
          action: 'deal.view',
          entityId: 'deal_789',
          entityType: 'deal',
          metadata: { details: { page: '/my-company/documents' } },
          ipAddress: '127.0.0.1',
          userAgent: 'Mozilla/5.0',
          _creationTime: Date.now(),
        },
      ]
      mockConvexQuery.mockResolvedValue(mockLogs)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data).toHaveLength(1)
      expect(data[0].id).toBe('log_123')
      expect(data[0].user_id).toBe('user_456')
      expect(data[0].activity_type).toBe('deal.view')
      expect(data[0].metadata.resourceId).toBe('deal_789')
    })

    it('should pass limit parameter to query', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue([])
      const request = createMockRequest({ limit: '50' })

      // ===== ACT =====
      await GET(request)

      // ===== ASSERT =====
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getAll',
        expect.objectContaining({
          limit: 50,
        })
      )
      expect(mockFetchQuery).not.toHaveBeenCalled()
    })

    it('should pass activityType filter to query', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue([])
      const request = createMockRequest({ activityType: 'auth.login' })

      // ===== ACT =====
      await GET(request)

      // ===== ASSERT =====
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getAll',
        expect.objectContaining({
          activityType: 'auth.login',
        })
      )
    })

    it('should use default limit of 100', async () => {
      // ===== ARRANGE =====
      mockConvexQuery.mockResolvedValue([])
      const request = createMockRequest()

      // ===== ACT =====
      await GET(request)

      // ===== ASSERT =====
      expect(mockConvexQuery).toHaveBeenCalledWith(
        'activityLogs.getAll',
        expect.objectContaining({
          limit: 100,
        })
      )
    })

    it('should return 500 when an authenticated Convex client is unavailable', async () => {
      // ===== ARRANGE =====
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: null,
        isAuthenticated: false,
      })
      const request = createMockRequest()

      // ===== ACT =====
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
  // ERROR HANDLING
  // =========================================================================
  describe('Error Handling', () => {
    it('should return 500 on query error', async () => {
      // ===== ARRANGE =====
      mockRequireApiAuth.mockResolvedValue({
        user: createMockUser(),
        error: null,
      })
      mockConvexQuery.mockRejectedValue(new Error('Database error'))

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await GET(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error al obtener actividades')

      errorSpy.mockRestore()
    })
  })
})
