// ============================================================================
// Documents [id] API Route Tests
// Tests for DELETE /api/documents/[id] endpoint
// ============================================================================

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ============================================================================
// MOCK SETUP
// ============================================================================

// Mock the API authorization boundary used by the route.
const mockRequireApiAuth = vi.fn()
const mockRequireAdminApiAuth = vi.fn()
vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuth: () => mockRequireApiAuth(),
  requireAdminApiAuth: () => mockRequireAdminApiAuth(),
}))

const mockIssueAdminVdrCapability = vi.fn()
vi.mock('@/lib/auth/admin-vdr-capability-server', () => ({
  issueAdminVdrCapability: (...args: unknown[]) => mockIssueAdminVdrCapability(...args),
}))

// Mock Convex
const mockFetchQuery = vi.fn()
const mockFetchMutation = vi.fn()
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
  fetchMutation: (...args: unknown[]) => mockFetchMutation(...args),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () =>
    Promise.resolve({
      client: {
        query: (...args: unknown[]) => mockFetchQuery(...args),
        mutation: (...args: unknown[]) => mockFetchMutation(...args),
      },
      token: 'test-token',
      isAuthenticated: true,
    }),
}))

vi.mock('@/lib/dev-auth/config', () => ({
  DEV_AUTH_ENABLED: false,
}))

// Mock isValidConvexId
const mockIsValidConvexId = vi.fn()
vi.mock('@/lib/validations', () => ({
  isValidConvexId: (id: string) => mockIsValidConvexId(id),
  toConvexId: (id: string) => id,
}))

// Mock rate limiting
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi
    .fn()
    .mockResolvedValue({ success: true, remaining: 99, resetAt: new Date(), retryAfterSec: 0 }),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
  RATE_LIMIT_PRESETS: { api: { maxRequests: 100, windowMs: 60000 } },
}))

// Import after mocks
import { DELETE } from '@/app/api/documents/[id]/route'

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(
  origin: string | null = 'http://localhost:3000',
  url = 'http://localhost:3000/api/documents/doc_123'
): NextRequest {
  const headers: Record<string, string> = {}
  if (origin) headers.origin = origin
  return new NextRequest(url, {
    method: 'DELETE',
    headers,
  })
}

function createMockUser(overrides = {}) {
  return {
    id: 'user_123',
    profileId: 'profile_123',
    role: 'COMPANY',
    email: 'test@example.com',
    name: null,
    sessionId: null,
    ...overrides,
  }
}

function setAuthenticatedUser(user: ReturnType<typeof createMockUser> | null) {
  if (!user) {
    mockRequireApiAuth.mockResolvedValue({
      user: null,
      error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }),
    })
    return
  }

  const result = { user, error: null }
  mockRequireApiAuth.mockResolvedValue(result)
  mockRequireAdminApiAuth.mockResolvedValue(result)
}

function createMockDocument(overrides = {}) {
  return {
    _id: 'doc_123',
    name: 'Financial Report.pdf',
    companyId: 'company_123',
    storageId: 'storage_123',
    fileType: 'application/pdf',
    fileSize: 1024000,
    accessLevel: 'NDA_REQUIRED',
    ...overrides,
  }
}

