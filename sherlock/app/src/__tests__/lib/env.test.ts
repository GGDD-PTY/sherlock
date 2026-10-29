// ============================================================================
// ENV UTILITY UNIT TESTS
// ============================================================================
// Tests for environment variable validation functions
// Covers: validateServerEnv, env object
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function setTestWindow(value: (Window & typeof globalThis) | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
    return
  }

  Object.defineProperty(globalThis, 'window', {
    value,
    configurable: true,
    writable: true,
  })
}

describe('lib/env.ts', () => {
  const originalEnv = process.env
  const originalWindow = global.window
  const optionalEnvWarningFlag = '__SHERLOCK_OPTIONAL_ENV_WARNING_SHOWN__'

  beforeEach(() => {
    vi.resetModules()
    // Start with a clean slate for each test
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      // Required vars
      WORKOS_API_KEY: 'workos_api_key_for_tests',
      WORKOS_CLIENT_ID: 'client_test_123',
      WORKOS_COOKIE_PASSWORD: 'replace_with_32_plus_characters_for_tests', // gitleaks:allow -- deterministic test fixture, not a provider credential
      WORKOS_WEBHOOK_SECRET: 'workos_webhook_secret_for_tests',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'http://localhost:3000/callback',
      STORAGE_SECRET: 'storage_secret_for_tests',
      WEBHOOK_SECRET: 'webhook_secret_for_tests',
      VDR_GUEST_SERVER_SECRET: 'vdr_guest_server_secret_for_tests_123456789',
      VDR_GUEST_SERVER_AUDIENCE: 'sherlock-test:guest-boundary',
      ADMIN_VDR_CAPABILITY_SECRET: 'admin_vdr_capability_secret_for_tests_123456789',
      VDR_MCP_ENABLED: 'true',
      VDR_MCP_SERVER_SECRET: 'vdr_mcp_server_secret_for_tests_123456789',
      VDR_MCP_SERVER_AUDIENCE: 'sherlock-test:vdr-mcp-boundary',
      VDR_MCP_OAUTH_AUDIENCE: 'https://sherlock.example.test/api/vdr-mcp',
      VDR_MCP_OAUTH_SCOPE_BASE: 'openid',
      MCP_OAUTH_ISSUER: 'https://issuer.example.test',
      MCP_OAUTH_JWKS_URL: 'https://issuer.example.test/oauth2/jwks',
      MCP_OAUTH_TENANT_CLAIM: 'organization_id',
      MCP_OAUTH_CLIENT_ID_CLAIM: 'client_id',
      CONVEX_DEPLOYMENT: 'dev:some-deployment-id',
      CONVEX_DEPLOY_KEY: 'dev:happy-animal-123|secret',
      NEXT_PUBLIC_CONVEX_URL: 'https://some-deployment.convex.cloud',
      // Optional vars
      OBSERVABILITY_PROBE_SECRET: 'observability_probe_secret_for_tests_32_plus', // gitleaks:allow -- deterministic test fixture, not a provider credential
      // Distributed rate-limit (Upstash) — required in production unless opted out
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'upstash_token_for_tests',
    }
    delete process.env.SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS
    delete (
      globalThis as typeof globalThis & Record<typeof optionalEnvWarningFlag, boolean | undefined>
    )[optionalEnvWarningFlag]
    // Ensure we're in "server" context
    setTestWindow(undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    setTestWindow(originalWindow)
  })

  // ============================================================================
  // validateServerEnv TESTS
  // ============================================================================
  describe('validateServerEnv', () => {
    // ===== TEST: PASSES WITH ALL REQUIRED VARS =====
    it('passes validation when all required vars are set', async () => {
      // Should not throw
      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('throws error when WORKOS_API_KEY is missing', async () => {
      delete process.env.WORKOS_API_KEY

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: WORKOS_API_KEY'
      )
    })

    it('throws error when WORKOS_CLIENT_ID is missing', async () => {
      delete process.env.WORKOS_CLIENT_ID

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: WORKOS_CLIENT_ID'
      )
    })

    // ===== TEST: THROWS ON MISSING CONVEX_DEPLOYMENT =====
    it('throws error when CONVEX_DEPLOYMENT is missing', async () => {
      delete process.env.CONVEX_DEPLOYMENT

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: CONVEX_DEPLOYMENT'
      )
    })

    it('allows missing CONVEX_DEPLOY_KEY when dev auth is enabled', async () => {
      process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
      delete process.env.CONVEX_DEPLOY_KEY

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('validateServerEnv warns but does not throw for missing CONVEX_DEPLOY_KEY in test env', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      delete process.env.CONVEX_DEPLOY_KEY

      await expect(import('@/lib/env')).resolves.toBeDefined()
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    // ===== TEST: THROWS ON MISSING NEXT_PUBLIC_CONVEX_URL =====
    it('throws error when NEXT_PUBLIC_CONVEX_URL is missing', async () => {
      delete process.env.NEXT_PUBLIC_CONVEX_URL

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: NEXT_PUBLIC_CONVEX_URL'
      )
    })

    it('throws error when NEXT_PUBLIC_APP_URL is missing', async () => {
      delete process.env.NEXT_PUBLIC_APP_URL

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: NEXT_PUBLIC_APP_URL'
      )
    })

    it('throws error when NEXT_PUBLIC_APP_URL is invalid', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.NEXT_PUBLIC_APP_URL = 'not-a-url'

      await expect(import('@/lib/env')).rejects.toThrow('NEXT_PUBLIC_APP_URL')
    })

    it('throws error when NEXT_PUBLIC_WORKOS_REDIRECT_URI is missing', async () => {
      delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: NEXT_PUBLIC_WORKOS_REDIRECT_URI'
      )
    })

    it('throws error when WORKOS_WEBHOOK_SECRET is missing (non dev-auth)', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.WORKOS_WEBHOOK_SECRET

      await expect(import('@/lib/env')).rejects.toThrow(/WORKOS_WEBHOOK_SECRET/)
    })

    it('throws error when STORAGE_SECRET is missing (non dev-auth)', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.STORAGE_SECRET

      await expect(import('@/lib/env')).rejects.toThrow(/STORAGE_SECRET/)
    })

    it('throws when the dedicated guest boundary secret is missing in production', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.VDR_GUEST_SERVER_SECRET

      await expect(import('@/lib/env')).rejects.toThrow(/VDR_GUEST_SERVER_SECRET/)
    })

    it('throws when the guest deployment audience is malformed or unbounded', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.VDR_GUEST_SERVER_AUDIENCE = 'browser exposed audience'

      await expect(import('@/lib/env')).rejects.toThrow(/VDR_GUEST_SERVER_AUDIENCE/)
    })

    it('throws when the delegated admin VDR capability secret is missing in production', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.ADMIN_VDR_CAPABILITY_SECRET

      await expect(import('@/lib/env')).rejects.toThrow(/ADMIN_VDR_CAPABILITY_SECRET/)
    })

    it('requires the intake authority only when intake demo mode is enabled', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.INTAKE_DEMO_MODE = 'true'
      delete process.env.INTAKE_SERVER_SECRET
      delete process.env.INTAKE_SERVER_AUDIENCE

      const importing = import('@/lib/env')
      await expect(importing).rejects.toThrow(/INTAKE_SERVER_SECRET/)
      await expect(importing).rejects.toThrow(/INTAKE_SERVER_AUDIENCE/)
    })

    it('allows missing intake authority when intake demo mode is disabled', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.INTAKE_DEMO_MODE = 'false'
      delete process.env.INTAKE_SERVER_SECRET
      delete process.env.INTAKE_SERVER_AUDIENCE

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it.each([
      ['vercel-preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
      ['next-build', { NEXT_PHASE: 'phase-production-build' }],
    ])('relaxes startup validation during %s', async (mode, relaxedEnvironment) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.VERCEL
      delete process.env.VERCEL_ENV
      delete process.env.NEXT_PHASE
      Object.assign(process.env, relaxedEnvironment)
      delete process.env.CONVEX_DEPLOYMENT

      const { env } = await import('@/lib/env')

      expect(env.CONVEX_DEPLOYMENT).toBe('')
      expect(warnSpy).toHaveBeenCalledWith(
        `[ENV] ${mode} environment - env validation warnings:`,
        expect.stringContaining('CONVEX_DEPLOYMENT')
      )

      warnSpy.mockRestore()
    })

    it('requires the VDR MCP server proof and OAuth resource configuration in production', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.VDR_MCP_SERVER_SECRET
      delete process.env.VDR_MCP_OAUTH_AUDIENCE
      delete process.env.MCP_OAUTH_JWKS_URL

      await expect(import('@/lib/env')).rejects.toThrow(/VDR_MCP_SERVER_SECRET/)
      await expect(import('@/lib/env')).rejects.toThrow(/VDR_MCP_OAUTH_AUDIENCE/)
      await expect(import('@/lib/env')).rejects.toThrow(/MCP_OAUTH_JWKS_URL/)
    })

    it('allows missing VDR MCP authority when the release gate is off', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.VDR_MCP_ENABLED = 'false'
      for (const key of [
        'VDR_MCP_SERVER_SECRET',
        'VDR_MCP_SERVER_AUDIENCE',
        'VDR_MCP_OAUTH_AUDIENCE',
        'VDR_MCP_OAUTH_SCOPE_BASE',
        'MCP_OAUTH_ISSUER',
        'MCP_OAUTH_JWKS_URL',
        'MCP_OAUTH_TENANT_CLAIM',
        'MCP_OAUTH_CLIENT_ID_CLAIM',
      ]) {
        delete process.env[key]
      }

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('ignores placeholder VDR MCP values while the release gate is off', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.VDR_MCP_ENABLED = 'false'
      process.env.VDR_MCP_OAUTH_AUDIENCE = 'not-a-url'
      process.env.VDR_MCP_OAUTH_SCOPE_BASE = 'placeholder'

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('rejects an invalid VDR MCP release gate value', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.VDR_MCP_ENABLED = 'enabled'

      await expect(import('@/lib/env')).rejects.toThrow(/VDR_MCP_ENABLED/)
    })

    it('rejects a malformed or public VDR MCP authority configuration', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.VDR_MCP_OAUTH_AUDIENCE = 'http://localhost/api/vdr-mcp'
      process.env.MCP_OAUTH_TENANT_CLAIM = 'sub'

      await expect(import('@/lib/env')).rejects.toThrow(/VDR_MCP_OAUTH_AUDIENCE/)
      await expect(import('@/lib/env')).rejects.toThrow(/MCP_OAUTH_TENANT_CLAIM/)
    })

    it('allows missing live-auth and guest-boundary secrets when dev auth is enabled', async () => {
      process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
      delete process.env.WORKOS_WEBHOOK_SECRET
      delete process.env.STORAGE_SECRET
      delete process.env.WEBHOOK_SECRET
      delete process.env.CONVEX_DEPLOY_KEY
      delete process.env.VDR_GUEST_SERVER_SECRET
      delete process.env.VDR_GUEST_SERVER_AUDIENCE
      delete process.env.ADMIN_VDR_CAPABILITY_SECRET

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    // ===== TEST: THROWS ON EMPTY STRING VALUE =====
    it('throws error when required var is empty string', async () => {
      process.env.WORKOS_API_KEY = '   '

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: WORKOS_API_KEY'
      )
    })

    // ===== TEST: SKIPS VALIDATION IN BROWSER =====
    it('validateServerEnv returns early in browser context', async () => {
      // Simulate browser environment - must be set before import
      global.window = {} as Window & typeof globalThis

      // Import the module (with all required vars set so getRequiredEnv doesn't throw)
      const envModule = await import('@/lib/env')

      // validateServerEnv should be exported
      expect(envModule.validateServerEnv).toBeDefined()

      // Calling it again in browser context should just return without doing anything
      // (the function checks typeof window !== "undefined" and returns early)
      expect(() => envModule.validateServerEnv()).not.toThrow()
    })

    // ===== TEST: WARNS ON MISSING OPTIONAL VARS IN DEV =====
    it('logs warning for optional vars in development', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'development'
      process.env.SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS = 'true'

      // Remove optional vars only (prod-required vars stay set in beforeEach)
      delete process.env.OBSERVABILITY_PROBE_SECRET

      await import('@/lib/env')

      // Should have warned about optional vars
      expect(warnSpy).toHaveBeenCalled()
      const warnCall = warnSpy.mock.calls[0]?.[0]
      expect(warnCall).toContain('Variables de entorno opcionales')

      warnSpy.mockRestore()
    })

    it('does not log optional var warnings in development by default', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'development'
      delete process.env.OBSERVABILITY_PROBE_SECRET

      await import('@/lib/env')

      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    it('logs optional var warnings only once per server process when enabled', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'development'
      process.env.SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS = 'true'
      delete process.env.OBSERVABILITY_PROBE_SECRET

      const envModule = await import('@/lib/env')
      envModule.validateServerEnv()

      expect(warnSpy).toHaveBeenCalledTimes(1)

      warnSpy.mockRestore()
    })

    // ===== TEST: NO WARNING IN PRODUCTION FOR OPTIONAL VARS =====
    it('does not warn about optional vars in production', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      delete process.env.OBSERVABILITY_PROBE_SECRET

      await import('@/lib/env')

      // Should NOT have warned (production mode)
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    // ===== CARRIL OPT-IN MAL CONFIGURADO: SE AVISA, NO SE CAE =====
    // Un dedo gordo en `vercel env add OBSERVABILITY_PROBE_SECRET` no puede
    // tumbar el sitio entero por una variable que sólo enciende el probe. El
    // valor fuera de rango se trata como ausente y deja un warning.
    it.each([
      ['demasiado corto', 'corto'],
      ['demasiado largo', 'x'.repeat(4_097)],
    ])(
      'no tumba el arranque con un OBSERVABILITY_PROBE_SECRET %s, sólo avisa',
      async (_label, value) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
        process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
        process.env.OBSERVABILITY_PROBE_SECRET = value

        await expect(import('@/lib/env')).resolves.toBeDefined()

        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('OBSERVABILITY_PROBE_SECRET')
        // El valor jamás sale en el aviso.
        expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain(value)

        warnSpy.mockRestore()
      }
    )

    it('deja el probe apagado cuando el secreto no cumple el formato', async () => {
      process.env.OBSERVABILITY_PROBE_SECRET = 'corto'

      const { resolveObservabilityProbeSecret } = await import('@/lib/observability/probe')

      expect(resolveObservabilityProbeSecret()).toBeNull()
    })

    it('acepta un OBSERVABILITY_PROBE_SECRET válido sin avisar', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.OBSERVABILITY_PROBE_SECRET = 'observability-probe-secret-32-chars-ok' // gitleaks:allow -- deterministic test fixture, not a provider credential

      await expect(import('@/lib/env')).resolves.toBeDefined()

      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  // ============================================================================
  // DISTRIBUTED RATE-LIMIT (Redis) REQUIREMENT
  // ============================================================================
  describe('distributed rate-limit (Redis) requirement', () => {
    function clearRedisEnv() {
      delete process.env.UPSTASH_REDIS_REST_URL
      delete process.env.UPSTASH_REDIS_REST_TOKEN
      delete process.env.RATE_LIMIT_PROVIDER
      delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    }

    it('throws when UPSTASH_REDIS_REST_URL is missing in production', async () => {
      clearRedisEnv()
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'

      await expect(import('@/lib/env')).rejects.toThrow(/UPSTASH_REDIS_REST_URL/)
    })

    it('throws when UPSTASH_REDIS_REST_TOKEN is missing in production', async () => {
      clearRedisEnv()
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'

      await expect(import('@/lib/env')).rejects.toThrow(/UPSTASH_REDIS_REST_TOKEN/)
    })

    it('passes when both Upstash credentials are set in production', async () => {
      clearRedisEnv()
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
      process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash_token'

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('allows missing Upstash credentials when RATE_LIMIT_PROVIDER=memory', async () => {
      clearRedisEnv()
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
      process.env.RATE_LIMIT_PROVIDER = 'memory'

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })

    it('does not require Upstash outside production', async () => {
      clearRedisEnv()
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'development'

      await expect(import('@/lib/env')).resolves.toBeDefined()
    })
  })

  // ============================================================================
  // env OBJECT TESTS
  // ============================================================================
  describe('env object', () => {
    // ===== TEST: EXPORTS ENV OBJECT =====
    it('exports env object with all properties', async () => {
      const { env } = await import('@/lib/env')

      expect(env).toBeDefined()
      expect(typeof env).toBe('object')
    })

    it('has WorkOS AuthKit environment variables', async () => {
      const { env } = await import('@/lib/env')

      expect(env.WORKOS_API_KEY).toBe('workos_api_key_for_tests')
      expect(env.WORKOS_CLIENT_ID).toBe('client_test_123')
      expect(env.WORKOS_COOKIE_PASSWORD).toBe('replace_with_32_plus_characters_for_tests')
      expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000')
      expect(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI).toBe('http://localhost:3000/callback')
    })

    // ===== TEST: HAS CONVEX VARS =====
    it('has Convex environment variables', async () => {
      const { env } = await import('@/lib/env')

      expect(env.CONVEX_DEPLOYMENT).toBe('dev:some-deployment-id')
      expect(env.CONVEX_DEPLOY_KEY).toBe('dev:happy-animal-123|secret')
      expect(env.NEXT_PUBLIC_CONVEX_URL).toBe('https://some-deployment.convex.cloud')
      expect(env).not.toHaveProperty('NEXT_PUBLIC_VDR_GUEST_SERVER_SECRET')
      expect(env).not.toHaveProperty('NEXT_PUBLIC_VDR_GUEST_SERVER_AUDIENCE')
    })

    // ===== TEST: HAS OPTIONAL VARS =====
    it('has optional environment variables', async () => {
      const { env } = await import('@/lib/env')

      expect(env.OBSERVABILITY_PROBE_SECRET).toBe('observability_probe_secret_for_tests_32_plus')
    })

    // ===== TEST: OPTIONAL VARS CAN BE UNDEFINED =====
    it('optional vars can be undefined', async () => {
      delete process.env.OBSERVABILITY_PROBE_SECRET

      const { env } = await import('@/lib/env')

      expect(env.OBSERVABILITY_PROBE_SECRET).toBeUndefined()
    })

    it('CONVEX_DEPLOY_KEY can be undefined when dev auth is enabled', async () => {
      process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
      delete process.env.CONVEX_DEPLOY_KEY

      const { env } = await import('@/lib/env')

      expect(env.CONVEX_DEPLOY_KEY).toBeUndefined()
    })

    // ===== TEST: HAS META PROPERTIES =====
    it('has meta properties (NODE_ENV, IS_PRODUCTION, IS_DEVELOPMENT)', async () => {
      const { env } = await import('@/lib/env')

      expect(env.NODE_ENV).toBe('test')
      expect(env.IS_DEVELOPMENT).toBe(false)
      expect(env.IS_PRODUCTION).toBe(false)
    })

    // ===== TEST: IS_PRODUCTION TRUE IN PRODUCTION =====
    it('IS_PRODUCTION is true when NODE_ENV is production', async () => {
      ;(process.env as { NODE_ENV: string }).NODE_ENV = 'production'
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'

      const { env } = await import('@/lib/env')

      expect(env.IS_PRODUCTION).toBe(true)
      expect(env.IS_DEVELOPMENT).toBe(false)
    })
  })

  // ============================================================================
  // EDGE CASES
  // ============================================================================
  describe('Edge cases', () => {
    // ===== TEST: HANDLES WHITESPACE-ONLY VALUES =====
    it('treats whitespace-only values as missing', async () => {
      process.env.WORKOS_API_KEY = '   \t\n   '

      await expect(import('@/lib/env')).rejects.toThrow(
        'Missing required environment variable: WORKOS_API_KEY'
      )
    })

    // ===== TEST: PRESERVES VALUES WITH SPECIAL CHARS =====
    it('preserves values with special characters', async () => {
      process.env.WORKOS_API_KEY = 'workos_!@#$%^&*()_+-=[]{}|;\':",./<>?'

      const { env } = await import('@/lib/env')

      expect(env.WORKOS_API_KEY).toBe('workos_!@#$%^&*()_+-=[]{}|;\':",./<>?')
    })

    // ===== TEST: HANDLES VERY LONG VALUES =====
    it('handles very long values', async () => {
      const longValue = 'workos_' + 'a'.repeat(10000)
      process.env.WORKOS_API_KEY = longValue

      const { env } = await import('@/lib/env')

      expect(env.WORKOS_API_KEY).toBe(longValue)
    })
  })
})
