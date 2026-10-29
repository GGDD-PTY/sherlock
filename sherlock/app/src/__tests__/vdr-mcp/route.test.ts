// ============================================================================
// VDR READ MCP — route gate, PRM and Streamable HTTP boundary
// ============================================================================

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as prmRoute from '../../app/.well-known/oauth-protected-resource/api/vdr-mcp/route'
import * as rootPrmRoute from '../../app/.well-known/oauth-protected-resource/route'
import * as mcpRoute from '../../app/api/vdr-mcp/route'
import type { McpOAuthPrincipal } from '@/lib/mcp-shared/oauth-core'
import { VDR_MCP_PROTOCOL_VERSION } from '@/lib/vdr-mcp/config'
import { createVdrMcpPostHandler } from '@/lib/vdr-mcp/http'
import { createVdrMcpHandler, type VdrMcpHandler } from '@/lib/vdr-mcp/mcp'
import { VDR_MCP_TOOL_NAMES } from '@/lib/vdr-mcp/oauth'
import type { VdrReadStore } from '@/lib/vdr-mcp/store'

const AUDIENCE = 'https://sherlock.example.test/api/vdr-mcp'
const ISSUER = 'https://issuer.example.test'

const oauthConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: `${ISSUER}/oauth2/jwks`,
  tenantClaim: 'organization_id',
  clientIdClaim: 'client_id',
  scopes: { base: 'openid', write: 'vdr:write' },
}

const principal: McpOAuthPrincipal = {
  issuer: ISSUER,
  audience: AUDIENCE,
  principalId: 'user_01ABC',
  tenantId: 'org_01ABC',
  clientId: 'client_01ABC',
  scopes: ['email', 'offline_access', 'openid', 'profile'],
  expiresAt: Date.now() + 600_000,
}

function stubSurfaceEnv(enabled: boolean) {
  vi.stubEnv('VDR_MCP_ENABLED', enabled ? 'true' : 'false')
  vi.stubEnv('VDR_MCP_OAUTH_AUDIENCE', AUDIENCE)
  vi.stubEnv('MCP_OAUTH_ISSUER', ISSUER)
  vi.stubEnv('MCP_OAUTH_JWKS_URL', `${ISSUER}/oauth2/jwks`)
  vi.stubEnv('MCP_OAUTH_TENANT_CLAIM', 'organization_id')
  vi.stubEnv('MCP_OAUTH_CLIENT_ID_CLAIM', 'client_id')
  vi.stubEnv('VDR_MCP_OAUTH_SCOPE_BASE', 'openid')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud')
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(AUDIENCE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function stubHandler(): VdrMcpHandler {
  return {
    fetch: async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }, { status: 200 }),
    close: async () => undefined,
  }
}

function unusedStore(): VdrReadStore {
  const unreachable = (name: string) => async () => {
    throw new Error(`unreachable in this test: ${name}`)
  }
  return {
    resolveRoom: unreachable('resolveRoom'),
    readVersionBytes: unreachable('readVersionBytes'),
    readTextIndex: unreachable('readTextIndex'),
    writeTextIndex: unreachable('writeTextIndex'),
    recordAudit: unreachable('recordAudit'),
    issueUploadIntent: unreachable('issueUploadIntent'),
    registerUpload: unreachable('registerUpload'),
  }
}

async function readJsonRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const raw = dataLine === undefined ? text : dataLine.slice('data: '.length)
  return JSON.parse(raw) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('VDR read MCP route gate', () => {
  it('hides the surface behind a generic 404 on every verb when disabled', async () => {
    stubSurfaceEnv(false)
    for (const handler of [
      mcpRoute.POST(jsonRequest({})),
      Promise.resolve(mcpRoute.GET()),
      Promise.resolve(mcpRoute.PUT()),
      Promise.resolve(mcpRoute.DELETE()),
      Promise.resolve(mcpRoute.OPTIONS()),
      Promise.resolve(prmRoute.GET()),
      Promise.resolve(prmRoute.POST()),
      Promise.resolve(rootPrmRoute.GET()),
      Promise.resolve(rootPrmRoute.POST()),
    ]) {
      const response = await handler
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    }
  })

  it('pins the route to the Node runtime', () => {
    expect(mcpRoute.runtime).toBe('nodejs')
  })
})

