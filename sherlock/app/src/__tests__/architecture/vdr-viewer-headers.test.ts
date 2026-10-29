import { describe, expect, it } from 'vitest'

import nextConfig from '../../../next.config'

type HeaderEntry = { key: string; value: string }
type HeaderBlock = { source: string; headers: HeaderEntry[] }

const getHeader = (block: HeaderBlock | undefined, key: string) =>
  block?.headers.find((h) => h.key === key)?.value

describe('vdr inline viewer security headers', () => {
  it('la ruta del grant emite el csp completo con frame-ancestors self, no un csp mutilado', async () => {
    const blocks = (await (nextConfig as { headers?: () => Promise<HeaderBlock[]> })
      .headers!()) as HeaderBlock[]

    const viewer = blocks.find((b) => b.source === '/api/documents/access/:grantId')
    expect(viewer).toBeDefined()

    const csp = getHeader(viewer, 'Content-Security-Policy')
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).not.toContain("frame-ancestors 'none'")
    // Next hace last-wins por header key: si esta ruta emitiera solo
    // frame-ancestors, perdería todas las directivas endurecidas del bloque
    // global. El CSP de la ruta debe conservarlas.
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")

    expect(getHeader(viewer, 'X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('el resto del sitio conserva deny y frame-ancestors none', async () => {
    const blocks = (await (nextConfig as { headers?: () => Promise<HeaderBlock[]> })
      .headers!()) as HeaderBlock[]

    const global = blocks.find((b) => b.source === '/(.*)')
    expect(getHeader(global, 'Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(getHeader(global, 'X-Frame-Options')).toBe('DENY')
  })
})
