// ============================================================================
// VDR READ MCP — bearer audience and scope isolation
// ============================================================================
// One resource server, one authorization server. A token minted for any other
// audience is inert here, and the surface never dispatches a verb outside its
// read allowlist — the retired Mycroft bridge verbs included ([F] 2026-09-06).
// ============================================================================

import { generateKeyPairSync, sign } from 'node:crypto'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runServerEffect } from '@/lib/effect/runtime'
import { McpOAuthError, readBoundedJsonBody } from '@/lib/mcp-shared/oauth-core'
import {
  scopeDemandForVdrMcpBody,
  verifyVdrMcpBearer,
  verifyVdrMcpBearerEffect,
  VDR_MCP_ROLE_CLAIM,
  VDR_MCP_WRITE_ROLES,
  type VdrMcpOAuthConfig,
} from '@/lib/vdr-mcp/oauth'

// Scopes and audience of the Mycroft bridge that used to share this issuer.
// They stay as fixtures only so the read surface keeps refusing them.
const FOREIGN_SCOPES = { base: 'mcp:connect', runRead: 'model-runs:read' }
const FOREIGN_AUDIENCE = 'https://sherlock.example.test/api/mcp'

const VDR_SCOPES = {
  base: 'openid',
  write: 'vdr:write',
}

const ROLES_SIN_ESCRITURA: ReadonlyArray<{ caso: string; overrides: Record<string, unknown> }> = [
  { caso: 'un rol sin escritura', overrides: { [VDR_MCP_ROLE_CLAIM]: 'member' } },
  { caso: 'ningún claim de rol', overrides: {} },
  {
    caso: 'un claim de rol que no es string',
    overrides: { [VDR_MCP_ROLE_CLAIM]: ['company_owner'] },
  },
]

const NON_USER_SUBJECTS = [
  'client_01NOTAHUMAN',
  'org_01NOTAHUMAN',
  'agent_01NOTAHUMAN',
  'generic-principal',
] as const

const ISSUER = 'https://issuer.example.test'
const decodeAbortSignal = Schema.decodeUnknownSync(Schema.instanceOf(AbortSignal))

const vdrConfig = {
  issuer: ISSUER,
  audience: 'https://sherlock.example.test/api/vdr-mcp',
  jwksUri: `${ISSUER}/oauth2/jwks`,
  tenantClaim: 'organization_id',
  clientIdClaim: 'client_id',
  scopes: VDR_SCOPES,
}

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'key-1',
  alg: 'RS256',
  use: 'sig',
}
const NOW_SECONDS = 2_000_000_000

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function mintToken(
  audience: string,
  scopes: string[],
  overrides: Record<string, unknown> = {},
  kid = 'key-1',
  issuer = ISSUER
): string {
  const header = encodeJson({ alg: 'RS256', kid, typ: 'JWT' })
  const payload = encodeJson({
    iss: issuer,
    aud: audience,
    sub: 'user_01ABC',
    organization_id: 'org_01ABC',
    client_id: 'client_01ABC',
    scope: scopes.join(' '),
    iat: NOW_SECONDS - 10,
    nbf: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 600,
    ...overrides,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), pair.privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

function jwksFetch() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  )
}

function request(url: string, token: string): Request {
  return new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
}

const dependencies = () => ({ fetch: jwksFetch(), nowMs: () => NOW_SECONDS * 1_000 })

const toolsCall = (name: string) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: {} },
})

describe('VDR read MCP scope map', () => {
  it('uses the provider-supported identity scope for every allowlisted read tool', () => {
    // `VDR_MCP_OAUTH_SCOPE_BASE` ya es `openid`, así que esta superficie no
    // necesita una alternativa: `sufficient` queda vacío ([F] 2026-09-03).
    expect(scopeDemandForVdrMcpBody(toolsCall('sala_documentos'), VDR_SCOPES)).toEqual({
      required: [VDR_SCOPES.base],
      sufficient: [],
    })
    expect(scopeDemandForVdrMcpBody(toolsCall('modelo_rango'), VDR_SCOPES)).toEqual({
      required: [VDR_SCOPES.base],
      sufficient: [],
    })
    expect(
      scopeDemandForVdrMcpBody({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, VDR_SCOPES)
    ).toEqual({ required: [VDR_SCOPES.base], sufficient: [] })
  })

  it('refuses every retired bridge verb before dispatch', () => {
    for (const name of [
      'prepare_financial_model',
      'get_financial_model_run',
      'list_model_run_disclosures',
      'get_authorized_model_artifact',
    ]) {
      expect(() => scopeDemandForVdrMcpBody(toolsCall(name), VDR_SCOPES)).toThrowError(
        'MCP_OPERATION_DENIED'
      )
    }
    expect(() =>
      scopeDemandForVdrMcpBody(
        { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'sm-artifact://v1/x' } },
        VDR_SCOPES
      )
    ).toThrowError('MCP_OPERATION_DENIED')
  })

  it('exige openid y vdr:write para documento_subir y documento_confirmar', () => {
    expect(scopeDemandForVdrMcpBody(toolsCall('documento_subir'), VDR_SCOPES)).toEqual({
      required: [VDR_SCOPES.base, VDR_SCOPES.write],
      sufficient: [],
    })
    expect(scopeDemandForVdrMcpBody(toolsCall('documento_confirmar'), VDR_SCOPES)).toEqual({
      required: [VDR_SCOPES.base, VDR_SCOPES.write],
      sufficient: [],
    })
  })
})

