import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/validate-prod-setup.mjs')
const PROD_VDR_ENV = [
  'CONVEX_ENV=production',
  'VDR_FILE_SCANNER_URL=https://scanner.private.example/v1/scan',
  'VDR_FILE_SCANNER_TOKEN=test-scanner-token',
  `GUEST_IDENTITY_HASH_SECRET=${'i'.repeat(32)}`,
  `GUEST_OTP_PEPPER=${'o'.repeat(32)}`,
]
// La autoridad OAuth compartida sobrevive al corte del puente (2026-09-06): el
// MCP del cliente la exige con VDR_MCP_ENABLED=true y la ignora con false, por
// eso no va en PROD_APP_ENV (el it.each de «rejects missing» probaría un
// requisito que no existe con el gate apagado) y entra solo en los casos que
// prenden el gate.
const PROD_MCP_OAUTH_ENV = [
  'MCP_OAUTH_ISSUER=https://issuer.example.test',
  'MCP_OAUTH_JWKS_URL=https://issuer.example.test/oauth2/jwks',
  'MCP_OAUTH_TENANT_CLAIM=org_id',
  'MCP_OAUTH_CLIENT_ID_CLAIM=client_id',
]
const PROD_RUNTIME_ENV = [
  'RATE_LIMIT_PROVIDER=memory',
  'VDR_MCP_ENABLED=false',
  `VDR_GUEST_SERVER_SECRET=${'g'.repeat(32)}`,
  'VDR_GUEST_SERVER_AUDIENCE=sherlock-prod:guest-boundary',
  `ADMIN_VDR_CAPABILITY_SECRET=${'a'.repeat(32)}`,
]
const PROD_APP_ENV = [
  'WORKOS_API_KEY=sk_live_workos',
  'WORKOS_CLIENT_ID=client_prod_workos',
  'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
  'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
  'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
  'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
  'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
  'CONVEX_DEPLOYMENT=prod:example',
  'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
  'WEBHOOK_SECRET=shared_webhook_secret',
  'STORAGE_SECRET=shared_document_delivery_secret',
  ...PROD_VDR_ENV,
  ...PROD_RUNTIME_ENV,
]
const SHARED_CONVEX_ENV_KEYS = [
  'WORKOS_CLIENT_ID',
  'WEBHOOK_SECRET',
  'STORAGE_SECRET',
  'VDR_FILE_SCANNER_URL',
  'VDR_FILE_SCANNER_TOKEN',
  'GUEST_IDENTITY_HASH_SECRET',
  'GUEST_OTP_PEPPER',
  'VDR_GUEST_SERVER_SECRET',
  'VDR_GUEST_SERVER_AUDIENCE',
  'ADMIN_VDR_CAPABILITY_SECRET',
]
const PROD_CONVEX_REMOTE_ENV = [
  'CONVEX_ENV=production',
  ...PROD_APP_ENV.filter((entry) =>
    SHARED_CONVEX_ENV_KEYS.includes(entry.slice(0, entry.indexOf('=')))
  ),
].join('\n')

function runSetupCheck(
  cwd: string,
  envFile: string | null,
  args: string[] = [],
  remoteEnv = PROD_CONVEX_REMOTE_ENV,
  processEnv: Record<string, string> = {}
) {
  const binDir = join(cwd, 'bin')
  const fakeBunx = join(binDir, 'bunx')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(
    fakeBunx,
    [
      '#!/usr/bin/env node',
      'if (!process.env.CONVEX_DEPLOY_KEY) process.exit(19)',
      "if (process.env.CONVEX_DEPLOY_KEY === '[SENSITIVE]') process.exit(20)",
      "if (Object.values(process.env).some((value) => value?.trim() === '[SENSITIVE]')) process.exit(21)",
      "process.stdout.write(process.env.TEST_CONVEX_REMOTE_ENV ?? '')",
    ].join('\n')
  )
  chmodSync(fakeBunx, 0o755)
  const childEnv = { ...process.env }
  delete childEnv.CONVEX_DEPLOY_KEY

  return spawnSync(
    process.execPath,
    [scriptPath, ...(envFile ? [`--env-file=${envFile}`] : ['--process-env']), ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...childEnv,
        ...processEnv,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        TEST_CONVEX_REMOTE_ENV: remoteEnv,
      },
    }
  )
}

