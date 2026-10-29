import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PDFDocument } from 'pdf-lib'
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn(async () => ({ success: true })),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: { api: {}, auth: {} },
  createRateLimitResponse: () => new Response(null, { status: 429 }),
}))
import { GET } from '@/app/api/vdr/guest/documents/[documentId]/route'
import { getVdrGuestSessionCookieName } from '@/lib/auth/vdr-guest-session'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import {
  encodeCompanyGuestDocumentMetadata,
  GUEST_DOCUMENT_METADATA_HEADER,
} from '@/../convex/_guests/documentDelivery'

const token = 's'.repeat(64)
const params = { params: Promise.resolve({ documentId: 'doc_selected' }) }
const request = (cookie = true, origin = 'http://localhost:3000') =>
  new NextRequest('http://localhost:3000/api/vdr/guest/documents/doc_selected', {
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: `${getVdrGuestSessionCookieName()}=${token}` } : {}),
    },
  })

const metadata = {
  documentId: 'doc_selected',
  versionId: 'version_selected',
  invitationId: 'invitation_1',
  guestLabel: 'g***t@example.com',
  fileName: 'Estados financieros.pdf',
}

// Un solo PDF para toda la prueba: `PDFDocument.create()` fecha el documento y dos
// creaciones seguidas pueden diferir en un byte, lo que ponía rojo el byteLength.
let sourcePdfBytes: Uint8Array | undefined
async function sourcePdf(): Promise<Uint8Array> {
  if (!sourcePdfBytes) {
    const document = await PDFDocument.create()
    document.addPage([300, 300])
    sourcePdfBytes = await document.save()
  }
  return sourcePdfBytes
}

async function convexResponse(body?: BodyInit) {
  return new Response(body ?? (await sourcePdf()).slice(), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      [GUEST_DOCUMENT_METADATA_HEADER]: encodeCompanyGuestDocumentMetadata(metadata),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VDR_GUEST_SERVER_SECRET', 'server-boundary-secret-for-tests-123456789')
  vi.stubEnv('VDR_GUEST_SERVER_AUDIENCE', 'sherlock-test:guest-boundary')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://brainy-emu-822.convex.cloud')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('serves the original bytes, with a session/document-bound proof', async () => {
  const fetchSpy = vi.fn(async () => convexResponse())
  vi.stubGlobal('fetch', fetchSpy)

  const response = await GET(request(), params)

  expect(response.status).toBe(200)
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('content-disposition')).toContain('inline')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-type')).toBe('application/pdf')
  const delivered = await response.arrayBuffer()
  expect(await PDFDocument.load(delivered).then((pdf) => pdf.getPageCount())).toBe(1)
  expect(delivered.byteLength).toBe((await sourcePdf()).byteLength)

  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://brainy-emu-822.convex.site/vdr/guest/document')
  expect(init.method).toBe('POST')
  const body = JSON.parse(String(init.body))
  expect(body).toMatchObject({
    sessionToken: token,
    documentId: 'doc_selected',
    ...createVdrGuestServerProof({
      operation: 'VIEW_DOCUMENT',
      bindingParts: [token, 'doc_selected'],
      issuedAt: body.serverIssuedAt,
    }),
  })
})

it('never sends the guest an upstream storage URL, even on a redirect answer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example.com/private' },
        })
    )
  )

  const response = await GET(request(), params)

  expect(response.status).toBe(403)
  expect(response.headers.get('location')).toBeNull()
  expect(await response.text()).not.toContain('storage.example.com')
})

it('denies an empty, path-like or oversized document id before reaching the deployment', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)

  for (const documentId of [
    '',
    '../doc_selected',
    'doc selected',
    'x'.repeat(129),
    'doc/selected',
  ]) {
    expect((await GET(request(), { params: Promise.resolve({ documentId }) })).status).toBe(403)
  }
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('denies absent cookies and foreign origins before reaching Convex', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)

  expect((await GET(request(false), params)).status).toBe(401)
  expect((await GET(request(true, 'https://evil.example'), params)).status).toBe(403)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('denies backend revocation without exposing internal errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('revoked storage.example.com/private', { status: 403 }))
  )

  const response = await GET(request(), params)

  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('storage.example.com')
})

it('fails closed when the deployment origin cannot be derived', async () => {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://evil.example')
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)

  expect((await GET(request(), params)).status).toBe(503)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('does not report a denial when the deployment is unreachable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
  )

  expect((await GET(request(), params)).status).toBe(502)
})

it('fails closed when Convex answers 200 without usable document metadata', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('%PDF-1.7', { status: 200 }))
  )

  expect((await GET(request(), params)).status).toBe(502)
})