function createMockCompany(overrides = {}) {
  return {
    _id: 'company_123',
    name: 'Test Company',
    ownerId: 'profile_123',
    ...overrides,
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('DELETE /api/documents/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    mockIsValidConvexId.mockReturnValue(true)
    setAuthenticatedUser(createMockUser())
    mockIssueAdminVdrCapability.mockResolvedValue({
      capability: `avc_${'a'.repeat(43)}`,
      expiresAt: Date.now() + 60_000,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('Exact same-origin bearer boundary', () => {
    it('allows the exact production canonical host and Origin through to authentication', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sherlock.capital')
      mockIsValidConvexId.mockReturnValue(false)

      const response = await DELETE(
        createMockRequest(
          'https://sherlock.capital',
          'https://sherlock.capital/api/documents/doc_123'
        ),
        { params: Promise.resolve({ id: 'doc_123' }) }
      )

      expect(response.status).toBe(400)
      expect(mockRequireApiAuth).toHaveBeenCalledTimes(1)
    })

    it.each([
      'https://www.sherlock.capital',
      'https://dev.sherlock.capital',
      'http://localhost:3000',
    ])('rejects non-canonical production Origin %s before auth or issuance', async (origin) => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sherlock.capital')

      const response = await DELETE(
        createMockRequest(origin, 'https://sherlock.capital/api/documents/doc_123'),
        { params: Promise.resolve({ id: 'doc_123' }) }
      )

      expect(response.status).toBe(403)
      expect(mockRequireApiAuth).not.toHaveBeenCalled()
      expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
      expect(mockFetchMutation).not.toHaveBeenCalled()
    })

    it('rejects a missing Origin before auth or issuance', async () => {
      const response = await DELETE(createMockRequest(null), {
        params: Promise.resolve({ id: 'doc_123' }),
      })

      expect(response.status).toBe(403)
      expect(mockRequireApiAuth).not.toHaveBeenCalled()
      expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
    })

    it('rejects matching spoofed Host, forwarded Host, and Origin', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sherlock.capital')
      const request = createMockRequest(
        'https://attacker.example',
        'https://attacker.example/api/documents/doc_123'
      )
      request.headers.set('host', 'attacker.example')
      request.headers.set('x-forwarded-host', 'attacker.example')

      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })

      expect(response.status).toBe(403)
      expect(mockRequireApiAuth).not.toHaveBeenCalled()
      expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
      expect(mockFetchMutation).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // AUTHENTICATION
  // =========================================================================
  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      // ===== ARRANGE =====
      setAuthenticatedUser(null)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
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
    it('should return 403 when the role is not COMPANY ni ADMIN', async () => {
      // ===== ARRANGE =====
      setAuthenticatedUser(createMockUser({ role: undefined }))

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('Prohibido')
    })

    it("should return 403 when COMPANY user doesn't own document", async () => {
      // ===== ARRANGE =====
      const mockDocument = createMockDocument({
        companyId: 'other_company_456',
      })
      const mockCompany = createMockCompany({ _id: 'company_123' })
      mockFetchQuery
        .mockResolvedValueOnce(mockDocument) // getDocument
        .mockResolvedValueOnce(mockCompany) // getCompanyByOwner

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No tienes permiso para eliminar este documento')
    })

    it('should allow COMPANY owner to delete their document', async () => {
      // ===== ARRANGE =====
      const mockDocument = createMockDocument({ companyId: 'company_123' })
      const mockCompany = createMockCompany({ _id: 'company_123' })
      mockFetchQuery
        .mockResolvedValueOnce(mockDocument) // getDocument
        .mockResolvedValueOnce(mockCompany) // getCompanyByOwner
      mockFetchMutation.mockResolvedValue(undefined)

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.message).toBe('Documento eliminado')

      logSpy.mockRestore()
    })

    it('should allow ADMIN to delete any document', async () => {
      // ===== ARRANGE =====
      setAuthenticatedUser(createMockUser({ role: 'ADMIN', sessionId: 'session_admin_123' }))
      const mockDocument = createMockDocument({ companyId: 'any_company' })
      mockFetchQuery.mockResolvedValueOnce(mockDocument)
      mockFetchMutation.mockResolvedValue(undefined)

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      // Admin should not need to check company ownership
      expect(mockFetchQuery).toHaveBeenCalledTimes(1)
      expect(mockIssueAdminVdrCapability).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_ARCHIVE',
          companyId: 'any_company',
          input: { documentId: 'doc_123' },
          target: 'DOCUMENT:doc_123',
        })
      )
      expect(mockFetchMutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          documentId: 'doc_123',
          adminCapability: `avc_${'a'.repeat(43)}`,
        })
      )

      logSpy.mockRestore()
    })
  })

  // =========================================================================
  // VALIDATION
  // =========================================================================
  describe('Validation', () => {
    it('should return 400 for invalid document ID', async () => {
      // ===== ARRANGE =====
      mockIsValidConvexId.mockReturnValue(false)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'invalid-id' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('ID inválido')
    })

    it('should return 404 when document not found', async () => {
      // ===== ARRANGE =====
      mockFetchQuery.mockResolvedValueOnce(null)

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'nonexistent_doc' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(404)
      expect(data.error).toBe('Documento no encontrado')
    })
  })

  // =========================================================================
  // ERROR HANDLING
  // =========================================================================
  describe('Error Handling', () => {
    it('should return 500 on database error', async () => {
      // ===== ARRANGE =====
      mockFetchQuery.mockRejectedValue(new Error('Database error'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error interno')

      errorSpy.mockRestore()
    })

    it('should return 500 when delete mutation fails', async () => {
      // ===== ARRANGE =====
      setAuthenticatedUser(createMockUser({ role: 'ADMIN', sessionId: 'session_admin_123' }))
      mockFetchQuery.mockResolvedValueOnce(createMockDocument())
      mockFetchMutation.mockRejectedValue(new Error('Delete failed'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // ===== ACT =====
      const request = createMockRequest()
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'doc_123' }),
      })
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error interno')

      errorSpy.mockRestore()
    })
  })
})
