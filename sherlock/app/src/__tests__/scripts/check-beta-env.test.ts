import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/check-beta-env.mjs')

const requiredProdEnv = [
  ['WORKOS_API_KEY', 'sk_test_workos'],
  ['WORKOS_CLIENT_ID', 'client_test_workos'],
  ['WORKOS_COOKIE_PASSWORD', 'replace_with_32_plus_characters'], // gitleaks:allow -- deterministic test fixture, not a provider credential
  ['WORKOS_WEBHOOK_SECRET', 'whsec_workos'],
  ['NEXT_PUBLIC_APP_URL', 'https://sherlock.capital'],
  ['NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'https://example.com/callback'],
  ['NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud'],
  ['CONVEX_DEPLOYMENT', 'prod:example'],
  ['CONVEX_DEPLOY_KEY', 'prod_deploy_key'],
  ['WEBHOOK_SECRET', 'shared_webhook_secret'],
  ['STORAGE_SECRET', 'storage_secret'],
  ['VDR_GUEST_SERVER_SECRET', 'vdr_guest_server_secret_for_tests_123456789'],
  ['VDR_GUEST_SERVER_AUDIENCE', 'sherlock-prod:guest-boundary'],
  ['ADMIN_VDR_CAPABILITY_SECRET', 'admin_vdr_capability_secret_for_tests_123456789'],
  ['VDR_MCP_ENABLED', 'false'],
  ['RATE_LIMIT_PROVIDER', 'memory'],
]

const vdrMcpProdEnv = [
  ['VDR_MCP_SERVER_SECRET', 'vdr_mcp_server_secret_for_tests_123456789'],
  ['VDR_MCP_SERVER_AUDIENCE', 'sherlock-prod:vdr-mcp-boundary'],
  ['MCP_OAUTH_ISSUER', 'https://issuer.example.test'],
  ['VDR_MCP_OAUTH_AUDIENCE', 'https://www.sherlock.capital/api/vdr-mcp'],
  ['MCP_OAUTH_JWKS_URL', 'https://issuer.example.test/oauth2/jwks'],
  ['MCP_OAUTH_TENANT_CLAIM', 'org_id'],
  ['MCP_OAUTH_CLIENT_ID_CLAIM', 'client_id'],
  ['VDR_MCP_OAUTH_SCOPE_BASE', 'openid'],
]

function runEnvCheck(cwd: string, args: string[] = ['--strict-prod']) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

describe('check-beta-env', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('fails strict prod when no production env file exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(join(tempDir, '.env.local'), 'WORKOS_API_KEY=sk_local_only\n')

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('STRICT_PROD_ENV_FILE')
  })

  it('passes strict prod when a production env file contains the required keys', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      requiredProdEnv.map(([key, value]) => `${key}=${value}`).join('\n')
    )

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Private beta env check passed')
  })

  it('passes strict prod with a complete enabled VDR MCP configuration', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    const env = [
      ...requiredProdEnv.filter(([key]) => key !== 'VDR_MCP_ENABLED'),
      ['VDR_MCP_ENABLED', 'true'],
      ...vdrMcpProdEnv,
    ]
    writeFileSync(
      join(tempDir, '.env.production'),
      env.map(([key, value]) => `${key}=${value}`).join('\n')
    )

    expect(runEnvCheck(tempDir).status).toBe(0)
  })

  it.each(vdrMcpProdEnv.map(([key]) => [key]))(
    'fails strict prod when enabled VDR MCP key %s is missing',
    (missingKey) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
      const env = [
        ...requiredProdEnv.filter(([key]) => key !== 'VDR_MCP_ENABLED'),
        ['VDR_MCP_ENABLED', 'true'],
        ...vdrMcpProdEnv.filter(([key]) => key !== missingKey),
      ]
      writeFileSync(
        join(tempDir, '.env.production'),
        env.map(([key, value]) => `${key}=${value}`).join('\n')
      )

      const result = runEnvCheck(tempDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(missingKey)
    }
  )

  it('rejects an invalid VDR MCP release state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    const env = requiredProdEnv.map(([key, value]) =>
      key === 'VDR_MCP_ENABLED' ? `${key}=enabled` : `${key}=${value}`
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_ENABLED')
  })

  // El flag de sitio informativo se retiró con el pivot: el marketplace queda
  // despublicado en el código, no por variable de ambiente. Un env de
  // producción que todavía lo traiga no puede volverse un fallo del gate.
  it('ignores a leftover public-site-only flag in production env', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [
        ...requiredProdEnv.map(([key, value]) => `${key}=${value}`),
        'SHERLOCK_PUBLIC_SITE_ONLY=false',
      ].join('\n')
    )

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Private beta env check passed')
  })

  it('passes outside strict prod with only a development env file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(join(tempDir, '.env.local'), 'NODE_ENV=development\n')

    const result = runEnvCheck(tempDir, [])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Private beta env check passed')
  })

  it('allows demo auth flags in the gitignored local development env', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(
      join(tempDir, '.env.local'),
      ['NEXT_PUBLIC_DEV_AUTH_ENABLED=true', 'NEXT_PUBLIC_BYPASS_AUTH=true'].join('\n')
    )

    const result = runEnvCheck(tempDir, [])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Private beta env check passed')
  })

  it.each([
    '.env',
    '.env.preview',
    '.env.production',
    '.env.production.local',
    '.env.example',
    '.env.template',
  ])('rejects demo auth flags in deployable source %s', (envFile) => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    writeFileSync(join(tempDir, envFile), 'NEXT_PUBLIC_BYPASS_AUTH=true\n')

    const result = runEnvCheck(tempDir, [])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_BYPASS_AUTH')
  })

  it('accepts Upstash keys instead of the memory opt-out in strict prod', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    const env = [
      ...requiredProdEnv.filter(([key]) => key !== 'RATE_LIMIT_PROVIDER'),
      ['UPSTASH_REDIS_REST_URL', 'https://example.upstash.io'],
      ['UPSTASH_REDIS_REST_TOKEN', 'upstash_rest_token_for_tests'],
    ]
    writeFileSync(
      join(tempDir, '.env.production'),
      env.map(([key, value]) => `${key}=${value}`).join('\n')
    )

    expect(runEnvCheck(tempDir).status).toBe(0)
  })

  it('fails strict prod when Redis keys and the memory opt-out are both absent', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    const env = requiredProdEnv
      .filter(([key]) => key !== 'RATE_LIMIT_PROVIDER')
      .map(([key, value]) => `${key}=${value}`)
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_URL')
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_TOKEN')
  })

  it('fails strict prod when production env keeps a legacy product app domain', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
    const env = requiredProdEnv.map(([key, value]) =>
      key === 'NEXT_PUBLIC_APP_URL' ? `${key}=https://${'du'}go.capital` : `${key}=${value}`
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runEnvCheck(tempDir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_APP_URL')
    expect(result.stderr).toContain('legacy product domain')
  })

  it.each(requiredProdEnv.map(([key]) => [key]))(
    'fails strict prod when required key %s is missing',
    (missingKey) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sherlock-beta-env-'))
      const env = requiredProdEnv
        .filter(([key]) => key !== missingKey)
        .map(([key, value]) => `${key}=${value}`)
      writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

      const result = runEnvCheck(tempDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(missingKey)
    }
  )
})
