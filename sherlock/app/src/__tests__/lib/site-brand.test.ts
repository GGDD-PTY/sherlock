import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('installation public URL', () => {
  it.each([
    ['https://app.example.com', 'https://app.example.com/api/vdr-mcp'],
    ['https://app.example.com/', 'https://app.example.com/api/vdr-mcp'],
    ['http://localhost:3100', 'http://localhost:3100/api/vdr-mcp'],
  ])('uses configured origin %s for MCP and metadata', async (appUrl, expected) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
    vi.resetModules()
    const brand = await import('@/lib/site/brand')
    expect(brand.getPublicVdrMcpUrl()).toBe(expected)
    const metadata = brand.buildLocalizedPageMetadata({
      locale: 'es',
      path: 'ayuda',
      title: 'Ayuda',
      description: 'Ayuda',
      imageAlt: 'Ayuda',
    })
    expect(metadata.alternates?.canonical).toBe(`${new URL(appUrl).origin}/es/ayuda`)
  })

  it('uses localhost without configuration only in development or tests', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.resetModules()
    expect((await import('@/lib/site/brand')).getPublicAppUrl()).toBe('http://localhost:3000')
  })

  it.each([
    '',
    'invalid',
    'https://localhost:3000',
    'http://localhost:3000',
    'http://app.example.com',
    'https://app.example.com/path',
    'https://user:pass@app.example.com',
    'https://app.example.com?query=1',
  ])('rejects invalid production origin %s, including during builds', async (appUrl) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
    vi.resetModules()
    await expect(import('@/lib/site/brand')).rejects.toThrow('NEXT_PUBLIC_APP_URL')
  })
})