describe('OAuth Effect compatibility', () => {
  it('retains the positional McpOAuthError contract for imperative HTTP callers', () => {
    const error = new McpOAuthError('MCP_SCOPE_INSUFFICIENT', 403)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      _tag: 'McpOAuthError',
      name: 'McpOAuthError',
      message: 'MCP_SCOPE_INSUFFICIENT',
      code: 'MCP_SCOPE_INSUFFICIENT',
      status: 403,
    })
  })

  it('keeps bounded JSON body reads behind the Promise adapter', async () => {
    const oversized = new Request('https://sherlock.example.test/api/vdr-mcp', {
      method: 'POST',
      headers: { 'content-length': '65' },
      body: 'x'.repeat(65),
    })

    await expect(readBoundedJsonBody(oversized, 64)).rejects.toMatchObject({
      _tag: 'McpOAuthError',
      code: 'MCP_BODY_TOO_LARGE',
      status: 413,
    })
  })

  it('exposes an Effect-native verifier without changing the Promise result', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base])
    const principal = await runServerEffect(
      verifyVdrMcpBearerEffect(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('sala_documentos'),
        vdrConfig,
        dependencies()
      )
    )

    expect(principal.principalId).toBe('user_01ABC')
  })
})

describe('bearer audience isolation', () => {
  it('accepts a correctly scoped read token on the read surface', async () => {
    const token = mintToken(vdrConfig.audience, [
      'email',
      'offline_access',
      VDR_SCOPES.base,
      'profile',
    ])
    const principal = await verifyVdrMcpBearer(
      request('https://sherlock.example.test/api/vdr-mcp', token),
      toolsCall('sala_documentos'),
      vdrConfig,
      dependencies()
    )
    expect(principal.principalId).toBe('user_01ABC')
    expect(principal.audience).toBe(vdrConfig.audience)
  })

  it('authorizes a claimed agent token as its human actor on the VDR audience', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], {
      sub: 'agent_reg_01VDRAGENT',
      act: { sub: 'user_01VDRACTOR' },
    })
    const principal = await verifyVdrMcpBearer(
      request('https://sherlock.example.test/api/vdr-mcp', token),
      toolsCall('sala_documentos'),
      vdrConfig,
      dependencies()
    )

    expect(principal.principalId).toBe('user_01VDRACTOR')
    expect(principal.clientId).toBe('client_01ABC')
    expect(principal.audience).toBe(vdrConfig.audience)
  })

  it.each(NON_USER_SUBJECTS)(
    'rejects a direct VDR token whose sub is not a WorkOS user: %s',
    async (subject) => {
      const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], { sub: subject })

      await expect(
        verifyVdrMcpBearer(
          request('https://sherlock.example.test/api/vdr-mcp', token),
          toolsCall('sala_documentos'),
          vdrConfig,
          dependencies()
        )
      ).rejects.toThrowError('MCP_TOKEN_CLAIMS_INVALID')
    }
  )

  it.each(NON_USER_SUBJECTS)(
    'rejects a delegated VDR token whose act.sub is not a WorkOS user: %s',
    async (actorSub) => {
      const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], {
        sub: 'agent_reg_01VDRAGENT',
        act: { sub: actorSub },
      })

      await expect(
        verifyVdrMcpBearer(
          request('https://sherlock.example.test/api/vdr-mcp', token),
          toolsCall('sala_documentos'),
          vdrConfig,
          dependencies()
        )
      ).rejects.toThrowError('MCP_TOKEN_CLAIMS_INVALID')
    }
  )

  it('rejects a multi-resource audience on VDR even when it includes both scopes', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base, FOREIGN_SCOPES.base], {
      aud: [vdrConfig.audience, FOREIGN_AUDIENCE],
    })

    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('sala_documentos'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_TOKEN_AUDIENCE_INVALID')
  })

  it('rejects a token minted for another audience on the read surface', async () => {
    const token = mintToken(FOREIGN_AUDIENCE, [
      FOREIGN_SCOPES.base,
      FOREIGN_SCOPES.runRead,
      VDR_SCOPES.base,
    ])
    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('sala_documentos'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_TOKEN_AUDIENCE_INVALID')
  })

  it('rejects a claimed agent token minted for another audience', async () => {
    const foreignAgent = mintToken(FOREIGN_AUDIENCE, [FOREIGN_SCOPES.base, VDR_SCOPES.base], {
      sub: 'agent_reg_01MODELAGENT',
      act: { sub: 'user_01MODELHUMAN' },
    })

    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', foreignAgent),
        toolsCall('sala_documentos'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_TOKEN_AUDIENCE_INVALID')
  })

  it('rejects documento_subir when the bearer only has openid', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base])
    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('documento_subir'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_SCOPE_INSUFFICIENT')
  })

  it('accepts documento_subir when the bearer has openid and vdr:write', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base, VDR_SCOPES.write])
    const principal = await verifyVdrMcpBearer(
      request('https://sherlock.example.test/api/vdr-mcp', token),
      toolsCall('documento_subir'),
      vdrConfig,
      dependencies()
    )
    expect(principal.principalId).toBe('user_01ABC')
    expect(principal.scopes).toEqual([VDR_SCOPES.base, VDR_SCOPES.write])
  })

  // ==========================================================================
  // ESCRITURA POR ROL (O4-06b)
  // ==========================================================================
  // AuthKit no le da `vdr:write` a un cliente MCP: medido contra prod el
  // 2026-09-12, el token real trae `scope` = `offline_access openid` y
  // `sherlock_role` = `company_owner`. El servidor concede la escritura con
  // ese claim verificado y la deja en `principal.scopes` para la auditoría.
  // ==========================================================================

  it.each(VDR_MCP_WRITE_ROLES)(
    'concede la escritura a un token openid cuyo rol es %s',
    async (role) => {
      const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], {
        [VDR_MCP_ROLE_CLAIM]: role,
      })
      const principal = await verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('documento_subir'),
        vdrConfig,
        dependencies()
      )

      expect(principal.principalId).toBe('user_01ABC')
      expect(principal.scopes).toEqual([VDR_SCOPES.base, VDR_SCOPES.write])
    }
  )

  it.each(ROLES_SIN_ESCRITURA)('niega documento_subir con $caso', async ({ overrides }) => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], overrides)
    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('documento_subir'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_SCOPE_INSUFFICIENT')
  })

  it('no duplica vdr:write cuando el token trae el scope y el rol', async () => {
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base, VDR_SCOPES.write], {
      [VDR_MCP_ROLE_CLAIM]: 'company_owner',
    })
    const principal = await verifyVdrMcpBearer(
      request('https://sherlock.example.test/api/vdr-mcp', token),
      toolsCall('documento_subir'),
      vdrConfig,
      dependencies()
    )

    expect(principal.scopes).toEqual([VDR_SCOPES.base, VDR_SCOPES.write])
  })

  it('rejects a read token that lacks the provider-supported identity scope', async () => {
    const token = mintToken(vdrConfig.audience, ['email', 'profile'])
    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', token),
        toolsCall('modelo_rango'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrowError('MCP_SCOPE_INSUFFICIENT')
  })

  it('refuses a read config whose audience is not the read path', async () => {
    const token = mintToken(FOREIGN_AUDIENCE, [VDR_SCOPES.base])
    await expect(
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/mcp', token),
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { ...vdrConfig, audience: FOREIGN_AUDIENCE },
        dependencies()
      )
    ).rejects.toThrowError('MCP_OAUTH_CONFIG_INVALID')
  })
})

