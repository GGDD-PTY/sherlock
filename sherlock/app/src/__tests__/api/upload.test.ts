// ============================================================================
// Upload API Route Tests
// Tests for POST /api/upload endpoint
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// MOCK SETUP
// ============================================================================

const originalFetch = global.fetch

const mockDevAuthState = vi.hoisted(() => ({ enabled: false }))
const mockConvexMutation = vi.hoisted(() => vi.fn())
const mockConvexAction = vi.hoisted(() => vi.fn())
const mockGetAuthenticatedConvex = vi.hoisted(() => vi.fn())

// Mock requireApiAuth from with-auth
const mockRequireApiAuth = vi.fn()
vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuth: () => mockRequireApiAuth(),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

vi.mock('@/lib/dev-auth/config', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuthState.enabled
  },
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      issueAssetUploadIntent: 'documents.issueAssetUploadIntent',
      resolveAssetUpload: 'documents.resolveAssetUpload',
    },
  },
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
    upload: { windowMs: 300000, maxRequests: 20 },
  },
}))

// Import after mocks
import { POST } from '@/app/api/upload/route'
// Import the real validateFile function and StorageBucket type for testing
import { VALID_BUCKETS, validateFile, type StorageBucket } from '@/lib/storage'
import { GENERIC_UPLOAD_BUCKETS } from '@/lib/storage/generic-upload-buckets'

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Helper to create a NextRequest for testing the upload endpoint.
 * Creates a FormData-like request with optional file, bucket, and subfolder.
 */
function createMockRequest(options?: {
  method?: string
  bucket?: string
  subfolder?: string
}): NextRequest {
  const url = 'http://localhost:3000/api/upload'
  const method = options?.method ?? 'POST'

  // We'll need to mock FormData for testing since Node.js test env doesn't support it well
  const init: {
    method: string
    body?: string
  } = { method }

  return new NextRequest(url, init)
}

function createUploadRequest(file: File, bucket: string): NextRequest {
  const formData = new FormData()
  formData.set('file', file)
  formData.set('bucket', bucket)

  return {
    formData: async () => formData,
    // El route valida Origin (CSRF) antes de leer el form; sin headers el
    // helper de CSRF reventaría con 500 en vez de ejercitar la validación.
    headers: new Headers(),
  } as unknown as NextRequest
}

interface MockUser {
  id: string
  profileId: string
  email: string
}

function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'user_123',
    profileId: 'profile_123',
    email: 'test@example.com',
    ...overrides,
  }
}

afterEach(() => {
  global.fetch = originalFetch
  mockDevAuthState.enabled = false
  mockGetAuthenticatedConvex.mockReset()
  mockConvexMutation.mockReset()
  mockConvexAction.mockReset()
  delete process.env.NEXT_PUBLIC_CONVEX_URL
})

// ============================================================================
// TESTS: Upload Route - Bucket Validation
// ============================================================================

describe('POST /api/upload - Bucket Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =========================================================================
  // BUCKET VALIDATION (USING EXPORTED CONSTANT)
  // =========================================================================
  it('should define VALID_BUCKETS constant with all valid buckets', () => {
    expect(VALID_BUCKETS).toBeDefined()
    expect(VALID_BUCKETS.includes('avatars')).toBe(true)
    expect(VALID_BUCKETS.includes('logos')).toBe(true)
  })

  it('keeps confidential files out of the generic upload route', () => {
    expect(GENERIC_UPLOAD_BUCKETS).toEqual(['avatars', 'logos'])
    expect(GENERIC_UPLOAD_BUCKETS).not.toContain('documents')
    expect(GENERIC_UPLOAD_BUCKETS).not.toContain('analyses')
  })

  it('should reject invalid buckets using VALID_BUCKETS', () => {
    // Verify that invalid buckets are not in the list
    const invalidBuckets = ['photos', 'files', 'uploads', 'temp']
    invalidBuckets.forEach((bucket) => {
      expect(VALID_BUCKETS.includes(bucket as StorageBucket)).toBe(false)
    })
  })
})

// ============================================================================
// TESTS: Upload Route - File Validation (using real validateFile)
// ============================================================================

describe('POST /api/upload - File Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =========================================================================
  // FILE TYPE VALIDATION (REAL FUNCTION)
  // =========================================================================
  it('should validate file types using real validateFile function', () => {
    // Create a mock File object and test with real validation
    const mockFile = new File(['test'], 'test.jpg', { type: 'image/jpeg' })

    // Call the real validateFile function
    const result = validateFile(mockFile, 'avatars')

    // Verify structure of validation result
    expect(result).toHaveProperty('valid')
    expect(typeof result.valid).toBe('boolean')
  })

  it('should handle invalid file types with real validateFile', () => {
    // Test with a potentially invalid file type
    const mockFile = new File(['test'], 'test.exe', {
      type: 'application/x-executable',
    })

    const result = validateFile(mockFile, 'avatars')

    // Executable files should be rejected
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('should accept image files for avatars bucket', () => {
    // Test real validation for images in avatars bucket
    const mockFile = new File(['test'], 'avatar.png', { type: 'image/png' })

    const result = validateFile(mockFile, 'avatars')

    // PNG images should be valid for avatars
    expect(result.valid).toBe(true)
  })

  it('should reject SVG files for user-uploaded logos', () => {
    const mockFile = new File(['<svg />'], 'logo.svg', { type: 'image/svg+xml' })

    const result = validateFile(mockFile, 'logos')

    expect(result.valid).toBe(false)
    expect(result.error).toContain('image/jpeg')
    expect(result.error).not.toContain('image/svg+xml')
  })

  it('keeps document validation separate from the generic public upload route', () => {
    expect(GENERIC_UPLOAD_BUCKETS).not.toContain('documents')
  })

  it('rejects SVG logos at the upload route boundary', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createMockUser(),
      error: null,
    })

    const request = createUploadRequest(
      new File(['<svg><script>alert(1)</script></svg>'], 'logo.svg', {
        type: 'image/svg+xml',
      }),
      'logos'
    )
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toContain('Tipo de archivo no permitido')
    expect(body.error).not.toContain('image/svg+xml')
  })

  it('rejects confidential document buckets at the upload route boundary', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createMockUser(),
      error: null,
    })

    const request = createUploadRequest(
      new File(['%PDF-1.4'], 'deck.pdf', {
        type: 'application/pdf',
      }),
      'documents'
    )
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toContain('/api/documents/upload')
  })
})

