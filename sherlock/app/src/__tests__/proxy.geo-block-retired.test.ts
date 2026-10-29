// ============================================================================
// PROXY — US GEO-BLOCK STAYS RETIRED ([F] 2026-08-15, PR #303)
// ============================================================================
// #303 removed the production-only HTTP 451 and deleted the tests that used
// to pin it. Compliance is manual; a later change must not resurrect an
// automatic country gate. These cases stay off marketplace catalog paths so
// they do not fight the unpublished-catalog work in open PR #307.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockIntlMiddleware = vi.fn((_request: NextRequest) => {
  const response = NextResponse.next()
  response.headers.set('x-test-intl-middleware', 'hit')
  return response
})

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

const COUNTRY_HEADERS = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'x-country-code',
] as const

const RETIRED_GEO_BLOCK_MARKERS = [
  'shouldRunGeoBlock',
  'createUsBlockedResponse',
  'shouldBlockRequestForUs',
  'x-sherlock-compliance-block',
] as const

function usRequest(path: string, countryHeader: string = 'x-vercel-ip-country', country = 'US') {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { [countryHeader]: country },
  })
}

function collectSourceFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name.startsWith('.')
      ) {
        continue
      }
      collectSourceFiles(fullPath, results)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry.name)) results.push(fullPath)
  }
  return results
}

describe('proxy US geo-block retired', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    mockAuthkit.mockClear()
    delete process.env.BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    delete process.env.SHERLOCK_PUBLIC_SITE_ONLY
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('in production', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production')
    })

    it.each(['/es', '/es/terms', '/es/ayuda', '/es/legal', '/es/vdr-guest'])(
      'does not return 451 for US traffic on durable public path %s',
      async (path) => {
        const { proxy } = await import('@/proxy')

        const response = await proxy(usRequest(path))

        expect(response.status).not.toBe(451)
        expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
        expect(response.status).not.toBe(307)
        expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
      }
    )

    // La cara inglesa se retiró como PRODUCTO ([F] 2026-09-01), no como bloqueo
    // territorial. Un 308 a español es la respuesta correcta; un 451 sobre esa
    // misma ruta sería el geo-block volviendo por la puerta de atrás.
    it.each(['/en', '/en/help'])(
      'retires the English face at %s with a redirect and never a compliance block',
      async (path) => {
        const { proxy } = await import('@/proxy')

        const response = await proxy(usRequest(path))

        expect(response.status).toBe(308)
        expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
      }
    )

    it.each(COUNTRY_HEADERS)('does not resurrect the 451 from the %s header', async (header) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest('/es/ayuda', header))

      expect(response.status).not.toBe(451)
      expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    })

    it.each(['US', 'USA', 'us', ' usa '])(
      'treats country value %s as ordinary traffic, not a perimeter denial',
      async (country) => {
        const { proxy } = await import('@/proxy')

        const response = await proxy(usRequest('/es/ayuda', 'cf-ipcountry', country))

        expect(response.status).not.toBe(451)
        expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
      }
    )

    it('still sends a US visitor on a protected page to AuthKit, not a geo denial', async () => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest('/es/my-company/documents'))

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost:3000/login')
      expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
      expect(mockAuthkit).toHaveBeenCalledTimes(1)
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
    })

    it.each([
      '/api/webhooks/workos',
      '/api/webhooks/workos-directory',
      '/api/admin/vdr-capabilities',
      '/api/documents/upload',
      '/robots.txt',
      '/sitemap.xml',
      '/auth.md',
    ])('never answers %s with 451 for US-hosted callers', async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest(path))

      expect(response.status).not.toBe(451)
      expect(response.headers.get('x-sherlock-compliance-block')).toBeNull()
    })

    it('does not resurrect the 451 when a leaked dev-auth flag reaches a production build', async () => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest('/es/my-company/documents'))

      expect(response.status).not.toBe(451)
      expect(response.status).toBe(307)
      expect(mockAuthkit).toHaveBeenCalledTimes(1)
    })
  })

  describe('outside production', () => {
    it('does not block US traffic in development', async () => {
      vi.stubEnv('NODE_ENV', 'development')
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest('/es/ayuda'))

      expect(response.status).not.toBe(451)
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    })

    it('does not block US traffic in dev-auth mode', async () => {
      vi.stubEnv('NODE_ENV', 'development')
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(usRequest('/es/ayuda'))

      expect(response.status).not.toBe(451)
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    })
  })
})

describe('US geo-block source contract', () => {
  it('keeps the retired helpers and 451 status out of the proxy perimeter', () => {
    const proxySource = readFileSync(join(process.cwd(), 'src/proxy.ts'), 'utf8')

    for (const marker of RETIRED_GEO_BLOCK_MARKERS) {
      expect(proxySource, `proxy.ts must not mention ${marker}`).not.toContain(marker)
    }
    expect(proxySource).not.toMatch(/from\s+['"]@\/lib\/compliance\/us-gate['"]/)
    expect(proxySource).not.toMatch(/\bstatus\s*:\s*451\b/)
    expect(proxySource).not.toMatch(/\b451\b/)
  })

  it('does not re-wire shouldBlockRequestForUs into any production request path', () => {
    const srcRoot = join(process.cwd(), 'src')
    const violations = collectSourceFiles(srcRoot)
      .filter((file) => !file.endsWith(`${join('lib', 'compliance', 'us-gate.ts')}`))
      .filter((file) => readFileSync(file, 'utf8').includes('shouldBlockRequestForUs'))
      .map((file) => file.slice(srcRoot.length + 1).replaceAll('\\', '/'))

    expect(violations).toEqual([])
  })

  it('does not keep an e2e pin that expects the retired 451', () => {
    const e2eRoot = join(process.cwd(), 'e2e')
    const hits = collectSourceFiles(e2eRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      if (
        source.includes('x-sherlock-compliance-block') ||
        source.includes('shouldRunGeoBlock') ||
        /\.toBe\(\s*451\s*\)/.test(source)
      ) {
        return [file.slice(e2eRoot.length + 1).replaceAll('\\', '/')]
      }
      return []
    })

    expect(hits).toEqual([])
  })
})
