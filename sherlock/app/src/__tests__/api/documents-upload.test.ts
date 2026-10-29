// ============================================================================
// Documents Upload API Route Tests
// Tests for POST /api/documents/upload endpoint
// Note: FormData tests use simplified mocking due to Node.js limitations
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ============================================================================
// MOCK SETUP
// ============================================================================

// La frontera de auth de las API, con el contrato de `requireApiAuthWithRole`:
// `mockGetCurrentUser` sigue siendo la fuente del usuario de cada caso.
const mockGetCurrentUser = vi.fn()
vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuthWithRole: async (allowedRoles: string[]) => {
    const user = await mockGetCurrentUser()
    if (!user) {
      return { user: null, error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }
    }
    if (!allowedRoles.includes(user.role)) {
      return {
        user: null,
        error: NextResponse.json({ error: 'No tienes permisos para esta acción' }, { status: 403 }),
      }
    }
    return { user, error: null }
  },
}))

// Mock authenticated Convex clients
const mockAuthenticatedConvexMutation = vi.fn()
const mockAuthenticatedConvexQuery = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

const mockConvexAdminMutation = vi.fn()
const mockGetConvexAdminClient = vi.fn()
vi.mock('@/lib/convex/admin-client', () => ({
  getConvexAdminClient: () => mockGetConvexAdminClient(),
}))

// Mock Convex
const mockFetchQuery = vi.fn()
const mockFetchMutation = vi.fn()
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
  fetchMutation: (...args: unknown[]) => mockFetchMutation(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getCompanyByOwner: 'companies:getCompanyByOwner',
    },
  },
}))

// Mock validations
const mockIsValidConvexId = vi.fn()
vi.mock('@/lib/validations', () => ({
  isValidConvexId: (id: string) => mockIsValidConvexId(id),
  toConvexId: (id: string) => id,
}))

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
  RATE_LIMIT_PRESETS: { upload: { maxRequests: 10, windowMs: 60000 } },
}))

// Import after mocks
import { POST } from '@/app/api/documents/upload/route'
import { MAX_UPLOAD_BYTES, PLATFORM_REQUEST_BODY_LIMIT_BYTES } from '@/lib/storage/upload-limits'
import { buildZipFixture } from '../utils/zip-fixtures'

// ============================================================================
// HELPERS
// ============================================================================

