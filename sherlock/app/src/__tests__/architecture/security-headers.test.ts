// ============================================================================
// SECURITY HEADERS CONTRACT (next.config.ts)
// ============================================================================
// Asserta la respuesta de headers() bajo NODE_ENV=production — lo que sirve
// prod de verdad — en vez de leer el código o depender del lane E2E (que corre
// contra dev, donde HSTS no se emite y la CSP permite unsafe-eval). isDev se
// evalúa DENTRO de headers() en runtime, así que vi.stubEnv basta sin
// resetModules. Cubre ambas direcciones del gate: prod endurecido y dev sin
// HSTS (para no romper next dev sobre http).
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import nextConfig from '../../../next.config'

type HeaderEntry = { key: string; value: string }
type HeaderBlock = { source: string; headers: HeaderEntry[] }

const getHeaders = async () =>
  (await (nextConfig as { headers?: () => Promise<HeaderBlock[]> }).headers!()) as HeaderBlock[]

const getHeader = (block: HeaderBlock | undefined, key: string) =>
  block?.headers.find((h) => h.key === key)?.value

// Fuera del test para que `vitest/no-conditional-in-test` no cuente el `??`.
const imgSrcDirective = (csp: string | undefined) =>
  (csp ?? '').split('; ').find((directive) => directive.startsWith('img-src '))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('security headers under NODE_ENV=production', () => {
  it('emite hsts de 1 año con includeSubDomains y preload en todas las rutas', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const global = (await getHeaders()).find((b) => b.source === '/(.*)')

    expect(getHeader(global, 'Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload'
    )
  })

  it('la csp de prod no permite unsafe-eval', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const global = (await getHeaders()).find((b) => b.source === '/(.*)')

    const csp = getHeader(global, 'Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain("default-src 'self'")
  })

  it('mantiene clickjacking y mime-sniffing cerrados en prod', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const global = (await getHeaders()).find((b) => b.source === '/(.*)')

    expect(getHeader(global, 'X-Frame-Options')).toBe('DENY')
    expect(getHeader(global, 'X-Content-Type-Options')).toBe('nosniff')
    expect(getHeader(global, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  // A14-S2: el banner `x-powered-by: Next.js` no vuelve.
  it('no anuncia el framework en x-powered-by', () => {
    expect((nextConfig as { poweredByHeader?: boolean }).poweredByHeader).toBe(false)
  })

  // A14-S4: los orígenes de imagen del marketplace (Financial Modeling Prep,
  // Clearbit, Unsplash) no tienen caller en `src`; ni la CSP ni `/_next/image`
  // los vuelven a abrir.
  it('solo abre imágenes remotas de Convex', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const global = (await getHeaders()).find((b) => b.source === '/(.*)')

    expect(imgSrcDirective(getHeader(global, 'Content-Security-Policy'))).toBe(
      "img-src 'self' data: blob: https://*.convex.cloud https://*.workos.com https://*.workoscdn.com"
    )

    // El patrón entero, no solo el host: un `http` o un `pathname` más amplio
    // también ensancharían `/_next/image`.
    expect(
      (nextConfig as { images?: { remotePatterns?: unknown } }).images?.remotePatterns
    ).toEqual([{ protocol: 'https', hostname: '*.convex.cloud', pathname: '/api/storage/**' }])
  })
})

describe('security headers under NODE_ENV=development', () => {
  it('no emite hsts en dev (next dev corre sobre http) y sí permite unsafe-eval', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const global = (await getHeaders()).find((b) => b.source === '/(.*)')

    expect(getHeader(global, 'Strict-Transport-Security')).toBeUndefined()
    expect(getHeader(global, 'Content-Security-Policy')).toContain("'unsafe-eval'")
  })
})