describe('JWKS cache and concurrency', () => {
  const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base])
  const verifyWith = (fetch: typeof globalThis.fetch, config: VdrMcpOAuthConfig = vdrConfig) =>
    verifyVdrMcpBearer(
      request('https://sherlock.example.test/api/vdr-mcp', token),
      toolsCall('sala_documentos'),
      config,
      { fetch, nowMs: () => NOW_SECONDS * 1_000 }
    )

  it('reuses a successful verification key for the same fetch boundary and kid', async () => {
    const fetch = jwksFetch()

    await verifyWith(fetch)
    await verifyWith(fetch)

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight JWKS lookup across concurrent bearer checks', async () => {
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetch = vi.fn(async () => {
      await fetchGate
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const first = verifyWith(fetch)
    const second = verifyWith(fetch)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    releaseFetch()

    const [firstPrincipal, secondPrincipal] = await Promise.all([first, second])
    expect(firstPrincipal).toEqual(secondPrincipal)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('remembers an unknown kid for 30 s instead of fetching the JWKS again for every token', async () => {
    const fetch = jwksFetch()
    const unknownKid = mintToken(vdrConfig.audience, [VDR_SCOPES.base], {}, 'key-invented')
    const verify = () =>
      verifyVdrMcpBearer(
        request('https://sherlock.example.test/api/vdr-mcp', unknownKid),
        toolsCall('sala_documentos'),
        vdrConfig,
        { fetch, nowMs: () => NOW_SECONDS * 1_000 }
      )
    const notFound = { code: 'MCP_JWKS_KEY_NOT_FOUND', status: 401 }

    // La caché expira con el reloj de pared del runtime; el `nowMs` inyectado
    // solo gobierna las claims del token.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await expect(verify()).rejects.toMatchObject(notFound)
      await expect(verify()).rejects.toMatchObject(notFound)
      vi.setSystemTime(Date.now() + 29_000)
      await expect(verify()).rejects.toMatchObject(notFound)
      expect(fetch).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 2_000)
      await expect(verify()).rejects.toMatchObject(notFound)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache a failed JWKS lookup', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

    await expect(verifyWith(fetch)).rejects.toMatchObject({
      code: 'MCP_JWKS_UNAVAILABLE',
      status: 502,
    })
    await expect(verifyWith(fetch)).resolves.toMatchObject({ principalId: 'user_01ABC' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('times out the complete JWKS exchange and aborts the injected fetch', async () => {
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = decodeAbortSignal(init?.signal)
          observedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )

    await expect(verifyWith(fetch, { ...vdrConfig, jwksTimeoutMs: 10 })).rejects.toMatchObject({
      code: 'MCP_JWKS_UNAVAILABLE',
      status: 502,
    })
    expect(decodeAbortSignal(observedSignal).aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

const LOCAL_ISSUER = 'http://localhost:3114/api/dev'
const LOCAL_AUDIENCE = 'http://localhost:3114/api/vdr-mcp'
const localConfig: VdrMcpOAuthConfig = {
  issuer: LOCAL_ISSUER,
  audience: LOCAL_AUDIENCE,
  jwksUri: `${LOCAL_ISSUER}/jwks`,
  tenantClaim: 'organization_id',
  clientIdClaim: 'client_id',
  scopes: VDR_SCOPES,
}

describe('loopback HTTP OAuth config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts http://localhost issuer, audience and JWKS', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const token = mintToken(LOCAL_AUDIENCE, [VDR_SCOPES.base], {}, 'key-1', LOCAL_ISSUER)
    const principal = await verifyVdrMcpBearer(
      request(LOCAL_AUDIENCE, token),
      toolsCall('sala_documentos'),
      localConfig,
      dependencies()
    )
    expect(principal.principalId).toBe('user_01ABC')
    expect(principal.issuer).toBe(LOCAL_ISSUER)
  })

  it('accepts http://127.0.0.1 issuer, audience and JWKS', async () => {
    const issuer = 'http://127.0.0.1:3114/api/dev'
    const audience = 'http://127.0.0.1:3114/api/vdr-mcp'
    const token = mintToken(audience, [VDR_SCOPES.base], {}, 'key-1', issuer)
    const principal = await verifyVdrMcpBearer(
      request(audience, token),
      toolsCall('sala_documentos'),
      { ...localConfig, issuer, audience, jwksUri: `${issuer}/jwks` },
      dependencies()
    )
    expect(principal.issuer).toBe(issuer)
  })

  it('lets next.config rewrite /auth.md for a loopback issuer', async () => {
    const { agentAuthMdRewrite } = await import('@/lib/agent-auth-md')
    expect(agentAuthMdRewrite('http://localhost:3114/api/dev')).toEqual({
      source: '/auth.md',
      destination: 'http://localhost:3114/agent/auth.md',
    })
  })

  it('rejects http:// that is not loopback', async () => {
    const issuer = 'http://evil.example/api/dev'
    const audience = 'http://evil.example/api/vdr-mcp'
    const token = mintToken(audience, [VDR_SCOPES.base], {}, 'key-1', issuer)
    await expect(
      verifyVdrMcpBearer(
        request(audience, token),
        toolsCall('sala_documentos'),
        { ...localConfig, issuer, audience, jwksUri: `${issuer}/jwks` },
        dependencies()
      )
    ).rejects.toThrow('MCP_OAUTH_CONFIG_INVALID')
  })

  it('accepts a seeded dev_ subject on a loopback issuer when DEV_AUTH_ENABLED', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const token = mintToken(
      LOCAL_AUDIENCE,
      [VDR_SCOPES.base],
      { sub: 'dev_company_001_workos' },
      'key-1',
      LOCAL_ISSUER
    )
    const principal = await verifyVdrMcpBearer(
      request(LOCAL_AUDIENCE, token),
      toolsCall('sala_documentos'),
      localConfig,
      dependencies()
    )
    expect(principal.principalId).toBe('dev_company_001_workos')
  })

  it('rejects a dev_ subject on a cloud HTTPS issuer even with DEV_AUTH_ENABLED', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], {
      sub: 'dev_company_001_workos',
    })
    await expect(
      verifyVdrMcpBearer(
        request(vdrConfig.audience, token),
        toolsCall('sala_documentos'),
        vdrConfig,
        dependencies()
      )
    ).rejects.toThrow('MCP_TOKEN_CLAIMS_INVALID')
  })

  it('rejects a dev_ subject on loopback when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const token = mintToken(
      LOCAL_AUDIENCE,
      [VDR_SCOPES.base],
      { sub: 'dev_company_001_workos' },
      'key-1',
      LOCAL_ISSUER
    )
    await expect(
      verifyVdrMcpBearer(
        request(LOCAL_AUDIENCE, token),
        toolsCall('sala_documentos'),
        localConfig,
        dependencies()
      )
    ).rejects.toThrow('MCP_TOKEN_CLAIMS_INVALID')
  })
})