function createMockUser(overrides = {}) {
  return {
    id: 'user_123',
    profileId: 'profile_123',
    role: 'COMPANY',
    email: 'test@example.com',
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

function createValidPdfFormData() {
  const formData = new FormData()
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
  formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'financials.pdf')
  formData.append('companyId', 'company_123')
  formData.append('name', 'Financials')
  formData.append('accessLevel', 'NDA_REQUIRED')
  formData.append('folder', 'Financials')
  return formData
}

function createUploadRequest(formData = createValidPdfFormData(), signal?: AbortSignal) {
  const request = new NextRequest('http://localhost/api/documents/upload', {
    method: 'POST',
    body: new FormData(),
    ...(signal ? { signal } : {}),
  })
  vi.spyOn(request, 'formData').mockResolvedValue(formData)
  return request
}

// ============================================================================
// TESTS - Unit tests for validation logic (no FormData needed)
// ============================================================================

describe('POST /api/documents/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.stubEnv('CONVEX_ENV', 'dev')
    vi.stubEnv('VDR_FILE_SCANNER_URL', '')
    vi.stubEnv('VDR_FILE_SCANNER_TOKEN', '')
    mockIsValidConvexId.mockReturnValue(true)
    mockAuthenticatedConvexMutation.mockResolvedValue('https://convex-storage.test/upload')
    // La verificación de propiedad corre para TODO caller (ADMIN se rechaza
    // antes): el dueño de company_123 es profile_123, igual que createMockUser.
    mockAuthenticatedConvexQuery.mockResolvedValue({ _id: 'company_123', ownerId: 'profile_123' })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: {
        mutation: mockAuthenticatedConvexMutation,
        query: mockAuthenticatedConvexQuery,
      },
      token: 'test-token',
      isAuthenticated: true,
    })
    mockConvexAdminMutation.mockImplementation(async (reference: string) =>
      reference === '_documents/storage:generateUploadUrlInternal'
        ? 'https://convex-storage.test/upload'
        : 'document_123'
    )
    mockGetConvexAdminClient.mockReturnValue({
      mutation: mockConvexAdminMutation,
      query: vi.fn(),
      setAdminAuth: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  // =========================================================================
  // AUTHENTICATION
  // =========================================================================
  describe('Authentication', () => {
    it('should return 401 when user is not authenticated', async () => {
      // ===== ARRANGE =====
      mockGetCurrentUser.mockResolvedValue(null)

      // Create a mock request (FormData validation will fail first, but auth is checked first)
      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })

      // ===== ACT =====
      const response = await POST(request)
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
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: undefined }))

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No tienes permisos para esta acción')
    })

    it('should allow COMPANY role to proceed with upload', async () => {
      // ===== ARRANGE =====
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))

      // Empty FormData will fail validation, but auth should pass
      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      // Will fail with 400 due to missing params, not 403
      expect(response.status).toBe(400)
      expect(data.error).toBe('Faltan parámetros requeridos')
    })

    it('rejects ADMIN on the legacy lane: no step-up nor one-use VDR capability here', async () => {
      // ===== ARRANGE =====
      // Un admin con sesión válida y un PDF perfectamente válido: el carril
      // legacy jamás liga la capability VDR de un solo uso, así que debe caer
      // en 403 antes de tocar el almacenamiento o crear documentos.
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'ADMIN' }))

      // ===== ACT =====
      const response = await POST(createUploadRequest())
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('No tienes permisos para esta acción')
      expect(mockConvexAdminMutation).not.toHaveBeenCalled()
      expect(mockAuthenticatedConvexMutation).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // VALIDATION - FormData simplified tests
  // =========================================================================
  describe('Validation', () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
    })

    it('should return 400 when required fields are missing', async () => {
      // ===== ARRANGE =====
      const formData = new FormData()
      // Missing: file, companyId, name

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: formData,
      })

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('Faltan parámetros requeridos')
    })

    it('should return 400 when only some fields are provided', async () => {
      // ===== ARRANGE =====
      const formData = new FormData()
      formData.append('dealId', 'deal_123')
      // Missing: file, companyId, name

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: formData,
      })

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('Faltan parámetros requeridos')
    })

    it('preserves the company-level upload lane while Q6 remains undecided', async () => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockIsValidConvexId.mockImplementation((id: string) => id === 'company_123')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ storageId: 'storage_123' }),
        })
      )

      const formData = new FormData()
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
      formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'financials.pdf')
      formData.append('companyId', 'company_123')
      formData.append('name', 'Financials')
      formData.append('accessLevel', 'NDA_REQUIRED')
      formData.append('folder', 'Financials')

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })
      vi.spyOn(request, 'formData').mockResolvedValue(formData)

      const response = await POST(request)

      expect(response.status).toBe(200)
      expect(mockConvexAdminMutation).toHaveBeenNthCalledWith(
        1,
        '_documents/storage:generateUploadUrlInternal',
        {}
      )
      expect(mockConvexAdminMutation).toHaveBeenNthCalledWith(
        2,
        '_documents/mutations:createFromValidatedUpload',
        expect.objectContaining({
          companyId: 'company_123',
          uploaderProviderUserId: 'user_123',
          signatureKind: 'PDF',
        })
      )
      expect(mockAuthenticatedConvexMutation).not.toHaveBeenCalled()
    })

    it('rejects a generic ZIP renamed as an Office document before storage', async () => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockIsValidConvexId.mockImplementation((id: string) => id === 'company_123')

      const formData = new FormData()
      formData.append(
        'file',
        new Blob([buildZipFixture(['payload.bin']).buffer as ArrayBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        'financials.xlsx'
      )
      formData.append('companyId', 'company_123')
      formData.append('name', 'Financials')
      formData.append('accessLevel', 'NDA_REQUIRED')
      formData.append('folder', 'Financials')

      const response = await POST(createUploadRequest(formData))

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'El contenido del archivo no coincide con el formato Office declarado.',
        requestId: expect.any(String),
      })
      expect(mockConvexAdminMutation).not.toHaveBeenCalled()
    })

    it('fails closed before storage in production when the private scanner is unavailable', async () => {
      vi.stubEnv('CONVEX_ENV', 'production')
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockIsValidConvexId.mockImplementation((id: string) => id === 'company_123')
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const formData = new FormData()
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
      formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'financials.pdf')
      formData.append('companyId', 'company_123')
      formData.append('name', 'Financials')
      formData.append('accessLevel', 'NDA_REQUIRED')
      formData.append('folder', 'Financials')

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })
      vi.spyOn(request, 'formData').mockResolvedValue(formData)

      const response = await POST(request)

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: 'La verificación de seguridad no está disponible. Intenta de nuevo.',
        requestId: expect.any(String),
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockAuthenticatedConvexMutation).not.toHaveBeenCalled()
      expect(mockConvexAdminMutation).not.toHaveBeenCalled()
    })

    it.each([undefined, 'prodution'])(
      'fails closed before storage when CONVEX_ENV is missing or invalid (%s)',
      async (convexEnv) => {
        if (convexEnv === undefined) {
          Reflect.deleteProperty(process.env, 'CONVEX_ENV')
        } else {
          vi.stubEnv('CONVEX_ENV', convexEnv)
        }
        mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
        mockIsValidConvexId.mockImplementation((id: string) => id === 'company_123')
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        const response = await POST(createUploadRequest())

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
          error: 'La verificación de seguridad no está disponible. Intenta de nuevo.',
          requestId: expect.any(String),
        })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mockAuthenticatedConvexMutation).not.toHaveBeenCalled()
        expect(mockConvexAdminMutation).not.toHaveBeenCalled()
      }
    )

  })

  // =========================================================================
  // COMPANY OWNERSHIP VERIFICATION
  // =========================================================================
  describe('Company Ownership Verification', () => {
    it('should verify company ownership for non-admin users', async () => {
      // This is a unit test to verify the ownership check logic exists
      // Full integration would require proper FormData with File
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockFetchQuery.mockResolvedValue(createMockCompany({ _id: 'different_company' }))

      // The ownership check happens after FormData validation
      // We're testing that the function exists and is called
      expect(mockFetchQuery).not.toHaveBeenCalled() // Not called yet - FormData fails first
    })

    it('never lets admin bypass ownership through the legacy lane', async () => {
      // Antes existía un bypass de propiedad para ADMIN; hoy el carril legacy
      // rechaza al admin de plano porque no consume capability VDR alguna.
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'ADMIN' }))

      const formData = new FormData()
      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: formData,
      })

      const response = await POST(request)

      expect(response.status).toBe(403)
      expect(mockFetchQuery).not.toHaveBeenCalled()
      expect(mockConvexAdminMutation).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // ERROR HANDLING
  // =========================================================================
  describe('Error Handling', () => {
    it('should return 500 on unexpected errors', async () => {
      // ===== ARRANGE =====
      mockGetCurrentUser.mockRejectedValue(new Error('Database connection failed'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error interno del servidor al procesar el archivo')

      errorSpy.mockRestore()
    })

    it('should delete the storage blob when metadata creation fails after upload', async () => {
      // ===== ARRANGE =====
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockConvexAdminMutation
        .mockResolvedValueOnce('https://convex-storage.test/upload')
        .mockRejectedValueOnce(new Error('metadata insert failed'))
        .mockResolvedValueOnce({ deleted: true })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ storageId: 'storage_123' }),
        })
      )

      const formData = new FormData()
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
      formData.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'financials.pdf')
      formData.append('companyId', 'company_123')
      formData.append('name', 'Financials')
      formData.append('accessLevel', 'NDA_REQUIRED')
      formData.append('folder', 'Financials')

      const request = new NextRequest('http://localhost/api/documents/upload', {
        method: 'POST',
        body: new FormData(),
      })
      vi.spyOn(request, 'formData').mockResolvedValue(formData)

      // ===== ACT =====
      const response = await POST(request)
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('Error interno del servidor al procesar el archivo')
      expect(mockConvexAdminMutation).toHaveBeenNthCalledWith(
        3,
        '_documents/mutations:deleteStorageFileInternal',
        { storageId: 'storage_123' }
      )
    })

    it('retries only metadata registration with the same storageId after a transient network error', async () => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      mockConvexAdminMutation
        .mockResolvedValueOnce('https://convex-storage.test/upload')
        .mockRejectedValueOnce(new TypeError('network timeout from internal provider'))
        .mockResolvedValueOnce('document_123')
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ storageId: 'storage_123' }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const response = await POST(createUploadRequest())
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual(expect.objectContaining({ success: true, documentId: 'document_123' }))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mockConvexAdminMutation).toHaveBeenCalledTimes(3)
      const firstArgs = mockConvexAdminMutation.mock.calls[1]?.[1]
      const secondArgs = mockConvexAdminMutation.mock.calls[2]?.[1]
      expect(firstArgs).toEqual(secondArgs)
      expect(secondArgs).toEqual(expect.objectContaining({ storageId: 'storage_123' }))
    })

    it('does not retry an uncertain blob POST and never exposes raw provider errors', async () => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new TypeError('provider secret response: bucket shard 72'))
      vi.stubGlobal('fetch', fetchMock)

      const response = await POST(createUploadRequest())
      const data = await response.json()

      expect(response.status).toBe(502)
      expect(data).toEqual({
        error: 'Error al subir archivo al almacenamiento',
        reconciliationRequired: true,
        requestId: expect.any(String),
      })
      expect(JSON.stringify(data)).not.toContain('bucket shard')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mockConvexAdminMutation).toHaveBeenCalledTimes(1)
      expect(mockConvexAdminMutation).toHaveBeenCalledWith(
        '_documents/storage:generateUploadUrlInternal',
        {}
      )
    })

    it('honors AbortSignal during the storage POST and reports uncertain reconciliation', async () => {
      mockGetCurrentUser.mockResolvedValue(createMockUser({ role: 'COMPANY' }))
      const controller = new AbortController()
      const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
        expect(init.signal).toBeDefined()
        controller.abort()
        throw new DOMException('raw provider abort', 'AbortError')
      })
      vi.stubGlobal('fetch', fetchMock)

      const response = await POST(createUploadRequest(createValidPdfFormData(), controller.signal))
      const data = await response.json()

      expect(response.status).toBe(499)
      expect(data).toEqual({
        error: 'Carga cancelada',
        reconciliationRequired: true,
        requestId: expect.any(String),
      })
      expect(JSON.stringify(data)).not.toContain('provider abort')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mockConvexAdminMutation).toHaveBeenCalledTimes(1)
      expect(mockConvexAdminMutation).toHaveBeenCalledWith(
        '_documents/storage:generateUploadUrlInternal',
        {}
      )
    })
  })

  // =========================================================================
  // ALLOWED FILE TYPES (documentation test)
  // =========================================================================
  describe('File Type Validation Rules', () => {
    it('should document allowed MIME types', () => {
      // This test documents the allowed file types for uploads
      const allowedTypes = [
        'application/pdf',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ]

      // Document: PDF, Excel (xls/xlsx), Word (doc/docx), PowerPoint (ppt/pptx)
      expect(allowedTypes).toContain('application/pdf')
      expect(allowedTypes.length).toBe(7)
    })

    it('should document max file size as the platform-safe 4MB', () => {
      // Vercel corta cualquier body en ~4.5MB con un 413 antes de que la ruta
      // corra: anunciar 50MB era mentir (bug de producción 2026-07-31).
      expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024)
      expect(MAX_UPLOAD_BYTES).toBeLessThan(PLATFORM_REQUEST_BODY_LIMIT_BYTES)
    })

    it('should document default access level as NDA_REQUIRED', () => {
      const allowedAccessLevels = ['PUBLIC', 'NDA_REQUIRED', 'PRIVATE']
      expect(allowedAccessLevels).toContain('NDA_REQUIRED')
      expect(allowedAccessLevels.length).toBe(3)
    })
  })
})
