// ============================================================================
// CSP + BACKEND CONVEX LOCAL (`bun run dev:local`)
// ============================================================================
// El backend local vive en http://127.0.0.1:3210 y su WebSocket de sync en
// ws://127.0.0.1:3210. La CSP los suma SOLO en dev y SOLO con un host de
// loopback; con una URL de la nube, o en producción, la cadena que sale de
// `headers()` es byte por byte la misma que sin la variable. Se prueba el
// helper puro y la CSP real que emite `next.config.ts`.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import nextConfig from '../../../../next.config'
import { localConvexCspOrigins, withCspOrigins } from '@/lib/security/local-convex-csp'

type HeaderEntry = { key: string; value: string }
type HeaderBlock = { source: string; headers: HeaderEntry[] }

const LOCAL_URL = 'http://127.0.0.1:3210'
const LOCAL_SITE_URL = 'http://127.0.0.1:3211'
const CLOUD_URL = 'https://brainy-emu-822.convex.cloud'

async function cspFor(env: {
  NODE_ENV: string
  NEXT_PUBLIC_CONVEX_URL: string
  NEXT_PUBLIC_CONVEX_SITE_URL?: string
}): Promise<string> {
  vi.stubEnv('NODE_ENV', env.NODE_ENV)
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', env.NEXT_PUBLIC_CONVEX_URL)
  vi.stubEnv('NEXT_PUBLIC_CONVEX_SITE_URL', env.NEXT_PUBLIC_CONVEX_SITE_URL ?? '')
  vi.stubEnv('CONVEX_SITE_URL', '')
  const blocks = (await (nextConfig as { headers?: () => Promise<HeaderBlock[]> })
    .headers!()) as HeaderBlock[]
  const global = blocks.find((block) => block.source === '/(.*)')
  const csp = global?.headers.find((header) => header.key === 'Content-Security-Policy')?.value
  if (!csp) throw new Error('CSP global ausente')
  return csp
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
  if (!found) throw new Error(`directiva ${name} ausente`)
  return found
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('localConvexCspOrigins', () => {
  it('con URL local y dev devuelve http + ws del backend y del site URL', () => {
    expect(
      localConvexCspOrigins({ isDev: true, convexUrl: LOCAL_URL, convexSiteUrl: LOCAL_SITE_URL })
    ).toEqual({
      connectSrc: [
        'http://127.0.0.1:3210',
        'ws://127.0.0.1:3210',
        'http://127.0.0.1:3211',
        'ws://127.0.0.1:3211',
      ],
      imgSrc: ['http://127.0.0.1:3210'],
    })
  })

  it('acepta localhost y omite el site URL cuando no está definido', () => {
    expect(
      localConvexCspOrigins({
        isDev: true,
        convexUrl: 'http://localhost:3210',
        convexSiteUrl: undefined,
      })
    ).toEqual({
      connectSrc: ['http://localhost:3210', 'ws://localhost:3210'],
      imgSrc: ['http://localhost:3210'],
    })
  })

  it.each([
    ['URL de la nube en dev', { isDev: true, convexUrl: CLOUD_URL, convexSiteUrl: undefined }],
    [
      'URL local fuera de dev',
      { isDev: false, convexUrl: LOCAL_URL, convexSiteUrl: LOCAL_SITE_URL },
    ],
    ['sin URL', { isDev: true, convexUrl: undefined, convexSiteUrl: undefined }],
    ['URL inválida', { isDev: true, convexUrl: 'no-es-una-url', convexSiteUrl: undefined }],
    // Un host que no es loopback nunca entra aunque sea http: la CSP de dev no
    // se abre a la LAN por una variable mal puesta.
    [
      'http a un host de la red',
      { isDev: true, convexUrl: 'http://192.168.1.10:3210', convexSiteUrl: undefined },
    ],
  ])('no suma nada: %s', (_, args) => {
    expect(localConvexCspOrigins(args)).toEqual({ connectSrc: [], imgSrc: [] })
  })

  it('withCspOrigins deja la directiva intacta con la lista vacía', () => {
    expect(withCspOrigins("connect-src 'self'", [])).toBe("connect-src 'self'")
    expect(withCspOrigins("connect-src 'self'", ['http://127.0.0.1:3210'])).toBe(
      "connect-src 'self' http://127.0.0.1:3210"
    )
  })
})

describe('CSP emitida por next.config.ts', () => {
  it('en dev con backend local, connect-src trae http y ws de 127.0.0.1:3210', async () => {
    const csp = await cspFor({
      NODE_ENV: 'development',
      NEXT_PUBLIC_CONVEX_URL: LOCAL_URL,
      NEXT_PUBLIC_CONVEX_SITE_URL: LOCAL_SITE_URL,
    })
    const connect = directive(csp, 'connect-src')
    expect(connect).toContain('http://127.0.0.1:3210')
    expect(connect).toContain('ws://127.0.0.1:3210')
    expect(connect).toContain('http://127.0.0.1:3211')
    expect(connect).toContain('ws://127.0.0.1:3211')
    // La nube sigue permitida: el mismo bundle sirve para las dos cosas.
    expect(connect).toContain('wss://*.convex.cloud')
    expect(directive(csp, 'img-src')).toContain('http://127.0.0.1:3210')
    expect(directive(csp, 'img-src')).not.toContain('3211')
  })

  it('en dev con URL de la nube la cadena es idéntica a la de siempre', async () => {
    const cloud = await cspFor({ NODE_ENV: 'development', NEXT_PUBLIC_CONVEX_URL: CLOUD_URL })
    expect(cloud).not.toContain('127.0.0.1')
    expect(cloud).not.toContain('ws://')
    expect(cloud).not.toMatch(/ {2}/)
  })

  it('en producción una URL local no cambia ni un byte', async () => {
    const withCloud = await cspFor({ NODE_ENV: 'production', NEXT_PUBLIC_CONVEX_URL: CLOUD_URL })
    const withLocal = await cspFor({
      NODE_ENV: 'production',
      NEXT_PUBLIC_CONVEX_URL: LOCAL_URL,
      NEXT_PUBLIC_CONVEX_SITE_URL: LOCAL_SITE_URL,
    })
    expect(withLocal).toBe(withCloud)
    expect(withLocal).not.toContain('127.0.0.1')
  })
})