// ============================================================================
// CLIENT ID CON FORMA DE URL (CIMD)
// ============================================================================
// Claude Code se registra por Client ID Metadata Document (MCP 2025-11-25) y
// AuthKit emite la URL de ese documento como `client_id`. El claim es un
// identificador opaco: entra al digest del rate limit y a la auditoría, nunca
// a una decisión de acceso.
// ============================================================================

const CIMD_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata'

const REJECTED_CLIENT_IDS = [
  'http://claude.ai/oauth/claude-code-client-metadata',
  'https://user:fixture-6df56ca2@example.com/oauth/claude-code-client-metadata',
  'https://claude.ai/oauth/claude-code-client-metadata#frag',
  'https://claude.ai/oauth/claude code client metadata',
  'https://claude.ai/oauth/'.padEnd(600, 'a'),
] as const

async function verifyClientId(overrides: Record<string, unknown>) {
  const token = mintToken(vdrConfig.audience, [VDR_SCOPES.base], overrides)
  return verifyVdrMcpBearer(
    request('https://sherlock.example.test/api/vdr-mcp', token),
    toolsCall('sala_documentos'),
    vdrConfig,
    dependencies()
  )
}

describe('client id con forma de URL', () => {
  it('acepta el client_id CIMD de Claude Code y lo conserva entero', async () => {
    const principal = await verifyClientId({ client_id: CIMD_CLIENT_ID })
    expect(principal.clientId).toBe(CIMD_CLIENT_ID)
    expect(principal.principalId).toBe('user_01ABC')
  })

  it('acepta la URL CIMD en un token delegado de agent registration', async () => {
    const principal = await verifyClientId({
      sub: 'agent_reg_01VDRAGENT',
      act: { sub: 'user_01VDRACTOR' },
      client_id: CIMD_CLIENT_ID,
    })
    expect(principal.principalId).toBe('user_01VDRACTOR')
    expect(principal.clientId).toBe(CIMD_CLIENT_ID)
  })

  it('sigue aceptando un client id con forma de identificador', async () => {
    const principal = await verifyClientId({ client_id: 'client_01ABC' })
    expect(principal.clientId).toBe('client_01ABC')
  })

  it.each(REJECTED_CLIENT_IDS)('rechaza el client_id %s', async (clientId) => {
    await expect(verifyClientId({ client_id: clientId })).rejects.toThrow(
      'MCP_TOKEN_CLAIMS_INVALID'
    )
  })

  it.each(REJECTED_CLIENT_IDS)(
    'rechaza el client_id %s también en la rama delegada',
    async (clientId) => {
      await expect(
        verifyClientId({
          sub: 'agent_reg_01VDRAGENT',
          act: { sub: 'user_01VDRACTOR' },
          client_id: clientId,
        })
      ).rejects.toThrow('MCP_TOKEN_CLAIMS_INVALID')
    }
  )
})