describe('validate-prod-setup', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('accepts WorkOS webhook signing secrets without a whsec prefix', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.local'),
      [
        'WORKOS_API_KEY=sk_test_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=http://localhost:3000',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=dev:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.local')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Format checks passed for WorkOS + Convex app env')
  })

  it('accepts production values directly from the process environment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const processEnv = Object.fromEntries(
      PROD_APP_ENV.map((entry) => {
        const separator = entry.indexOf('=')
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      })
    )

    const result = runSetupCheck(tempDir, null, [], PROD_CONVEX_REMOTE_ENV, processEnv)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('process environment')
  })

  it('removes write-only process values before listing the remote Convex environment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const processEnv = Object.fromEntries(
      PROD_APP_ENV.map((entry) => {
        const separator = entry.indexOf('=')
        const key = entry.slice(0, separator)
        return [key, key === 'CONVEX_DEPLOYMENT' ? '[SENSITIVE]' : entry.slice(separator + 1)]
      })
    )

    const result = runSetupCheck(tempDir, null, [], PROD_CONVEX_REMOTE_ENV, processEnv)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('CONVEX_DEPLOYMENT: write-only — verify in Vercel')
    expect(result.stderr).not.toContain('could not list remote Convex env')
    expect(result.stdout).toContain('remote deployment parity is UNKNOWN')
  })

  it('returns UNKNOWN for write-only placeholders without reporting format or parity failures', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const writeOnlyKeys = new Set([
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
      'WORKOS_COOKIE_PASSWORD',
      'VDR_GUEST_SERVER_SECRET',
    ])
    const env = PROD_APP_ENV.map((entry) => {
      const key = entry.slice(0, entry.indexOf('='))
      return writeOnlyKeys.has(key) ? `${key}=[SENSITIVE]` : entry
    })
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('UNKNOWN: write-only — verify in Vercel')
    for (const key of writeOnlyKeys) expect(result.stderr).toContain(key)
    expect(result.stderr).not.toContain('expected prefix')
    expect(result.stderr).not.toContain('must be between 32 and 4096 characters')
    expect(result.stderr).not.toContain('does not match app environment')
    expect(result.stdout).not.toContain('Format checks passed')
    expect(result.stdout).not.toContain('✓ remote deployment')
  })

  it.each(['NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'VDR_MCP_ENABLED', 'CONVEX_DEPLOYMENT'])(
    'keeps write-only control-flow value %s exclusively UNKNOWN',
    (writeOnlyKey) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
      const env = PROD_APP_ENV.map((entry) =>
        entry.startsWith(`${writeOnlyKey}=`) ? `${writeOnlyKey}=[SENSITIVE]` : entry
      )
      writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

      const result = runSetupCheck(tempDir, '.env.production')
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`${writeOnlyKey}: write-only — verify in Vercel`)
      expect(output).not.toContain('invalid')
      expect(output).not.toContain('missing')
      expect(output).not.toContain('passed')
      expect(output).not.toContain('✓')
    }
  )

  it('returns UNKNOWN without invoking Convex when the pulled deploy key is write-only', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('CONVEX_DEPLOY_KEY=') ? 'CONVEX_DEPLOY_KEY=[SENSITIVE]' : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('CONVEX_DEPLOY_KEY: write-only — verify in Vercel')
    expect(result.stderr).not.toContain('could not list remote Convex env')
    expect(result.stdout).toContain('remote Convex verification is UNKNOWN')
  })

  it('keeps a missing remote shared value RED when the app copy is write-only', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('WORKOS_CLIENT_ID=') ? 'WORKOS_CLIENT_ID=[SENSITIVE]' : entry
    )
    const remoteEnv = PROD_CONVEX_REMOTE_ENV.split('\n')
      .filter((entry) => !entry.startsWith('WORKOS_CLIENT_ID='))
      .join('\n')
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production', [], remoteEnv)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WORKOS_CLIENT_ID: write-only — verify in Vercel')
    expect(result.stderr).toContain('WORKOS_CLIENT_ID: missing on the production Convex deployment')
    expect(result.stdout).not.toContain('✓ remote deployment')
  })

  it('keeps exit 1 for a real invalid value while also reporting write-only UNKNOWN values', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) => {
      if (entry.startsWith('WORKOS_API_KEY=')) return 'WORKOS_API_KEY=[SENSITIVE]'
      if (entry.startsWith('CONVEX_ENV=')) return 'CONVEX_ENV=prodution'
      return entry
    })
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CONVEX_ENV: must be exactly production')
    expect(result.stderr).toContain('WORKOS_API_KEY: write-only — verify in Vercel')
    expect(result.stderr).not.toContain('WORKOS_API_KEY: expected prefix')
  })

  it('rejects a Convex URL that does not match the selected production deployment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('NEXT_PUBLIC_CONVEX_URL=')
        ? 'NEXT_PUBLIC_CONVEX_URL=https://different.convex.cloud'
        : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_CONVEX_URL')
    expect(result.stderr).toContain('CONVEX_DEPLOYMENT')
  })

  it('rejects a Convex deploy key for a different deployment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('CONVEX_DEPLOY_KEY=') ? 'CONVEX_DEPLOY_KEY=prod:different|deploy-key' : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CONVEX_DEPLOY_KEY')
    expect(result.stderr).toContain('CONVEX_DEPLOYMENT')
  })

  it('rejects a lookalike Convex hostname', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('NEXT_PUBLIC_CONVEX_URL=')
        ? 'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud.evil.test'
        : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_CONVEX_URL')
  })

  it('rejects a WorkOS test key for a production-looking app origin', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('WORKOS_API_KEY=') ? 'WORKOS_API_KEY=sk_test_workos' : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WORKOS_API_KEY')
    expect(result.stderr).toContain('sk_live_')
  })

  it('rejects a production callback hosted outside the public app origin', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('NEXT_PUBLIC_WORKOS_REDIRECT_URI=')
        ? 'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://dev.sherlock.capital/callback'
        : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_WORKOS_REDIRECT_URI')
    expect(result.stderr).toContain('share the public app origin')
  })

  it('requires the exact locale-agnostic callback path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('NEXT_PUBLIC_WORKOS_REDIRECT_URI=')
        ? 'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/nested/callback'
        : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('path must be exactly /callback')
  })

  it('rejects localhost origins in an explicit production env file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) => {
      if (entry.startsWith('NEXT_PUBLIC_APP_URL=')) {
        return 'NEXT_PUBLIC_APP_URL=http://localhost:3000'
      }
      if (entry.startsWith('NEXT_PUBLIC_WORKOS_REDIRECT_URI=')) {
        return 'NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback'
      }
      return entry
    })
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_APP_URL')
    expect(result.stderr).toContain('localhost')
  })

  it('never prints credentials, query values, or fragments from a callback URL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('NEXT_PUBLIC_WORKOS_REDIRECT_URI=')
        ? 'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://operator:fixture-9876dee9@example.com/callback?token=query-secret#fragment-secret'
        : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).not.toContain('callback-password')
    expect(output).not.toContain('query-secret')
    expect(output).not.toContain('fragment-secret')
  })

  it('reports invalid public URLs without crashing the preflight', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) => {
      if (entry.startsWith('NEXT_PUBLIC_APP_URL=')) return 'NEXT_PUBLIC_APP_URL=not-a-url'
      if (entry.startsWith('NEXT_PUBLIC_WORKOS_REDIRECT_URI=')) {
        return 'NEXT_PUBLIC_WORKOS_REDIRECT_URI=also-not-a-url'
      }
      return entry
    })
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Setup validation failed')
    expect(result.stderr).toContain('NEXT_PUBLIC_APP_URL')
    expect(result.stderr).toContain('NEXT_PUBLIC_WORKOS_REDIRECT_URI')
    expect(result.stderr).not.toContain('ERR_INVALID_URL')
  })

  it('requires the provider-supported openid scope when VDR MCP is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) =>
        entry === 'VDR_MCP_ENABLED=false' ? 'VDR_MCP_ENABLED=true' : entry
      ),
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
      'VDR_MCP_OAUTH_AUDIENCE=https://sherlock.capital/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=vdr:connect',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_OAUTH_SCOPE_BASE')
    expect(result.stderr).toContain('openid')
  })

  it('requires enabled VDR MCP proof values to match the Convex deployment', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) =>
        entry === 'VDR_MCP_ENABLED=false' ? 'VDR_MCP_ENABLED=true' : entry
      ),
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
      'VDR_MCP_OAUTH_AUDIENCE=https://sherlock.capital/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=openid',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_SERVER_SECRET')
    expect(result.stderr).toContain('missing on the production Convex deployment')
    expect(result.stderr).toContain('VDR_MCP_SERVER_AUDIENCE')
  })

  it('accepts enabled VDR MCP proof values when Convex has the exact mirror', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const vdrMcpProofEnv = [
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
    ]
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) => {
        if (entry === 'VDR_MCP_ENABLED=false') return 'VDR_MCP_ENABLED=true'
        if (entry.startsWith('MCP_OAUTH_TENANT_CLAIM=')) {
          return 'MCP_OAUTH_TENANT_CLAIM=sherlock_tenant'
        }
        return entry
      }),
      ...vdrMcpProofEnv,
      'VDR_MCP_OAUTH_AUDIENCE=https://sherlock.capital/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=openid',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(
      tempDir,
      '.env.production',
      [],
      [PROD_CONVEX_REMOTE_ENV, ...vdrMcpProofEnv].join('\n')
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('remote deployment has production VDR security prerequisites')
  })

  it('rejects an enabled VDR MCP audience outside the public app origin', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const vdrMcpProofEnv = [
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
    ]
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) => {
        if (entry === 'VDR_MCP_ENABLED=false') return 'VDR_MCP_ENABLED=true'
        if (entry.startsWith('MCP_OAUTH_TENANT_CLAIM=')) {
          return 'MCP_OAUTH_TENANT_CLAIM=sherlock_tenant'
        }
        return entry
      }),
      ...vdrMcpProofEnv,
      'VDR_MCP_OAUTH_AUDIENCE=https://attacker.example/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=openid',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(
      tempDir,
      '.env.production',
      [],
      [PROD_CONVEX_REMOTE_ENV, ...vdrMcpProofEnv].join('\n')
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_OAUTH_AUDIENCE')
    expect(result.stderr).toContain('public app origin')
  })

  it('requires the configured WorkOS tenant claim when VDR MCP is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const vdrMcpProofEnv = [
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
    ]
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) =>
        entry === 'VDR_MCP_ENABLED=false' ? 'VDR_MCP_ENABLED=true' : entry
      ),
      ...vdrMcpProofEnv,
      'VDR_MCP_OAUTH_AUDIENCE=https://sherlock.capital/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=openid',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(
      tempDir,
      '.env.production',
      [],
      [PROD_CONVEX_REMOTE_ENV, ...vdrMcpProofEnv].join('\n')
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MCP_OAUTH_TENANT_CLAIM')
    expect(result.stderr).toContain('sherlock_tenant')
  })

  it('rejects non-empty VDR proof values that differ in Convex', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const vdrMcpProofEnv = [
      `VDR_MCP_SERVER_SECRET=${'v'.repeat(32)}`,
      'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:vdr-mcp-boundary',
    ]
    const env = [
      ...[...PROD_APP_ENV, ...PROD_MCP_OAUTH_ENV].map((entry) => {
        if (entry === 'VDR_MCP_ENABLED=false') return 'VDR_MCP_ENABLED=true'
        if (entry.startsWith('MCP_OAUTH_TENANT_CLAIM=')) {
          return 'MCP_OAUTH_TENANT_CLAIM=sherlock_tenant'
        }
        return entry
      }),
      ...vdrMcpProofEnv,
      'VDR_MCP_OAUTH_AUDIENCE=https://sherlock.capital/api/vdr-mcp',
      'VDR_MCP_OAUTH_SCOPE_BASE=openid',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(
      tempDir,
      '.env.production',
      [],
      [
        PROD_CONVEX_REMOTE_ENV,
        `VDR_MCP_SERVER_SECRET=${'x'.repeat(32)}`,
        'VDR_MCP_SERVER_AUDIENCE=sherlock-prod:other-boundary',
      ].join('\n')
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_SERVER_SECRET')
    expect(result.stderr).toContain('does not match app environment')
    expect(result.stderr).toContain('VDR_MCP_SERVER_AUDIENCE')
  })

  it('uses a deploy key from the selected env file to reject remote dev auth flags', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [
        'WORKOS_API_KEY=sk_live_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(
      tempDir,
      '.env.production',
      [],
      ['BYPASS_AUTH=true', 'CONVEX_ENV=dev', ...PROD_VDR_ENV.slice(1)].join('\n')
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('checking remote deployment env')
    expect(result.stderr).toContain('BYPASS_AUTH')
    expect(result.stderr).toContain('CONVEX_ENV')
  })

  it('rejects setup when the shared Convex document-delivery secret is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.local'),
      [
        'WORKOS_API_KEY=sk_test_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=http://localhost:3000',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=dev:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.local')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('STORAGE_SECRET')
    expect(result.stderr).toContain('must match Convex deployment env')
  })

  it('rejects stale product domains in public app and redirect env', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.local'),
      [
        'WORKOS_API_KEY=sk_test_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        `NEXT_PUBLIC_APP_URL=https://${'du'}go.capital`,
        `NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://${'du'}go.capital/callback`,
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=dev:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.local')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NEXT_PUBLIC_APP_URL')
    expect(result.stderr).toContain('NEXT_PUBLIC_WORKOS_REDIRECT_URI')
    expect(result.stderr).toContain('legacy product domain')
  })

  it('accepts a complete development env without launch-mode flags', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.local'),
      [
        'WORKOS_API_KEY=sk_test_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=http://localhost:3000',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=dev:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.local')

    expect(result.status).toBe(0)
  })

  // El validador dejó de gobernar el lanzamiento por bandera: el marketplace
  // está despublicado en el código. Un `SHERLOCK_PUBLIC_SITE_ONLY` residual en
  // el env de producción es inerte y no puede reportarse como hallazgo.
  it('ignores a leftover public-site-only flag in a production env', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [
        'WORKOS_API_KEY=sk_live_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        'SHERLOCK_PUBLIC_SITE_ONLY=enabled',
        ...PROD_VDR_ENV,
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.stderr).not.toContain('SHERLOCK_PUBLIC_SITE_ONLY')
    expect(result.stdout).not.toContain('SHERLOCK_PUBLIC_SITE_ONLY')
  })

  it.each([
    { label: 'missing', entry: undefined },
    { label: 'misspelled', entry: 'CONVEX_ENV=prodution' },
  ])('rejects a $label local CONVEX_ENV classification', ({ entry }) => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [
        'WORKOS_API_KEY=sk_live_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        ...(entry ? [entry] : []),
        ...PROD_VDR_ENV.slice(1),
        ...PROD_RUNTIME_ENV,
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CONVEX_ENV')
    expect(result.stderr).toContain(
      entry ? 'must be exactly production' : 'missing (must be exactly production'
    )
  })

  it('accepts a placeholder VDR MCP authority while the release gate is off', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = [
      ...PROD_APP_ENV,
      'VDR_MCP_OAUTH_AUDIENCE=not-a-url',
      'VDR_MCP_OAUTH_SCOPE_BASE=placeholder',
    ]
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('VDR_MCP_SERVER_SECRET')
  })

  it('rejects an invalid VDR MCP release state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const env = PROD_APP_ENV.map((entry) =>
      entry.startsWith('VDR_MCP_ENABLED=') ? 'VDR_MCP_ENABLED=enabled' : entry
    )
    writeFileSync(join(tempDir, '.env.production'), env.join('\n'))

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VDR_MCP_ENABLED')
  })

  it('requires Upstash unless production explicitly selects in-memory rate limiting', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      PROD_APP_ENV.filter((entry) => !entry.startsWith('RATE_LIMIT_PROVIDER=')).join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_URL')
    expect(result.stderr).toContain('UPSTASH_REDIS_REST_TOKEN')
  })

  it('requires both intake boundaries when demo mode is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [...PROD_APP_ENV, 'INTAKE_DEMO_MODE=true'].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INTAKE_SERVER_SECRET')
    expect(result.stderr).toContain('INTAKE_SERVER_AUDIENCE')
  })

  it('rejects intake boundaries that do not match Convex', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    const intakeEnv = [
      'INTAKE_DEMO_MODE=true',
      `INTAKE_SERVER_SECRET=${'n'.repeat(32)}`,
      'INTAKE_SERVER_AUDIENCE=sherlock-prod:intake-boundary',
    ]
    writeFileSync(join(tempDir, '.env.production'), [...PROD_APP_ENV, ...intakeEnv].join('\n'))
    const remoteEnv = [
      PROD_CONVEX_REMOTE_ENV,
      'INTAKE_DEMO_MODE=true',
      `INTAKE_SERVER_SECRET=${'x'.repeat(32)}`,
      'INTAKE_SERVER_AUDIENCE=sherlock-prod:intake-boundary',
    ].join('\n')

    const result = runSetupCheck(tempDir, '.env.production', [], remoteEnv)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INTAKE_SERVER_SECRET')
    expect(result.stderr).toContain('does not match app environment')
  })

  it.each(
    PROD_APP_ENV.filter((entry) => !entry.startsWith('RATE_LIMIT_PROVIDER=')).map((entry) => [
      entry.slice(0, entry.indexOf('=')),
    ])
  )('rejects missing required app env %s', (missingKey) => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      PROD_APP_ENV.filter((entry) => !entry.startsWith(`${missingKey}=`)).join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(missingKey)
  })

  it.each(SHARED_CONVEX_ENV_KEYS)('rejects a mismatched shared Convex env %s', (mismatchedKey) => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(join(tempDir, '.env.production'), PROD_APP_ENV.join('\n'))
    const remoteEnv = PROD_CONVEX_REMOTE_ENV.split('\n')
      .map((entry) => {
        if (!entry.startsWith(`${mismatchedKey}=`)) return entry
        if (mismatchedKey.endsWith('_URL')) return `${mismatchedKey}=https://other.example/v1`
        if (mismatchedKey.endsWith('_AUDIENCE')) return `${mismatchedKey}=other:boundary`
        if (mismatchedKey === 'WORKOS_CLIENT_ID') return `${mismatchedKey}=client_other`
        return `${mismatchedKey}=${'z'.repeat(32)}`
      })
      .join('\n')

    const result = runSetupCheck(tempDir, '.env.production', [], remoteEnv)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(mismatchedKey)
    expect(result.stderr).toContain('does not match app environment')
  })

  it('rejects missing production VDR scanner and guest cryptography prerequisites', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
    writeFileSync(
      join(tempDir, '.env.production'),
      [
        'WORKOS_API_KEY=sk_live_workos',
        'WORKOS_CLIENT_ID=client_prod_workos',
        'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
        'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
        'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
        'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
        'CONVEX_DEPLOYMENT=prod:example',
        'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
        'WEBHOOK_SECRET=shared_webhook_secret',
        'STORAGE_SECRET=shared_document_delivery_secret',
        'CONVEX_ENV=production',
      ].join('\n')
    )

    const result = runSetupCheck(tempDir, '.env.production', [], '')

    expect(result.status).toBe(1)
    for (const key of [
      'VDR_FILE_SCANNER_URL',
      'VDR_FILE_SCANNER_TOKEN',
      'GUEST_IDENTITY_HASH_SECRET',
      'GUEST_OTP_PEPPER',
    ]) {
      expect(result.stderr).toContain(key)
    }
  })

  it.each([
    { label: 'missing', remotePrefix: [] },
    { label: 'misspelled', remotePrefix: ['CONVEX_ENV=prodution'] },
  ])(
    'rejects a $label remote CONVEX_ENV even with all other controls present',
    ({ label, remotePrefix }) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sherlock-prod-setup-'))
      writeFileSync(
        join(tempDir, '.env.production'),
        [
          'WORKOS_API_KEY=sk_live_workos',
          'WORKOS_CLIENT_ID=client_prod_workos',
          'WORKOS_COOKIE_PASSWORD=replace_with_32_plus_characters_long', // gitleaks:allow -- deterministic test fixture, not a provider credential
          'WORKOS_WEBHOOK_SECRET=Pv_example_workos_secret',
          'NEXT_PUBLIC_APP_URL=https://sherlock.capital',
          'NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://sherlock.capital/callback',
          'NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud',
          'CONVEX_DEPLOY_KEY=prod:example|deploy-key',
          'WEBHOOK_SECRET=shared_webhook_secret',
          'STORAGE_SECRET=shared_document_delivery_secret',
          ...PROD_VDR_ENV,
          ...PROD_RUNTIME_ENV,
        ].join('\n')
      )
      const remoteWithoutValidClassification = [...remotePrefix, ...PROD_VDR_ENV.slice(1)].join(
        '\n'
      )

      const result = runSetupCheck(tempDir, '.env.production', [], remoteWithoutValidClassification)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('CONVEX_ENV')
      expect(result.stderr).toContain(
        label === 'missing'
          ? 'missing on the deployment'
          : 'must be exactly production on the deployment'
      )
    }
  )
})
