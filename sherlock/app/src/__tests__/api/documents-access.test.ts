// ============================================================================
// Document Access Route Tests
// Tests for GET /api/documents/access/[grantId]
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ============================================================================
// MOCK SETUP
// vi.hoisted() ensures these are available when vi.mock factories execute
// (vi.mock calls are hoisted above all other code by Vitest)
// ============================================================================

const {
  mockRequireApiAuth,
  mockConvexMutation,
  mockGetAuthenticatedConvex,
  mockConvexQuery,
  mockCheckRateLimitDistributed,
  mockFetch,
  loggerSpies,
} = vi.hoisted(() => ({
  mockRequireApiAuth: vi.fn(),
  mockConvexMutation: vi.fn(),
  mockGetAuthenticatedConvex: vi.fn(),
  mockConvexQuery: vi.fn(),
  mockCheckRateLimitDistributed: vi.fn(),
  mockFetch: vi.fn(),
  loggerSpies: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuth: () => mockRequireApiAuth(),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

const devAuth = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/lib/dev-auth/config', () => ({
  get DEV_AUTH_ENABLED() {
    return devAuth.enabled
  },
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      consumeDownloadGrant: 'documents.consumeDownloadGrant',
      releaseFailedDelivery: 'documents.releaseFailedDelivery',
    },
    users: {
      getCurrentProfileId: 'users.getCurrentProfileId',
    },
  },
}))

vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: (...args: unknown[]) => mockCheckRateLimitDistributed(...args),
  createRateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Retry-After': '60' },
    }),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: {
    api: { limit: 30, windowSec: 60 },
  },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => loggerSpies,
}))

// Import route handler AFTER mocks are registered
import { GET } from '@/app/api/documents/access/[grantId]/route'

// ============================================================================
// HELPERS
// ============================================================================

const BASE_URL = 'http://localhost/api/documents/access'
const STORAGE_SECRET = 'document-delivery-secret-for-tests'

function createRequest(
  grantId: string,
  token?: string,
  headerOverrides: Record<string, string> = {},
  search = ''
): NextRequest {
  const url = token ? `${BASE_URL}/${grantId}?token=${token}${search}` : `${BASE_URL}/${grantId}`
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      'user-agent': 'Vitest Browser',
      'x-forwarded-for': '127.0.0.1',
      ...headerOverrides,
    },
  })
}

function callRoute(
  grantId: string,
  token?: string,
  headerOverrides?: Record<string, string>,
  search?: string
) {
  return GET(createRequest(grantId, token, headerOverrides, search), {
    params: Promise.resolve({ grantId }),
  })
}

function mockAuthSuccess(overrides: Record<string, unknown> = {}) {
  mockRequireApiAuth.mockResolvedValue({
    user: {
      id: 'user_123',
      email: 'test@example.com',
      role: 'COMPANY',
      profileId: 'profile_123',
      ...overrides,
    },
    error: null,
  })
}

