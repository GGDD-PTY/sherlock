// The canonical redirect belongs to the configured installation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockIntlMiddleware = vi.fn((_request: NextRequest) => NextResponse.next())

const mockAuthkit = vi.fn(async () => ({
  session: { user: null },
  headers: new Headers(),
  authorizationUrl: 'http://localhost:3000/login',
}))

vi.mock('next-intl/middleware', () => ({
  default: () => mockIntlMiddleware,
}))

vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkit: mockAuthkit,
  partitionAuthkitHeaders: (_request: NextRequest, _headers: Headers) => ({
    requestHeaders: new Headers(),
    responseHeaders: new Headers(),
  }),
  applyResponseHeaders: (response: NextResponse) => response,
}))

function requestFrom(host: string, path: string, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host, ...extraHeaders },
  })
}

describe('proxy canonical host', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    mockAuthkit.mockClear()
    delete process.env.BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    delete process.env.VERCEL_ENV
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('when VERCEL_ENV is production', () => {
    beforeEach(() => {
      vi.stubEnv('VERCEL_ENV', 'production')
      vi.stubEnv('NODE_ENV', 'production')
    })

    it('redirects the Vercel-generated subdomain with 308, preserving path and query', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        requestFrom('sherlock-chi-seven.vercel.app', '/es/ayuda?stage=growth&page=2')
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(
        'https://app.example.com/es/ayuda?stage=growth&page=2'
      )
      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
    })

    it.each([
      'sherlock-git-main-example.vercel.app',
      'sherlock-chi-seven.vercel.app',
      'SHERLOCK-CHI-SEVEN.VERCEL.APP',
    ])('redirects every project host %s under vercel.app', async (host) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(requestFrom(host, '/en/ayuda'))

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://app.example.com/en/ayuda')
    })

    it('does not treat the author domain as an installation alias', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(requestFrom('dev.sherlock.capital', '/es/my-company/documents'))

      expect(response.status).not.toBe(308)
      expect(response.headers.get('location')).not.toBe(
        'https://app.example.com/es/my-company/documents'
      )
    })

    it('canonicaliza antes de cualquier otra evaluación del request', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        requestFrom('sherlock-chi-seven.vercel.app', '/es/my-company/documents', {
          'x-vercel-ip-country': 'US',
        })
      )

      expect(response.status).toBe(308)
      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
    })

    it('uses 308 so POST bodies to APIs and webhooks survive the hop', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        new NextRequest('https://sherlock-chi-seven.vercel.app/api/webhooks/workos', {
          method: 'POST',
          headers: { host: 'sherlock-chi-seven.vercel.app' },
        })
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://app.example.com/api/webhooks/workos')
    })

    it('normalizes host casing and an explicit port before matching', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        new NextRequest('https://project.vercel.app/es/ayuda', {
          headers: { host: 'PROJECT.VERCEL.APP:443' },
        })
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://app.example.com/es/ayuda')
    })

    it('lets the canonical host through untouched', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(requestFrom('app.example.com', '/es/ayuda'))

      expect(response.status).not.toBe(308)
      expect(response.headers.get('location')).not.toBe('https://app.example.com/es/ayuda')
    })

    it('does not redirect a host that merely contains vercel.app mid-string', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(requestFrom('vercel.app.attacker.example', '/es/ayuda'))

      expect(response.status).not.toBe(308)
    })

    it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000'])(
      'never redirects the local host %s',
      async (host) => {
        const { proxy } = await import('@/proxy')

        const response = await proxy(
          new NextRequest(`http://${host}/es/ayuda`, { headers: { host } })
        )

        expect(response.status).not.toBe(308)
      }
    )

    it('does not redirect when the Host header is missing', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest('https://app.example.com/es/ayuda'))

      expect(response.status).not.toBe(308)
    })
  })

  describe('invalid installation URL', () => {
    it.each(['', 'https://localhost:3000', 'https://app.example.com/path'])(
      'does not redirect to invalid configuration %s',
      async (appUrl) => {
        vi.stubEnv('VERCEL_ENV', 'production')
        vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
        const { proxy } = await import('@/proxy')
        const response = await proxy(requestFrom('project.vercel.app', '/es/ayuda'))
        expect(response.status).not.toBe(308)
      }
    )
  })

  describe('outside production', () => {
    it.each(['preview', 'development'])(
      'does not redirect when VERCEL_ENV is %s',
      async (vercelEnv) => {
        vi.stubEnv('VERCEL_ENV', vercelEnv)
        const { proxy } = await import('@/proxy')

        const response = await proxy(requestFrom('sherlock-chi-seven.vercel.app', '/es/ayuda'))

        expect(response.status).not.toBe(308)
      }
    )

    it('does not redirect when VERCEL_ENV is absent', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(requestFrom('dev.sherlock.capital', '/es/ayuda'))

      expect(response.status).not.toBe(308)
    })
  })

  describe('in dev-auth mode', () => {
    it('still canonicalizes in production so both proxies share one perimeter', async () => {
      vi.stubEnv('VERCEL_ENV', 'production')
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        requestFrom('sherlock-chi-seven.vercel.app', '/es/my-company/documents')
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(
        'https://app.example.com/es/my-company/documents'
      )
    })
  })
})