// ============================================================================
// TESTS: Upload Route - Authentication
// ============================================================================

describe('POST /api/upload - Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =========================================================================
  // REAL AUTHENTICATION TEST (NOT JUST CHECKING IF MOCK EXISTS)
  // =========================================================================
  it('should return 401 when user is not authenticated', async () => {
    // Setup: Mock authentication to fail
    const authError = new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401,
    })
    mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

    // Act: Create a request and call POST
    const request = createMockRequest({ method: 'POST' })
    const response = await POST(request)

    // Assert: Response should be 401
    expect(response.status).toBe(401)
  })

  it('should reject upload if requireApiAuth returns error', async () => {
    // Setup: Mock requireApiAuth to return an error
    const authError = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    })
    mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

    // Act: Call POST handler
    const request = createMockRequest({ method: 'POST' })
    const response = await POST(request)

    // Assert: Should return the auth error directly
    expect(response.status).toBe(401)
    expect(mockRequireApiAuth).toHaveBeenCalled()
  })
})

// ============================================================================
// TESTS: Upload Route - Convex Storage Flow
// ============================================================================

describe('POST /api/upload - Convex Storage Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://test.convex.cloud'
    mockRequireApiAuth.mockResolvedValue({
      user: createMockUser(),
      error: null,
    })
  })

  it('uploads public assets through an authenticated Convex client', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: mockConvexMutation, action: mockConvexAction },
      isAuthenticated: true,
      token: 'convex-token',
    })
    mockConvexMutation.mockResolvedValueOnce({
      intentId: 'asset_intent_123',
      uploadUrl: 'https://upload.convex.test',
      expiresAt: Date.now() + 60_000,
    })
    mockConvexAction.mockResolvedValueOnce({
      resolved: true,
      url: 'https://files.convex.cloud/storage_123',
    })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: 'storage_123' }),
    } as Response)

    const response = await POST(
      createUploadRequest(new File(['logo'], 'logo.png', { type: 'image/png' }), 'logos')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      url: 'https://files.convex.cloud/storage_123',
      size: 4,
      requestId: expect.any(String),
    })
    expect(mockConvexMutation).toHaveBeenCalledWith('documents.issueAssetUploadIntent', {
      purpose: 'LOGO',
      declaredMimeType: 'image/png',
      declaredByteSize: 4,
      declaredSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(mockConvexAction).toHaveBeenCalledWith('documents.resolveAssetUpload', {
      intentId: 'asset_intent_123',
      storageId: 'storage_123',
    })
    expect(global.fetch).toHaveBeenCalledWith('https://upload.convex.test', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: expect.any(File),
    })
  })

  it('never returns a URL or storage locator when asset inspection rejects the blob', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: mockConvexMutation, action: mockConvexAction },
      isAuthenticated: true,
      token: 'convex-token',
    })
    mockConvexMutation.mockResolvedValueOnce({
      intentId: 'asset_intent_rejected',
      uploadUrl: 'https://upload.convex.test',
      expiresAt: Date.now() + 60_000,
    })
    mockConvexAction.mockResolvedValueOnce({
      resolved: false,
      code: 'ASSET_UPLOAD_REJECTED',
    })
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: 'storage_quarantined' }),
    } as Response)

    const response = await POST(
      createUploadRequest(new File(['logo'], 'logo.png', { type: 'image/png' }), 'logos')
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({
      error: 'El archivo no superó las verificaciones de seguridad',
      requestId: expect.any(String),
    })
    expect(JSON.stringify(body)).not.toContain('storage_quarantined')
    expect(JSON.stringify(body)).not.toContain('asset_intent_rejected')
  })

  it('keeps demo-auth logo uploads usable without calling protected Convex storage', async () => {
    mockDevAuthState.enabled = true
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: mockConvexMutation, action: mockConvexAction },
      isAuthenticated: false,
      token: null,
    })

    const response = await POST(
      createUploadRequest(new File(['demo-logo'], 'logo.png', { type: 'image/png' }), 'logos')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.demo).toBe(true)
    expect(body.url).toMatch(/^data:image\/png;base64,/)
    expect(body).not.toHaveProperty('storageId')
    expect(body.size).toBe(9)
    expect(mockConvexMutation).not.toHaveBeenCalled()
    expect(mockConvexAction).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
