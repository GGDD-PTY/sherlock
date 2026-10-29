import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockMutation = vi.fn()
const mockAction = vi.fn()
const mockGetUnauthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getUnauthenticatedConvex: () => mockGetUnauthenticatedConvex(),
}))

const mockRateLimit = vi.fn()
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
  }
})

import { GET as listDocuments } from '@/app/api/intake/documents/route'
import { POST as issueUpload } from '@/app/api/intake/uploads/route'
import { POST as registerUpload } from '@/app/api/intake/uploads/register/route'
import {
  createIntakeCsrfToken,
  getIntakeCsrfCookieName,
  INTAKE_CSRF_HEADER,
} from '@/lib/intake/csrf'
import { getIntakeSessionCookieName } from '@/lib/intake/session'

const SECRET = 'intake-server-secret-for-upload-api-tests-12345'
const AUDIENCE = 'sherlock-test:intake-upload-api'
const SESSION_TOKEN = 't'.repeat(43)
const CSRF_TOKEN = 'placeholder'

const MEGABYTE = 1024 * 1024
const OVERSIZE_CHUNK_BYTES = 16 * 1024

function authorizedRequest(path: string, method: 'GET' | 'POST', body?: unknown, origin?: string) {
  const csrfToken =
    CSRF_TOKEN === 'placeholder' ? createIntakeCsrfToken({ binding: SESSION_TOKEN }) : CSRF_TOKEN
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      Origin: origin ?? 'http://localhost:3000',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}; ${getIntakeCsrfCookieName()}=${csrfToken}`,
      ...(method === 'POST' ? { [INTAKE_CSRF_HEADER]: csrfToken } : {}),
      'x-vercel-forwarded-for': '203.0.113.11',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function countingMegabyteStream(chunkBytes: number) {
  let delivered = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = MEGABYTE - delivered
      if (remaining <= 0) {
        controller.close()
        return
      }
      const size = Math.min(chunkBytes, remaining)
      delivered += size
      controller.enqueue(new Uint8Array(size).fill(120))
    },
  })
  return { stream, bytesDelivered: () => delivered }
}

function authorizedStreamRequest(
  path: string,
  stream: ReadableStream<Uint8Array>,
  extraHeaders: Record<string, string> = {}
) {
  const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
  const request = new Request(
    `http://localhost:3000${path}`,
    Object.assign(
      {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}; ${getIntakeCsrfCookieName()}=${csrfToken}`,
          [INTAKE_CSRF_HEADER]: csrfToken,
          'x-vercel-forwarded-for': '203.0.113.11',
          ...extraHeaders,
        },
        body: stream,
      },
      { duplex: 'half' as const }
    )
  )
  return new NextRequest(request)
}

describe('session-scoped intake upload API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud')
    mockGetUnauthenticatedConvex.mockReturnValue({ mutation: mockMutation, action: mockAction })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('issues a direct-upload intent only after CSRF and binds immutable file metadata server-side', async () => {
    mockMutation.mockResolvedValueOnce({
      intentId: 'intake_intent_1',
      uploadUrl: 'https://example.convex.cloud/api/storage/upload?token=provider-capability',
      expiresAt: Date.now() + 10 * 60_000,
    })
    const body = {
      fileName: 'Financials.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 1024,
      declaredSha256: 'a'.repeat(64),
    }
    const response = await issueUpload(authorizedRequest('/api/intake/uploads', 'POST', body))
    const result = await response.json()

    expect(response.status).toBe(201)
    expect(result).toMatchObject({
      intentId: 'intake_intent_1',
      uploadUrl: expect.stringContaining('convex.cloud'),
      expiresAt: expect.any(Number),
    })
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN)
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      ...body,
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  // F13 (#553): el cliente pide supersedir un intent ISSUED solo tras un intento
  // terminal no recibido del mismo archivo. El API lo valida como boolean
  // opcional y lo pasa tal cual a la mutation.
  it('forwards an optional supersedePending boolean and rejects any other shape', async () => {
    const body = {
      fileName: 'Financials.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 1024,
      declaredSha256: 'a'.repeat(64),
    }

    const rejected = await issueUpload(
      authorizedRequest('/api/intake/uploads', 'POST', { ...body, supersedePending: 'yes' })
    )
    expect(rejected.status).toBe(400)
    expect(mockMutation).not.toHaveBeenCalled()

    mockMutation.mockResolvedValueOnce({
      intentId: 'intake_intent_2',
      uploadUrl: 'https://example.convex.cloud/api/storage/upload?token=provider-capability',
      expiresAt: Date.now() + 10 * 60_000,
    })
    const accepted = await issueUpload(
      authorizedRequest('/api/intake/uploads', 'POST', { ...body, supersedePending: true })
    )
    expect(accepted.status).toBe(201)
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ...body, supersedePending: true })
    )
  })

  it('returns the existing staged document without issuing a second storage upload', async () => {
    mockMutation.mockResolvedValueOnce({
      alreadyRegistered: true,
      document: {
        id: 'intake_document_existing',
        displayName: 'Financials.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 1024,
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: Date.now(),
      },
    })
    const response = await issueUpload(
      authorizedRequest('/api/intake/uploads', 'POST', {
        fileName: 'Financials.pdf',
        declaredMimeType: 'application/pdf',
        declaredByteSize: 1024,
        declaredSha256: 'a'.repeat(64),
      })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      alreadyRegistered: true,
      document: { id: 'intake_document_existing' },
    })
  })

  it('projects a structured FILE_TOO_LARGE rejection without exposing storage authority', async () => {
    mockMutation.mockResolvedValueOnce({ registered: false, code: 'FILE_TOO_LARGE' })

    const response = await issueUpload(
      authorizedRequest('/api/intake/uploads', 'POST', {
        fileName: 'balance.csv',
        declaredMimeType: 'text/csv',
        declaredByteSize: 20 * 1024 * 1024 + 1,
        declaredSha256: 'a'.repeat(64),
      })
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Solicitud inválida',
      code: 'FILE_TOO_LARGE',
    })
  })

  it('rejects an empty JSON body with 400 INVALID_JSON instead of 500', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
    const empty = new NextRequest('http://localhost:3000/api/intake/uploads', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
        Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}; ${getIntakeCsrfCookieName()}=${csrfToken}`,
        [INTAKE_CSRF_HEADER]: csrfToken,
        'x-vercel-forwarded-for': '203.0.113.11',
      },
      body: '',
    })

    const response = await issueUpload(empty)
    const result = await response.json()

    expect(response.status).toBe(400)
    expect(result).toMatchObject({ error: 'Solicitud inválida', code: 'INVALID_JSON' })
    expect(mockMutation).not.toHaveBeenCalled()
  })

  // STALE_TEST O5-04-1: un stream ya consumido es falla del servidor (500), no 400.
  it('keeps a consumed JSON body as 500 so the client can retry the intent', async () => {
    const request = authorizedRequest('/api/intake/uploads', 'POST', {
      fileName: 'Financials.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 1024,
      declaredSha256: 'a'.repeat(64),
    })
    await request.arrayBuffer()

    const response = await issueUpload(request)
    const result = await response.json()

    expect(response.status).toBe(500)
    expect(result).toMatchObject({ error: 'Error interno del servidor' })
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('rejects a 1 MB JSON body declared by Content-Length without reading it', async () => {
    const body = countingMegabyteStream(OVERSIZE_CHUNK_BYTES)
    const response = await issueUpload(
      authorizedStreamRequest('/api/intake/uploads', body.stream, {
        'Content-Length': String(MEGABYTE),
      })
    )
    const result = await response.json()

    expect(response.status).toBe(413)
    expect(result).toMatchObject({ error: 'Solicitud inválida', code: 'PAYLOAD_TOO_LARGE' })
    expect(body.bytesDelivered()).toBeLessThan(MEGABYTE)
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('rejects a 1 MB JSON body without Content-Length before finishing the stream', async () => {
    const body = countingMegabyteStream(OVERSIZE_CHUNK_BYTES)
    const response = await issueUpload(authorizedStreamRequest('/api/intake/uploads', body.stream))
    const result = await response.json()

    expect(response.status).toBe(413)
    expect(result).toMatchObject({ error: 'Solicitud inválida', code: 'PAYLOAD_TOO_LARGE' })
    expect(body.bytesDelivered()).toBeLessThan(MEGABYTE)
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('rejects cross-origin upload issuance before any storage intent effect', async () => {
    const response = await issueUpload(
      authorizedRequest(
        '/api/intake/uploads',
        'POST',
        {
          fileName: 'Financials.pdf',
          declaredMimeType: 'application/pdf',
          declaredByteSize: 1024,
          declaredSha256: 'a'.repeat(64),
        },
        'https://attacker.example'
      )
    )

    expect(response.status).toBe(403)
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('registers only through the inspection action and never accepts client claimability or owner state', async () => {
    mockAction.mockResolvedValueOnce({
      registered: true,
      document: {
        id: 'intake_document_1',
        displayName: 'Financials.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 1024,
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: Date.now(),
      },
    })
    const response = await registerUpload(
      authorizedRequest('/api/intake/uploads/register', 'POST', {
        intentId: 'intake_intent_1',
        storageId: 'storage_1',
        claimable: false,
        storageState: 'OWNED_BY_COMPANY',
      })
    )

    expect(response.status).toBe(400)
    expect(mockAction).not.toHaveBeenCalled()

    const validResponse = await registerUpload(
      authorizedRequest('/api/intake/uploads/register', 'POST', {
        intentId: 'intake_intent_1',
        storageId: 'storage_1',
      })
    )
    const result = await validResponse.json()
    expect(validResponse.status).toBe(200)
    expect(result.document).toMatchObject({ inspectionStatus: 'CLEAN', claimable: true })
    expect(JSON.stringify(result)).not.toContain('storage_1')
    expect(mockAction).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      intentId: 'intake_intent_1',
      storageId: 'storage_1',
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it('keeps uninspected and suspicious registrations quarantined and unclaimable', async () => {
    for (const inspectionStatus of ['UNINSPECTED', 'SUSPICIOUS'] as const) {
      mockAction.mockResolvedValueOnce({
        registered: false,
        code: inspectionStatus === 'SUSPICIOUS' ? 'MALWARE_DETECTED' : 'SCAN_UNAVAILABLE',
        document: {
          id: `document_${inspectionStatus}`,
          displayName: 'Upload.pdf',
          declaredMimeType: 'application/pdf',
          byteSize: 1024,
          inspectionStatus,
          claimable: false,
          createdAt: Date.now(),
        },
      })
      const response = await registerUpload(
        authorizedRequest('/api/intake/uploads/register', 'POST', {
          intentId: `intent_${inspectionStatus}`,
          storageId: `storage_${inspectionStatus}`,
        })
      )
      expect(await response.json()).toMatchObject({
        registered: false,
        document: { inspectionStatus, claimable: false },
      })
    }
  })

  it('returns a bounded metadata projection without storage IDs or another session selector', async () => {
    mockMutation.mockResolvedValueOnce({
      authenticated: true,
      documents: [
        {
          id: 'intake_document_1',
          displayName: 'Financials.pdf',
          declaredMimeType: 'application/pdf',
          byteSize: 1024,
          inspectionStatus: 'CLEAN',
          claimable: true,
          createdAt: Date.now(),
        },
      ],
    })
    const response = await listDocuments(authorizedRequest('/api/intake/documents', 'GET'))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.documents).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('storageId')
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN)
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  // [F] 2026-09-14 14:27 retiró el tope de veinte archivos: la lista devuelve
  // todos los documentos de la sesión.
  it('returns every session document without a batch cap', async () => {
    const createdAt = Date.now()
    mockMutation.mockResolvedValueOnce({
      authenticated: true,
      documents: Array.from({ length: 21 }, (_, index) => ({
        id: `intake_document_${index + 1}`,
        displayName: `Financials-${index + 1}.pdf`,
        declaredMimeType: 'application/pdf',
        byteSize: 1024,
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt,
      })),
    })
    const response = await listDocuments(authorizedRequest('/api/intake/documents', 'GET'))

    expect(response.status).toBe(200)
    expect((await response.json()).documents).toHaveLength(21)
  })
})
