import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockRequireApiAuthWithRole = vi.hoisted(() => vi.fn())
const mockRequireAdminApiStepUp = vi.hoisted(() => vi.fn())
const mockGetAuthenticatedConvex = vi.hoisted(() => vi.fn())
const mockCheckRateLimitDistributed = vi.hoisted(() => vi.fn())
const mockCreateRateLimitResponse = vi.hoisted(() => vi.fn())
const mockQuery = vi.hoisted(() => vi.fn())
const mockMutation = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuthWithRole: (...args: unknown[]) => mockRequireApiAuthWithRole(...args),
  requireAdminApiStepUp: (...args: unknown[]) => mockRequireAdminApiStepUp(...args),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: (...args: unknown[]) => mockCheckRateLimitDistributed(...args),
  createRateLimitResponse: (...args: unknown[]) => mockCreateRateLimitResponse(...args),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: {
    api: { limit: 30, windowSec: 60 },
  },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    vdrExport: {
      listExportableDocuments: 'vdrExport.listExportableDocuments',
      recordRoomExport: 'vdrExport.recordRoomExport',
    },
  },
}))

import { GET } from '@/app/api/vdr/export/route'

const COMPANY_ID = 'kb26dda1f99bb802816c813f82df3936'

function createRequest(search = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/vdr/export${search}`, { method: 'GET' })
}

function exportableDocuments(overrides: Partial<{ byteSize: number }> = {}) {
  return {
    companyId: COMPANY_ID,
    companyName: 'SAMPLE_ENERGY',
    documents: [
      {
        documentId: 'document_legal',
        name: 'Estatutos.pdf',
        folder: 'room_legal',
        byteSize: overrides.byteSize ?? 12,
        storageUrl: 'https://files.test/legal',
        versionId: 'version_legal',
      },
      {
        documentId: 'document_financial',
        name: 'Modelo.xlsx',
        folder: 'room_financial',
        byteSize: 20,
        storageUrl: 'https://files.test/financial',
        versionId: 'version_financial',
      },
    ],
  }
}

describe('GET /api/vdr/export', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockCheckRateLimitDistributed.mockResolvedValue({ success: true, remaining: 29 })
    mockCreateRateLimitResponse.mockReturnValue(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
    )
    mockRequireApiAuthWithRole.mockResolvedValue({
      user: { id: 'user_123', email: 'owner@example.com', role: 'COMPANY' },
      error: null,
    })
    mockRequireAdminApiStepUp.mockResolvedValue(null)
    mockMutation.mockResolvedValue({ logged: 2 })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: {
        query: (...args: unknown[]) => mockQuery(...args),
        mutation: (...args: unknown[]) => mockMutation(...args),
      },
      isAuthenticated: true,
    })
    mockQuery.mockResolvedValue(exportableDocuments())
    mockFetch.mockImplementation(async (url: string) => {
      const body = url.includes('legal') ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5])
      return new Response(body, { status: 200 })
    })
  })

  it('returns 401 without a session', async () => {
    const authError = new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
    mockRequireApiAuthWithRole.mockResolvedValue({ user: null, error: authError })

    const response = await GET(createRequest())

    expect(response.status).toBe(401)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns 413 when byteSize exceeds 250 MB before downloading blobs', async () => {
    mockQuery.mockResolvedValue({
      companyId: COMPANY_ID,
      companyName: 'SAMPLE_ENERGY',
      documents: [
        {
          documentId: 'document_legal',
          name: 'Estatutos.pdf',
          folder: 'room_legal',
          byteSize: 200 * 1024 * 1024,
          storageUrl: 'https://files.test/legal',
          versionId: 'version_legal',
        },
        {
          documentId: 'document_financial',
          name: 'Modelo.xlsx',
          folder: 'room_financial',
          byteSize: 51 * 1024 * 1024,
          storageUrl: 'https://files.test/financial',
          versionId: 'version_financial',
        },
      ],
    })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))
    const body = await response.json()

    expect(response.status).toBe(413)
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns a zip with the five shell folder paths for a two-document room', async () => {
    const response = await GET(createRequest(`?companyId=${COMPANY_ID}&locale=es`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(mockMutation).toHaveBeenCalledWith('vdrExport.recordRoomExport', {
      companyId: COMPANY_ID,
      exportId: expect.any(String),
      documentIds: ['document_legal', 'document_financial'],
    })

    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // El audit corre antes de que se abra el primer blob: despues del primer
    // byte la respuesta ya no puede retractarse.
    expect(mockMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockFetch.mock.invocationCallOrder[0] as number
    )
    expect(
      Object.keys(zip.files)
        .filter((name) => !zip.files[name]?.dir)
        .sort()
    ).toEqual(['1. Legales/Estatutos.pdf', '3. Financieros/Modelo.xlsx'])
  })

  it('refuses the export when the audit fails, without opening a blob', async () => {
    mockMutation.mockRejectedValue({ data: { code: 'RATE_LIMIT_EXCEEDED' } })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED')
    expect(body.requestId).toBeTruthy()
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('aborts the stream when a blob fails instead of shipping a short zip', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('legal')
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        : new Response('gone', { status: 500 })
    )

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))

    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('carries the requestId on the rate-limit refusal', async () => {
    mockCheckRateLimitDistributed.mockResolvedValue({
      success: false,
      remaining: 0,
      retryAfterSec: 30,
      resetAt: new Date(0),
    })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))

    expect(response.status).toBe(429)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(mockRequireApiAuthWithRole).not.toHaveBeenCalled()
  })

  // El parametro `folder` existe en la API y no tiene boton todavia (ninguna
  // vista exporta una sola carpeta). Queda cubierto por test para que el
  // contrato no se pudra mientras espera su UI.
  it('narrows the export to one shell folder when asked', async () => {
    mockQuery.mockResolvedValue({
      companyId: COMPANY_ID,
      companyName: 'SAMPLE_ENERGY',
      documents: [exportableDocuments().documents[0]],
    })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}&folder=room_legal`))

    expect(response.status).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith('vdrExport.listExportableDocuments', {
      companyId: COMPANY_ID,
      folder: 'room_legal',
    })
    expect(mockMutation).toHaveBeenCalledWith('vdrExport.recordRoomExport', {
      companyId: COMPANY_ID,
      exportId: expect.any(String),
      folder: 'room_legal',
      documentIds: ['document_legal'],
    })
  })

  it('rejects a folder that tries to climb out of the room shell', async () => {
    const response = await GET(
      createRequest(`?companyId=${COMPANY_ID}&folder=${encodeURIComponent('../room_legal')}`)
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns 404 for a shell folder with no published documents', async () => {
    mockQuery.mockResolvedValue({
      companyId: COMPANY_ID,
      companyName: 'SAMPLE_ENERGY',
      documents: [],
    })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}&folder=room_operations`))
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.code).toBe('NOT_FOUND')
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('rejects a folder that is not part of the room shell', async () => {
    const response = await GET(createRequest(`?companyId=${COMPANY_ID}&folder=room_secret`))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('requires companyId when the caller is an admin', async () => {
    mockRequireApiAuthWithRole.mockResolvedValue({
      user: { id: 'admin_123', email: 'admin@example.com', role: 'ADMIN' },
      error: null,
    })

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('refuses an admin without recent step-up before listing the room', async () => {
    const stepUpError = new Response(JSON.stringify({ code: 'ADMIN_STEP_UP_REQUIRED' }), {
      status: 403,
    })
    mockRequireApiAuthWithRole.mockResolvedValue({
      user: { id: 'admin_123', email: 'admin@example.com', role: 'ADMIN' },
      error: null,
    })
    mockRequireAdminApiStepUp.mockResolvedValue(stepUpError)

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))

    expect(response.status).toBe(403)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns the role helper 403 without opening Convex or a blob', async () => {
    const forbidden = new Response(JSON.stringify({ error: 'No autorizado' }), { status: 403 })
    mockRequireApiAuthWithRole.mockResolvedValue({ user: null, error: forbidden })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))

    expect(response.status).toBe(403)
    expect(mockRequireApiAuthWithRole).toHaveBeenCalledWith(['COMPANY', 'ADMIN'])
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 404 when the room has no published documents, without a zip', async () => {
    mockQuery.mockResolvedValue({
      companyId: COMPANY_ID,
      companyName: 'SAMPLE_ENERGY',
      documents: [],
    })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.code).toBe('NOT_FOUND')
    expect(body.error).toBe('No hay documentos publicados para exportar.')
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(mockMutation).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('maps Convex AUTHZ_UNAUTHORIZED to 403 without leaking internals', async () => {
    mockQuery.mockRejectedValue({ data: { code: 'AUTHZ_UNAUTHORIZED' } })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))
    const serialized = await response.text()

    expect(response.status).toBe(403)
    expect(JSON.parse(serialized)).toMatchObject({
      code: 'AUTHZ_UNAUTHORIZED',
      error: 'No tienes permiso para exportar esta sala',
    })
    expect(serialized).not.toMatch(/stack|storageUrl|files\.test|ConvexError/i)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed companyId before talking to Convex', async () => {
    const response = await GET(createRequest('?companyId=not-a-convex-id'))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns 500 when the authenticated Convex client is missing', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({ client: null, isAuthenticated: false })

    const response = await GET(createRequest(`?companyId=${COMPANY_ID}`))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.code).toBe('INTERNAL_ERROR')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