describe('protected resource metadata', () => {
  it('publishes its own audience, the shared authorization server and its scopes', async () => {
    stubSurfaceEnv(true)
    const response = await prmRoute.GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      resource: AUDIENCE,
      authorization_servers: [ISSUER],
      scopes_supported: ['openid'],
      bearer_methods_supported: ['header'],
    })
  })

  // El cliente MCP pide la PRM raíz antes que la de path, y solo hay un
  // recurso protegido: las dos URLs publican byte por byte el mismo documento.
  it('publishes the same document at the root PRM the client asks for first', async () => {
    stubSurfaceEnv(true)
    const [byPath, root] = await Promise.all([prmRoute.GET(), rootPrmRoute.GET()])

    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('no-store')
    await expect(root.json()).resolves.toEqual(await byPath.json())
  })

  it('refuses an audience that is not exactly the read path', () => {
    expect(() =>
      prmRoute.createVdrProtectedResourceMetadataResponse({
        resource: 'https://sherlock.example.test/api/mcp',
        authorizationServer: ISSUER,
        scopes: oauthConfig.scopes,
      })
    ).toThrow('VDR_MCP_PRM_CONFIG_INVALID')
  })

  it('publishes http loopback resource and issuer when DEV_AUTH is on', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    vi.stubEnv('VDR_MCP_ENABLED', 'true')
    vi.stubEnv('VDR_MCP_OAUTH_AUDIENCE', 'http://localhost:3114/api/vdr-mcp')
    vi.stubEnv('MCP_OAUTH_ISSUER', 'http://localhost:3114/api/dev')
    vi.stubEnv('VDR_MCP_OAUTH_SCOPE_BASE', 'openid')

    const response = await prmRoute.GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      resource: 'http://localhost:3114/api/vdr-mcp',
      authorization_servers: ['http://localhost:3114/api/dev'],
      scopes_supported: ['openid'],
      bearer_methods_supported: ['header'],
    })
  })

  it('still requires https when DEV_AUTH is off', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    expect(() =>
      prmRoute.createVdrProtectedResourceMetadataResponse({
        resource: 'http://localhost:3114/api/vdr-mcp',
        authorizationServer: 'http://localhost:3114/api/dev',
        scopes: oauthConfig.scopes,
      })
    ).toThrow('VDR_MCP_PRM_CONFIG_INVALID')
  })
})

