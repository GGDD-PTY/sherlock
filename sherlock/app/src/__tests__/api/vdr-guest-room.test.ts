import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockMutation = vi.fn()
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

import { GET as getGuestRoom } from '@/app/api/vdr/guest/room/route'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import { getVdrGuestSessionCookieName } from '@/lib/auth/vdr-guest-session'
import { RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'

const SESSION_TOKEN = 's'.repeat(64)
const SERVER_SECRET = 'server-boundary-secret-for-tests-123456789'
const SERVER_AUDIENCE = 'sherlock-test:guest-boundary'

function roomRequest(token = SESSION_TOKEN) {
  return new NextRequest('http://localhost:3000/api/vdr/guest/room', {
    headers: {
      Cookie: `${getVdrGuestSessionCookieName()}=${token}`,
      Origin: 'http://localhost:3000',
      'x-vercel-forwarded-for': '203.0.113.19',
    },
  })
}

describe('public VDR guest room API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnauthenticatedConvex.mockReturnValue({ mutation: mockMutation })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 429 from the room route before calling Convex', async () => {
    mockRateLimit.mockResolvedValue({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 9,
    })

    const response = await getGuestRoom(roomRequest())

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('9')
    expect(mockMutation).not.toHaveBeenCalled()
    expect(mockRateLimit).toHaveBeenCalledWith(
      'vdr-guest-room-read:203.0.113.19',
      RATE_LIMIT_PRESETS.api
    )
  })

  it('returns only the authorized room whitelist with no-store and a token-bound server proof', async () => {
    mockMutation.mockResolvedValue({
      authenticated: true,
      expiresAt: Date.now() + 60_000,
      roomAccessGranted: true,
      requiredGates: [],
      companyId: 'company_secret',
      guestId: 'guest_secret',
      principalKey: 'GUEST:guest_secret',
      room: { title: 'Expansión regional', storageId: 'storage_room_secret' },
      documents: [
        {
          documentId: 'document_secret',
          name: 'Estados financieros.pdf',
          fileType: 'PDF',
          fileSize: 4096,
          folder: 'Finanzas',
          classification: 'CONFIDENTIAL',
          downloadable: false,
          storageId: 'storage_document_secret',
        },
      ],
      documentsTruncated: false,
      downloadDeliveryAvailable: false,
    })

    const response = await getGuestRoom(roomRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body).toMatchObject({
      authenticated: true,
      roomAccessGranted: true,
      requiredGates: [],
      room: { title: 'Expansión regional' },
      documents: [
        {
          name: 'Estados financieros.pdf',
          fileType: 'PDF',
          fileSize: 4096,
          folder: 'Finanzas',
          classification: 'CONFIDENTIAL',
          downloadable: false,
        },
      ],
      documentsTruncated: false,
      downloadDeliveryAvailable: false,
    })
    const serialized = JSON.stringify(body)
    for (const secret of [
      SESSION_TOKEN,
      'company_secret',
      'guest_secret',
      'GUEST:guest_secret',
      'storage_room_secret',
      'storage_document_secret',
      'document_secret',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('serverProof')
    expect(mockRateLimit).toHaveBeenCalledWith(
      'vdr-guest-room-read:203.0.113.19',
      expect.any(Object)
    )

    const mutationArgs = mockMutation.mock.calls[0]?.[1]
    expect(mutationArgs).toMatchObject({
      sessionToken: SESSION_TOKEN,
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(mutationArgs.serverProof).toBe(
      createVdrGuestServerProof({
        operation: 'PROJECT_ROOM',
        bindingParts: [SESSION_TOKEN],
        issuedAt: mutationArgs.serverIssuedAt,
        secret: SERVER_SECRET,
        audience: SERVER_AUDIENCE,
      }).serverProof
    )
  })

  it('preserves a pending gate projection without exposing room data', async () => {
    mockMutation.mockResolvedValue({
      authenticated: true,
      expiresAt: Date.now() + 60_000,
      roomAccessGranted: false,
      requiredGates: ['NDA'],
      room: { title: 'Must not leak' },
      documents: [{ name: 'Must not leak.pdf' }],
    })

    const response = await getGuestRoom(roomRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      authenticated: true,
      roomAccessGranted: false,
      requiredGates: ['NDA'],
    })
    expect(body).not.toHaveProperty('room')
    expect(body).not.toHaveProperty('documents')
  })

  it('fails closed if Convex attempts to project KYC-sensitive metadata into the guest room', async () => {
    mockMutation.mockResolvedValue({
      authenticated: true,
      expiresAt: Date.now() + 60_000,
      roomAccessGranted: true,
      requiredGates: [],
      room: { title: 'Expansión regional' },
      documents: [
        {
          name: 'Pasaporte.pdf',
          folder: 'KYC',
          classification: 'KYC_SENSITIVE',
          downloadable: false,
        },
      ],
      documentsTruncated: false,
      downloadDeliveryAvailable: false,
    })

    const response = await getGuestRoom(roomRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(JSON.stringify(body)).not.toContain('Pasaporte')
    expect(JSON.stringify(body)).not.toContain('KYC_SENSITIVE')
  })

  it('clears the guest cookie and returns no projection when authorization was revoked', async () => {
    mockMutation.mockResolvedValue({ authenticated: false })

    const response = await getGuestRoom(roomRequest())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toMatchObject({ authenticated: false })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body).not.toHaveProperty('room')
    expect(body).not.toHaveProperty('documents')
  })

  it('fails closed before Convex when the cookie or browser origin is invalid', async () => {
    const noCookie = await getGuestRoom(
      new NextRequest('http://localhost:3000/api/vdr/guest/room', {
        headers: { Origin: 'http://localhost:3000' },
      })
    )
    expect(noCookie.status).toBe(401)
    expect(noCookie.headers.get('set-cookie')).toContain('Max-Age=0')

    const crossSite = await getGuestRoom(
      new NextRequest('http://localhost:3000/api/vdr/guest/room', {
        headers: {
          Cookie: `${getVdrGuestSessionCookieName()}=${SESSION_TOKEN}`,
          Origin: 'https://attacker.example',
        },
      })
    )
    expect(crossSite.status).toBe(403)
    expect(mockMutation).not.toHaveBeenCalled()
  })
})
