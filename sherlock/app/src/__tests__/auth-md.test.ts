import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentAuthMdRewrite } from '@/lib/agent-auth-md'

type Rewrite = { source: string; destination: string }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('/auth.md hosting', () => {
  it('rewrites the root recipe to the configured AuthKit agent skill', async () => {
    vi.stubEnv('MCP_OAUTH_ISSUER', 'https://issuer.example.test/deployment')
    vi.stubEnv('VDR_MCP_ENABLED', 'true')
    vi.resetModules()

    const { default: nextConfig } = await import('../../next.config')
    const rewrites = await (nextConfig as { rewrites?: () => Promise<{ beforeFiles: Rewrite[] }> })
      .rewrites!()

    expect(rewrites.beforeFiles).toContainEqual({
      source: '/auth.md',
      destination: 'https://issuer.example.test/agent/auth.md',
    })
  })

  it.each([undefined, '', 'not-a-url'])(
    'fails closed when MCP_OAUTH_ISSUER is missing or malformed: %j',
    (issuer) => {
      expect(() => agentAuthMdRewrite(issuer)).toThrowError('AUTH_MD_ISSUER_INVALID')
    }
  )

  it.each([
    'http://issuer.example.test',
    'https://user:fixture-f085bf26@example.com',
    'https://issuer.example.test?redirect=https://attacker.example',
    'https://issuer.example.test#attacker',
  ])('rejects an unsafe MCP_OAUTH_ISSUER: %s', (issuer) => {
    expect(() => agentAuthMdRewrite(issuer)).toThrowError('AUTH_MD_ISSUER_INVALID')
  })

  it('does not register the recipe when the VDR MCP surface is disabled', () => {
    expect(Reflect.apply(agentAuthMdRewrite, null, [undefined, false])).toBeNull()
    expect(Reflect.apply(agentAuthMdRewrite, null, ['not-a-url', false])).toBeNull()
  })
})