function mockConvexClientSuccess() {
  mockGetAuthenticatedConvex.mockResolvedValue({
    client: { mutation: mockConvexMutation },
    isAuthenticated: true,
    token: 'convex-token',
  })
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/documents/access/[grantId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    vi.stubGlobal('fetch', mockFetch)
    // Default: rate limiting allows requests
    mockCheckRateLimitDistributed.mockResolvedValue({ success: true, remaining: 29 })
    // Nueva Response por llamada: el body es un stream de un solo uso.
    mockFetch.mockImplementation(
      async () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  // =========================================================================
  // 1. VALID GRANT — SUCCESS PATH
  // =========================================================================
  describe('Valid grantId', () => {
    it('proxies the bytes instead of redirecting to the raw storage URL', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/file.pdf')

      // ===== ACT =====
      const response = await callRoute('grant_valid', 'access-token-abc')

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(mockFetch).toHaveBeenCalledWith('https://storage.convex.cloud/file.pdf', {
        cache: 'no-store',
      })
    })

    it('drops the source content-length when the storage response was content-encoded', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/balance.csv')
      mockFetch.mockImplementation(
        async () =>
          new Response(new TextEncoder().encode('a,b\n1,2\n3,4\n'), {
            status: 200,
            headers: {
              'content-type': 'text/csv',
              'content-encoding': 'gzip',
              'content-length': '5',
            },
          })
      )

      const response = await callRoute('grant_valid', 'access-token-abc')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBeNull()
      expect(await response.text()).toBe('a,b\n1,2\n3,4\n')
    })

    it('streams a PDF download through the proxy with the original bytes', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/financials',
        fileName: 'Financials.pdf',
        fileType: 'application/pdf',
        documentId: 'doc_123',
      })

      // ===== ACT =====
      const response = await callRoute('grant_pdf', 'access-token-abc')
      const body = new Uint8Array(await response.arrayBuffer())

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/pdf')
      expect(response.headers.get('content-disposition')).toContain('Financials.pdf')
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect([...body]).toEqual([37, 80, 68, 70])
      expect(mockFetch).toHaveBeenCalledWith('https://storage.convex.cloud/financials', {
        cache: 'no-store',
      })
    })

    it('streams non-PDF documents from the route and never leaks the storage URL', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/model',
        fileName: 'Model.xlsx',
        fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        documentId: 'doc_456',
      })

      // ===== ACT =====
      const response = await callRoute('grant_xlsx', 'access-token-abc')
      const body = new Uint8Array(await response.arrayBuffer())

      // ===== ASSERT =====
      // El grant es de un solo uso: un 3xx hacia *.convex.cloud dejaría el archivo
      // accesible sin auth y para siempre, fuera del gate NDA y del audit trail.
      expect(response.status).toBe(200)
      expect(response.status).toBeLessThan(300)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="Model.xlsx"; filename*=UTF-8''Model.xlsx`
      )
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect([...body]).toEqual([37, 80, 68, 70])
      expect(mockFetch).toHaveBeenCalledWith('https://storage.convex.cloud/model', {
        cache: 'no-store',
      })
    })

    it('never exposes a *.convex.cloud URL in any response header for a non-PDF grant', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://deployment-name.convex.cloud/api/storage/abc-123',
        fileName: 'Cap Table.docx',
        fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        documentId: 'doc_789',
      })

      // ===== ACT =====
      const response = await callRoute('grant_docx', 'access-token-abc')

      // ===== ASSERT =====
      const headerValues = [...response.headers.values()].join(' ')
      expect(headerValues).not.toContain('convex.cloud')
      expect(response.status).toBe(200)
    })

    it('falls back to application/octet-stream when the file type is unusable', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/blob',
        fileName: 'sin-extension',
        fileType: 'text/html\r\nX-Injected: 1',
        documentId: 'doc_odd',
      })

      // ===== ACT =====
      const response = await callRoute('grant_odd', 'access-token-abc')

      // ===== ASSERT =====
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('x-injected')).toBeNull()
    })

    it('returns 500 without leaking the storage URL when the proxy fetch fails', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/gone',
        fileName: 'Model.xlsx',
        fileType: 'application/vnd.ms-excel',
        documentId: 'doc_gone',
      })
      mockFetch.mockResolvedValue(new Response(null, { status: 404 }))

      // ===== ACT =====
      const response = await callRoute('grant_gone', 'access-token-abc')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(response.headers.get('location')).toBeNull()
      expect(data.error).toBe('No se pudo preparar el documento protegido')
      expect(loggerSpies.error).toHaveBeenCalledWith('Protected document proxy failed', {
        errorType: 'Error',
      })
      // El grant consumido se libera para que el reintento funcione: la falla
      // fue nuestra (storage/proxy), no del usuario.
      expect(mockConvexMutation).toHaveBeenCalledWith(
        'documents.releaseFailedDelivery',
        expect.objectContaining({
          grantId: 'grant_gone',
          token: 'access-token-abc',
          releaseIssuedAt: expect.any(Number),
          releaseProof: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
      )
    })

    it('keeps the 500 and does not crash when the release itself fails', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockImplementation(async (reference: unknown) => {
        if (reference === 'documents.consumeDownloadGrant') {
          return {
            downloadUrl: 'https://storage.convex.cloud/broken',
            fileName: 'Broken.pdf',
            fileType: 'application/pdf',
            documentId: 'doc_broken',
          }
        }
        throw new Error('release rejected')
      })
      mockFetch.mockRejectedValue(new Error('storage down'))

      const response = await callRoute('grant_pdf', 'access-token-abc')

      expect(response.status).toBe(500)
      expect(loggerSpies.error).toHaveBeenCalledWith('Failed delivery release failed', {
        errorType: 'Error',
      })
    })

    it('does not release the grant when delivery succeeds', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/ok',
        fileName: 'Ok.pdf',
        fileType: 'application/pdf',
        documentId: 'doc_ok',
      })

      const response = await callRoute('grant_ok', 'access-token-abc')

      expect(response.status).toBe(200)
      expect(mockConvexMutation).toHaveBeenCalledTimes(1)
      expect(mockConvexMutation).not.toHaveBeenCalledWith(
        'documents.releaseFailedDelivery',
        expect.anything()
      )
    })

    it('passes a short-lived server proof with the grant request', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/doc.pdf')

      // ===== ACT =====
      await callRoute('grant_abc', 'tok_xyz')

      // ===== ASSERT =====
      expect(mockConvexMutation).toHaveBeenCalledWith(
        'documents.consumeDownloadGrant',
        expect.objectContaining({
          grantId: 'grant_abc',
          token: 'tok_xyz',
          deliveryIssuedAt: expect.any(Number),
          deliveryProof: expect.stringMatching(/^[a-f0-9]{64}$/),
          ipAddress: '127.0.0.1',
          userAgent: 'Vitest Browser',
        })
      )
    })
  })

  // =========================================================================
  // 1a. DISPOSICIÓN DE ENTREGA — la fija el GRANT, no el query param
  // =========================================================================
  // El `?disposition=` lo escribe el navegador. Si decidiera la entrega, una
  // descarga real podría presentarse como vista previa y el header quedaría
  // contradiciendo lo que se auditó del otro lado.
  describe('Delivery disposition', () => {
    const PDF_GRANT = {
      downloadUrl: 'https://storage.convex.cloud/memo',
      fileName: 'Memo.pdf',
      fileType: 'application/pdf',
      documentId: 'doc_disp',
    }

    // Decisión [F] 2026-09-04: nada lleva sello. Ver y descargar entregan los
    // bytes originales; lo único que cambia es la disposición.
    it('entrega inline cuando el grant se emitió con intención VIEW', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({ ...PDF_GRANT, action: 'VIEW' })

      const response = await callRoute('grant_view', 'tok')
      const body = new Uint8Array(await response.arrayBuffer())

      expect(response.headers.get('content-disposition')).toMatch(/^inline;/)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect([...body]).toEqual([37, 80, 68, 70])
    })

    it('entrega attachment cuando el grant es DOWNLOAD aunque la URL pida inline', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({ ...PDF_GRANT, action: 'DOWNLOAD' })

      const response = await callRoute('grant_dl', 'tok', undefined, '&disposition=inline')
      const body = new Uint8Array(await response.arrayBuffer())

      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect([...body]).toEqual([37, 80, 68, 70])
    })

    it('respeta el query param heredado cuando el grant no declara intención', async () => {
      // Grants emitidos por el deploy anterior (TTL 5 min): sin `action`, la URL
      // vuelve a ser el único indicio disponible.
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue(PDF_GRANT)

      const response = await callRoute('grant_legacy', 'tok', undefined, '&disposition=inline')

      expect(response.headers.get('content-disposition')).toMatch(/^inline;/)
    })
  })

  // =========================================================================
  // 1a-bis. RENDITION PDF (PPTX / DOCX) BAJO EL MISMO GRANT
  // =========================================================================
  describe('PDF rendition', () => {
    const PPTX_GRANT = {
      downloadUrl: 'https://storage.convex.cloud/gerencia',
      fileName: 'andina-solar-gerencia.pptx',
      fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      documentId: 'doc_pptx',
      action: 'VIEW' as const,
    }

    function servePptxFixture() {
      const bytes = readFileSync(
        join(process.cwd(), 'e2e', 'fixtures', 'andina-solar-gerencia.pptx')
      )
      mockFetch.mockImplementation(
        async () =>
          new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-type': PPTX_GRANT.fileType },
          })
      )
    }

    it('converts a PPTX to PDF inline when the viewer asks for rendition=pdf', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue(PPTX_GRANT)
      servePptxFixture()

      const response = await callRoute('grant_pptx', 'tok', undefined, '&rendition=pdf')
      const body = new Uint8Array(await response.arrayBuffer())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/pdf')
      expect(response.headers.get('content-disposition')).toMatch(/^inline;/)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-sherlock-document-protection')).toBe('rendition')
      // %PDF
      expect(Array.from(body.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46])
      // La respuesta NO es el paquete original (PK\x03\x04).
      expect(Array.from(body.slice(0, 2))).not.toEqual([0x50, 0x4b])
    })

    // Sin el gate `disposition === 'inline'`, `?rendition=pdf` convertiría un
    // DOWNLOAD a un PDF sin marca y lo sacaría de la sala. El recorte de #435
    // no trajo este pin; el conversor SÍ cubre PPTX (el caso VIEW de arriba
    // lo prueba), así que un gate roto se vuelve verde-falso si no se afirma.
    it('does not convert a DOWNLOAD PPTX even when the URL asks for an inline pdf rendition', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({ ...PPTX_GRANT, action: 'DOWNLOAD' as const })
      servePptxFixture()

      const response = await callRoute(
        'grant_pptx_dl',
        'tok',
        undefined,
        '&rendition=pdf&disposition=inline'
      )
      const body = new Uint8Array(await response.arrayBuffer())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(response.headers.get('content-type')).toBe(PPTX_GRANT.fileType)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect(Array.from(body.slice(0, 2))).toEqual([0x50, 0x4b])
      expect(loggerSpies.warn).not.toHaveBeenCalledWith(
        'PDF rendition failed; falling back to the original bytes',
        expect.any(Object)
      )
    })

    it('a DOWNLOAD PDF still leaves as attachment when the URL also asks for rendition=pdf', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/memo',
        fileName: 'Memo.pdf',
        fileType: 'application/pdf',
        documentId: 'doc_dl_rendition',
        action: 'DOWNLOAD' as const,
      })

      const response = await callRoute(
        'grant_pdf_dl_rendition',
        'tok',
        undefined,
        '&rendition=pdf&disposition=inline'
      )
      const body = new Uint8Array(await response.arrayBuffer())

      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect([...body]).toEqual([37, 80, 68, 70])
    })

    it('serves the original when rendition=pdf is not requested', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue(PPTX_GRANT)
      servePptxFixture()

      const response = await callRoute('grant_pptx_plain', 'tok')

      expect(response.headers.get('content-type')).toBe(PPTX_GRANT.fileType)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
    })

    it('ignores rendition=pdf for a format the converter does not cover', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        downloadUrl: 'https://storage.convex.cloud/modelo',
        fileName: 'modelo.xlsx',
        fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        documentId: 'doc_xlsx',
        action: 'VIEW' as const,
      })

      const response = await callRoute('grant_xlsx', 'tok', undefined, '&rendition=pdf')

      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
    })

    it('falls back to the original bytes when the conversion fails', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue(PPTX_GRANT)
      // Un paquete ilegible: el conversor lanza, pero la entrega ya autorizada
      // no se pierde — el visor convierte del lado del cliente.
      mockFetch.mockImplementation(
        async () =>
          new Response(new TextEncoder().encode('no soy un pptx'), {
            status: 200,
            headers: { 'content-type': PPTX_GRANT.fileType },
          })
      )

      const response = await callRoute('grant_broken', 'tok', undefined, '&rendition=pdf')

      expect(response.status).toBe(200)
      expect(response.headers.get('x-sherlock-document-protection')).toBe('proxied')
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        'PDF rendition failed; falling back to the original bytes',
        expect.any(Object)
      )
    })
  })

  // =========================================================================
  // 1b. AUDIT-TRAIL IP DERIVATION (no debe ser falsificable por el cliente)
  // =========================================================================
  describe('Audit-trail IP derivation', () => {
    async function capturedIpFor(headers: Record<string, string>) {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/f.pdf')

      await callRoute('grant_ip', 'tok', headers)

      const args = mockConvexMutation.mock.calls[0][1] as { ipAddress?: string }
      return args.ipAddress
    }

    it('ignores a client-injected leftmost x-forwarded-for entry', async () => {
      const ip = await capturedIpFor({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })

      // El cliente controla el elemento izquierdo; el hop confiable es el derecho.
      expect(ip).toBe('198.51.100.7')
      expect(ip).not.toBe('203.0.113.9')
    })

    it('prefers the platform header over any client-supplied forwarding header', async () => {
      const ip = await capturedIpFor({
        'x-vercel-forwarded-for': '198.51.100.7',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.10',
      })

      expect(ip).toBe('198.51.100.7')
    })

    it('falls back to x-real-ip before x-forwarded-for', async () => {
      const ip = await capturedIpFor({
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '203.0.113.9',
      })

      expect(ip).toBe('198.51.100.20')
    })

    it('drops malformed forwarding metadata instead of persisting it', async () => {
      const ip = await capturedIpFor({
        'x-vercel-forwarded-for': 'not-an-ip',
        'x-real-ip': 'also-invalid',
        'x-forwarded-for': 'still-invalid',
      })

      expect(ip).toBeUndefined()
    })

    it('bounds user-agent metadata before sending it to the audit mutation', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/f.pdf')

      await callRoute('grant_ua', 'tok', { 'user-agent': `  ${'x'.repeat(700)}  ` })

      const args = mockConvexMutation.mock.calls[0][1] as { userAgent?: string }
      expect(args.userAgent).toBe('x'.repeat(512))
    })
  })

  // =========================================================================
  // 2. INVALID / NONEXISTENT GRANT — 404
  // =========================================================================
  describe('Invalid or nonexistent grantId', () => {
    it('returns 404 when the mutation returns null (expired/used grant)', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue(null)

      // ===== ACT =====
      const response = await callRoute('grant_expired', 'some-token')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(404)
      expect(data.error).toBe('Archivo no disponible')
    })

    it('returns 404 when mutation throws "no encontrado" error', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('Documento no encontrado'))

      // ===== ACT =====
      const response = await callRoute('grant_nonexistent', 'some-token')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(404)
      expect(data.error).toContain('no encontrado')
    })

    it('returns 404 when mutation throws "no disponible" error', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('Archivo no disponible'))

      // ===== ACT =====
      const response = await callRoute('grant_unavail', 'tok')

      // ===== ASSERT =====
      expect(response.status).toBe(404)
    })
  })

  // =========================================================================
  // 3. AUTHENTICATION — 401
  // =========================================================================
  describe('Authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      // ===== ARRANGE =====
      const authError = new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
      mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

      // ===== ACT =====
      const response = await callRoute('grant_123', 'some-token')

      // ===== ASSERT =====
      expect(response.status).toBe(401)
    })

    it('returns 400 when access token query param is missing', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()

      // ===== ACT =====
      const response = await callRoute('grant_123') // no token
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(400)
      expect(data.error).toBe('Token de acceso faltante')
    })

    it('returns 500 when Convex auth client is unavailable', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockGetAuthenticatedConvex.mockResolvedValue(null)

      // ===== ACT =====
      const response = await callRoute('grant_123', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('No se pudo verificar la sesión documental')
    })

    it('returns 500 when Convex client is present but not authenticated', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: { mutation: mockConvexMutation },
        isAuthenticated: false,
        token: null,
      })

      // ===== ACT =====
      const response = await callRoute('grant_123', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      expect(data.error).toBe('No se pudo verificar la sesión documental')
    })

    it('accepts the token-less client under dev-auth and signs the proof with the convex profile', async () => {
      // ===== ARRANGE =====
      devAuth.enabled = true
      mockAuthSuccess()
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: { mutation: mockConvexMutation, query: mockConvexQuery },
        isAuthenticated: false,
        token: null,
      })
      mockConvexQuery.mockResolvedValue({ profileId: 'profile_resolved_by_convex' })

      try {
        // ===== ACT =====
        const response = await callRoute('grant_123', 'tok')
        const data = await response.json().catch(() => ({}))

        // ===== ASSERT =====
        expect(data.error).not.toBe('No se pudo verificar la sesión documental')
        expect(mockConvexMutation).toHaveBeenCalled()
        const { createDocumentDeliveryProof } = await import('@/../convex/_documents/deliveryProof')
        const call = mockConvexMutation.mock.calls[0][1] as {
          grantId: string
          token: string
          deliveryIssuedAt: number
          deliveryProof: string
        }
        const expectedProof = await createDocumentDeliveryProof(
          process.env.STORAGE_SECRET as string,
          {
            grantId: call.grantId,
            token: call.token,
            profileId: 'profile_resolved_by_convex',
            issuedAt: call.deliveryIssuedAt,
          }
        )
        expect(call.deliveryProof).toBe(expectedProof)
        expect(mockConvexQuery).toHaveBeenCalledWith('users.getCurrentProfileId', {})
      } finally {
        devAuth.enabled = false
        mockConvexQuery.mockReset()
      }
    })

    it('signs a failed-delivery release with the convex profile under dev-auth', async () => {
      devAuth.enabled = true
      mockAuthSuccess()
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: { mutation: mockConvexMutation, query: mockConvexQuery },
        isAuthenticated: false,
        token: null,
      })
      mockConvexQuery.mockResolvedValue({ profileId: 'profile_resolved_by_convex' })
      mockConvexMutation.mockImplementation(async (reference: unknown) => {
        if (reference === 'documents.consumeDownloadGrant') {
          return {
            downloadUrl: 'https://storage.convex.cloud/gone',
            fileName: 'Model.xlsx',
            fileType: 'application/vnd.ms-excel',
            documentId: 'doc_gone',
          }
        }
        return undefined
      })
      mockFetch.mockResolvedValue(new Response(null, { status: 404 }))

      try {
        const response = await callRoute('grant_gone', 'tok')

        expect(response.status).toBe(500)
        const releaseCall = mockConvexMutation.mock.calls.find(
          ([reference]) => reference === 'documents.releaseFailedDelivery'
        )
        expect(releaseCall).toBeDefined()
        const release = releaseCall?.[1] as {
          grantId: string
          token: string
          releaseIssuedAt: number
          releaseProof: string
        }
        const { createDocumentDeliveryProof } = await import('@/../convex/_documents/deliveryProof')
        const expectedProof = await createDocumentDeliveryProof(
          process.env.STORAGE_SECRET as string,
          {
            grantId: release.grantId,
            token: release.token,
            profileId: 'profile_resolved_by_convex',
            issuedAt: release.releaseIssuedAt,
          }
        )
        expect(release.releaseProof).toBe(expectedProof)
      } finally {
        devAuth.enabled = false
        mockConvexQuery.mockReset()
      }
    })
  })

  describe('Server delivery proof configuration', () => {
    it('fails closed before Convex when STORAGE_SECRET is missing', async () => {
      vi.stubEnv('STORAGE_SECRET', '')
      mockAuthSuccess()
      mockConvexClientSuccess()

      const response = await callRoute('grant_123', 'some-token')

      expect(response.status).toBe(500)
      expect(mockConvexMutation).not.toHaveBeenCalled()
      expect(loggerSpies.error).toHaveBeenCalledWith(
        'Document delivery proof configuration missing'
      )
    })

    it('fails closed before Convex when the authenticated user has no profile', async () => {
      mockAuthSuccess({ profileId: null })
      mockConvexClientSuccess()

      const response = await callRoute('grant_123', 'some-token')

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: 'Acceso denegado',
        requestId: expect.any(String),
      })
      expect(mockConvexMutation).not.toHaveBeenCalled()
      expect(loggerSpies.warn).toHaveBeenCalledWith('Authenticated user missing document profile')
    })
  })

  // =========================================================================
  // 4. RATE LIMITING
  // =========================================================================
  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      // ===== ARRANGE =====
      mockCheckRateLimitDistributed.mockResolvedValue({
        success: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
        retryAfterSec: 60,
      })

      // ===== ACT =====
      const response = await callRoute('grant_123', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(429)
      expect(data.error).toBe('Too many requests')
    })

    it('rate limit check runs before auth (fast-fail)', async () => {
      // ===== ARRANGE =====
      mockCheckRateLimitDistributed.mockResolvedValue({
        success: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
        retryAfterSec: 60,
      })

      // ===== ACT =====
      await callRoute('grant_123', 'tok')

      // ===== ASSERT =====
      // Auth should NOT be called when rate-limited
      expect(mockRequireApiAuth).not.toHaveBeenCalled()
    })

    it('logs a warning when rate limit is exceeded', async () => {
      // ===== ARRANGE =====
      mockCheckRateLimitDistributed.mockResolvedValue({
        success: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
        retryAfterSec: 60,
      })

      // ===== ACT =====
      await callRoute('grant_123', 'tok')

      // ===== ASSERT =====
      expect(loggerSpies.warn).toHaveBeenCalledWith('Rate limit exceeded')
    })

    it('uses documents:access:<ip> as the rate limit key', async () => {
      // ===== ARRANGE =====
      mockCheckRateLimitDistributed.mockResolvedValue({ success: true, remaining: 29 })
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/f.pdf')

      // ===== ACT =====
      await callRoute('grant_123', 'tok')

      // ===== ASSERT =====
      expect(mockCheckRateLimitDistributed).toHaveBeenCalledWith(
        'documents:access:127.0.0.1',
        expect.objectContaining({ limit: 30, windowSec: 60 })
      )
    })
  })

  // =========================================================================
  // 5. AUTH TOKEN VALIDATION (expired, malformed)
  // =========================================================================
  describe('Auth token validation', () => {
    it('returns 500 when auth throws (expired/malformed Clerk token)', async () => {
      // ===== ARRANGE =====
      const authError = new Response(JSON.stringify({ error: 'Error de autenticación' }), {
        status: 500,
      })
      mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

      // ===== ACT =====
      const response = await callRoute('grant_123', 'tok')

      // ===== ASSERT =====
      expect(response.status).toBe(500)
      const data = await response.json()
      expect(data.error).toBe('Error de autenticación')
    })

    it('returns 403 when profile is not synced', async () => {
      // ===== ARRANGE =====
      const authError = new Response(
        JSON.stringify({ error: 'Perfil no sincronizado o permisos incompletos' }),
        { status: 403 }
      )
      mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

      // ===== ACT =====
      const response = await callRoute('grant_123', 'tok')

      // ===== ASSERT =====
      expect(response.status).toBe(403)
    })
  })

  // =========================================================================
  // 6. AUDIT LOGGING
  // =========================================================================
  describe('Audit logging', () => {
    it('successful access calls the Convex mutation (which handles audit logging)', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue('https://storage.convex.cloud/report.pdf')

      // ===== ACT =====
      await callRoute('grant_audit', 'tok_audit')

      // ===== ASSERT =====
      // The mutation consumeDownloadGrant is responsible for creating the audit log entry.
      // Verify it was called exactly once with the grant and metadata.
      expect(mockConvexMutation).toHaveBeenCalledTimes(1)
      expect(mockConvexMutation).toHaveBeenCalledWith(
        'documents.consumeDownloadGrant',
        expect.objectContaining({
          grantId: 'grant_audit',
          token: 'tok_audit',
          ipAddress: '127.0.0.1',
          userAgent: 'Vitest Browser',
        })
      )
    })

    // ES: consumeDownloadGrant ya no lanza en la rama deny (#15): devuelve el
    // resultado estructurado para que la fila DENIED de auditoría commitee. La
    // ruta lo traduce a 403 genérico sin filtrar el código al cliente.
    it('returns 403 when the mutation resolves with a structured policy deny', async () => {
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockResolvedValue({
        allowed: false,
        code: 'REQUIRE_SIGNED_NDA',
        message: 'Debes firmar un NDA activo para acceder a este documento.',
      })

      const response = await callRoute('grant_denied', 'tok')

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: 'Acceso denegado',
        requestId: expect.any(String),
      })
      expect(loggerSpies.warn).toHaveBeenCalledWith('Document access denied by policy', {
        code: 'REQUIRE_SIGNED_NDA',
      })
    })

    it('logs warning when document access is denied by policy', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('Acceso denegado'))

      // ===== ACT =====
      await callRoute('grant_denied', 'tok')

      // ===== ASSERT =====
      expect(loggerSpies.warn).toHaveBeenCalledWith('Document access denied', {
        errorType: 'Error',
      })
    })

    it('logs warning when Convex client is unavailable', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockGetAuthenticatedConvex.mockResolvedValue(null)

      // ===== ACT =====
      await callRoute('grant_no_convex', 'tok')

      // ===== ASSERT =====
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        'Authenticated Convex client unavailable for document access'
      )
    })
  })

  // =========================================================================
  // 7. ERROR HANDLING — no internal details leaked
  // =========================================================================
  describe('Error handling', () => {
    it('returns 403 with generic error for non-404 errors (no stack traces)', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('Este documento requiere KYC verificado.'))

      // ===== ACT =====
      const response = await callRoute('grant_kyc', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('Acceso denegado')
      // Must not contain stack trace or internal paths
      expect(data.stack).toBeUndefined()
      expect(data.error).not.toContain('at ')
      expect(data.error).not.toContain('node_modules')
    })

    it('returns generic "Acceso denegado" for non-404 mutation errors', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('NDA no firmado para este deal'))

      // ===== ACT =====
      const response = await callRoute('grant_nda', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('Acceso denegado')
    })

    it('falls back to "Acceso denegado" when the thrown value is not an Error', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue('raw string error')

      // ===== ACT =====
      const response = await callRoute('grant_raw', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      expect(response.status).toBe(403)
      expect(data.error).toBe('Acceso denegado')
    })

    it('response body only contains the error field', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      mockConvexMutation.mockRejectedValue(new Error('Permiso insuficiente'))

      // ===== ACT =====
      const response = await callRoute('grant_perm', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      // Solo el error y el requestId del sobre: sin stack, sin detalles, sin internals
      expect(Object.keys(data).toSorted()).toEqual(['error', 'requestId'])
    })

    it('does not expose Convex internal errors to the client', async () => {
      // ===== ARRANGE =====
      mockAuthSuccess()
      mockConvexClientSuccess()
      const internalError = new Error(
        'ConvexError: internal server error at mutation documents:consumeDownloadGrant'
      )
      mockConvexMutation.mockRejectedValue(internalError)

      // ===== ACT =====
      const response = await callRoute('grant_internal', 'tok')
      const data = await response.json()

      // ===== ASSERT =====
      // Status is 403 (not 500) because the catch block maps non-404 errors to 403
      expect(response.status).toBe(403)
      // The error IS forwarded (the route trusts Convex messages for now),
      // but importantly no stack trace or server internals beyond the message
      expect(data.stack).toBeUndefined()
      expect(Object.keys(data).toSorted()).toEqual(['error', 'requestId'])
    })
  })
})