describe('Streamable HTTP boundary', () => {
  let handler: ReturnType<typeof createVdrMcpPostHandler>

  beforeEach(() => {
    handler = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler: stubHandler(),
      verifyBearer: async () => principal,
      rateLimit: async () => ({ success: true, retryAfterSec: 0 }),
      rateLimitByIp: async () => ({ success: true, retryAfterSec: 0 }),
    })
  })

  it('answers no-store on the happy path', async () => {
    const response = await handler(jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a non-JSON content type before reading the body', async () => {
    const response = await handler(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
    )
    expect(response.status).toBe(415)
  })

  it('rejects a cross-origin browser request', async () => {
    const response = await handler(
      jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.test' })
    )
    expect(response.status).toBe(403)
  })

  it('accepts the surface origin itself', async () => {
    const response = await handler(
      jsonRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { origin: 'https://sherlock.example.test' }
      )
    )
    expect(response.status).toBe(200)
  })

  it('enforces 2026-07-28 header agreement', async () => {
    const mismatch = await handler(
      jsonRequest(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sala_resumen' } },
        {
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'modelo_rango',
        }
      )
    )
    expect(mismatch.status).toBe(400)
    await expect(mismatch.json()).resolves.toMatchObject({
      id: 7,
      error: { code: -32020 },
    })

    const agreed = await handler(
      jsonRequest(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sala_resumen' } },
        {
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'sala_resumen',
        }
      )
    )
    expect(agreed.status).toBe(200)
  })

  it('lets tools/list through with the negotiated MCP-Protocol-Version and no mcp-method', async () => {
    const response = await handler(
      jsonRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { 'mcp-protocol-version': VDR_MCP_PROTOCOL_VERSION }
      )
    )
    expect(response.status).toBe(200)
  })

  it('answers 429 with retry-after when the caller is rate limited', async () => {
    const limited = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler: stubHandler(),
      verifyBearer: async () => principal,
      rateLimit: async () => ({ success: false, retryAfterSec: 30 }),
      rateLimitByIp: async () => ({ success: true, retryAfterSec: 0 }),
    })
    const response = await limited(jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
  })

  it('limits by ip before the bearer is verified, so a caller without token cannot force a JWKS fetch', async () => {
    const verifyBearer = vi.fn(async () => principal)
    const limitedIp = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler: stubHandler(),
      verifyBearer,
      rateLimit: async () => ({ success: true, retryAfterSec: 0 }),
      rateLimitByIp: async () => ({ success: false, retryAfterSec: 12 }),
    })
    const response = await limitedIp(
      jsonRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: 'Bearer a.b.c' }
      )
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('12')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(verifyBearer).not.toHaveBeenCalled()
  })

  it('points an unauthenticated caller at the read surface metadata', async () => {
    const { McpOAuthError } = await import('@/lib/mcp-shared/oauth-core')
    const unauthenticated = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler: stubHandler(),
      verifyBearer: async () => {
        throw new McpOAuthError('MCP_BEARER_REQUIRED', 401)
      },
      rateLimitByIp: async () => ({ success: true, retryAfterSec: 0 }),
    })
    const response = await unauthenticated(
      jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      'https://sherlock.example.test/.well-known/oauth-protected-resource/api/vdr-mcp'
    )
  })

  it('never forwards the bearer or cookies into the MCP dispatch', async () => {
    let seen: Request | null = null
    const spying = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler: {
        fetch: async (request) => {
          seen = request
          return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
        },
        close: async () => undefined,
      },
      verifyBearer: async () => principal,
      rateLimit: async () => ({ success: true, retryAfterSec: 0 }),
      rateLimitByIp: async () => ({ success: true, retryAfterSec: 0 }),
    })
    await spying(
      jsonRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: 'Bearer a.b.c', cookie: 'session=abc' }
      )
    )
    expect(seen).not.toBeNull()
    expect((seen as unknown as Request).headers.get('authorization')).toBeNull()
    expect((seen as unknown as Request).headers.get('cookie')).toBeNull()
  })
})

describe('negotiated protocol version through the HTTP boundary', () => {
  it('is the SDK latest, not the 2026-07-28 modern era', () => {
    expect(VDR_MCP_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION)
    expect(VDR_MCP_PROTOCOL_VERSION).not.toBe('2026-07-28')
  })

  it('initialize then tools/list with the negotiated MCP-Protocol-Version', async () => {
    const mcpHandler = createVdrMcpHandler({ store: unusedStore() })
    const handler = createVdrMcpPostHandler({
      oauthConfig,
      mcpHandler,
      verifyBearer: async () => principal,
      rateLimit: async () => ({ success: true, retryAfterSec: 0 }),
      rateLimitByIp: async () => ({ success: true, retryAfterSec: 0 }),
    })
    try {
      const initialized = await handler(
        jsonRequest(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: VDR_MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'sherlock-route-test', version: '0.0.0' },
            },
          },
          { accept: 'application/json, text/event-stream' }
        )
      )
      expect(initialized.status).toBe(200)
      const initBody = await readJsonRpc(initialized)
      const negotiated = (initBody.result as { protocolVersion?: string } | undefined)
        ?.protocolVersion
      expect(negotiated).toBe(VDR_MCP_PROTOCOL_VERSION)

      const listed = await handler(
        jsonRequest(
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          {
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': negotiated ?? '',
          }
        )
      )
      expect(listed.status).toBe(200)
      const listBody = await readJsonRpc(listed)
      const tools = (listBody.result as { tools?: Array<{ name: string }> } | undefined)?.tools
      expect(new Set(tools?.map((tool) => tool.name))).toEqual(new Set(VDR_MCP_TOOL_NAMES))
    } finally {
      await mcpHandler.close()
    }
  })
})
