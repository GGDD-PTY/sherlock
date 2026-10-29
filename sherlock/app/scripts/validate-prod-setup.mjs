#!/usr/bin/env node
/**
 * Pre-flight validator for WorkOS + Convex production setup.
 * Reads the selected local env file and, when a deploy key is available,
 * verifies the exact remote Convex deployment. It never prints secret values.
 *
 * Usage:
 *   node scripts/validate-prod-setup.mjs
 *   node scripts/validate-prod-setup.mjs --ping-workos
 *   node scripts/validate-prod-setup.mjs --env-file .env.production.local
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  OBSERVABILITY_PROBE_PRODUCTION_ENV,
  RATE_LIMIT_OPT_OUT,
  REDIS_RATE_LIMIT_PRODUCTION_ENV,
  REQUIRED_PRODUCTION_APP_ENV,
  VDR_MCP_PRODUCTION_ENV,
} from './production-env-manifest.mjs'

const args = new Set(process.argv.slice(2))
const appRootArg = process.argv.find((a) => a.startsWith('--app-root='))
const root = resolve(process.cwd(), appRootArg?.slice('--app-root='.length) ?? '.')
const pingWorkos = args.has('--ping-workos')
const useProcessEnv = args.has('--process-env')
const envFileArg = process.argv.find((a) => a.startsWith('--env-file='))
const envFileOverride = envFileArg?.slice('--env-file='.length)

const envFiles = envFileOverride
  ? [envFileOverride]
  : ['.env.production.local', '.env.production', '.env.local', '.env']

const WORKOS_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'organization_membership.created',
  'organization_membership.updated',
  'organization_membership.deleted',
]

const VDR_MCP_TENANT_CLAIM = 'sherlock_tenant'
const WRITE_ONLY_PLACEHOLDER = '[SENSITIVE]'

const CONVEX_DASHBOARD_KEYS = [
  {
    key: 'CONVEX_ENV',
    note: 'Must be exactly production; only explicit dev may use local security fallbacks',
  },
  { key: 'WORKOS_CLIENT_ID', note: 'Must match app WORKOS_CLIENT_ID (auth.config.ts JWKS)' },
  { key: 'WEBHOOK_SECRET', note: 'Same value as app WEBHOOK_SECRET (credits/webhooks)' },
  {
    key: 'STORAGE_SECRET',
    note: 'Same value as app STORAGE_SECRET (document delivery proof)',
  },
  {
    key: 'VDR_FILE_SCANNER_URL',
    note: 'Private HTTPS scanning gateway; required outside explicit dev',
  },
  {
    key: 'VDR_FILE_SCANNER_TOKEN',
    note: 'Server-only scanner credential; required outside explicit dev',
  },
  {
    key: 'GUEST_IDENTITY_HASH_SECRET',
    note: 'At least 32 characters; required outside explicit dev',
  },
  {
    key: 'GUEST_OTP_PEPPER',
    note: 'At least 32 characters; required outside explicit dev',
  },
  {
    key: 'VDR_GUEST_SERVER_SECRET',
    note: 'Same value as app VDR_GUEST_SERVER_SECRET',
  },
  {
    key: 'VDR_GUEST_SERVER_AUDIENCE',
    note: 'Same value as app VDR_GUEST_SERVER_AUDIENCE',
  },
  {
    key: 'ADMIN_VDR_CAPABILITY_SECRET',
    note: 'Same value as app ADMIN_VDR_CAPABILITY_SECRET',
  },
]
const VDR_MCP_CONVEX_KEYS = [
  {
    key: 'VDR_MCP_SERVER_SECRET',
    note: 'Same value as app VDR_MCP_SERVER_SECRET',
  },
  {
    key: 'VDR_MCP_SERVER_AUDIENCE',
    note: 'Same value as app VDR_MCP_SERVER_AUDIENCE',
  },
]
const SHARED_CONVEX_APP_KEYS = CONVEX_DASHBOARD_KEYS.map(({ key }) => key).filter(
  (key) => key !== 'CONVEX_ENV'
)

function parseEnv(content) {
  const map = new Map()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = normalized.indexOf('=')
    if (separator === -1) continue
    const key = normalized.slice(0, separator).trim()
    const value = normalized
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key) map.set(key, value)
  }
  return map
}

function loadEnvMap() {
  if (useProcessEnv) {
    return {
      map: new Map(
        Object.entries(process.env).filter(
          (entry) => typeof entry[1] === 'string' && entry[1].trim().length > 0
        )
      ),
      source: 'process environment',
    }
  }
  for (const envFile of envFiles) {
    const fullPath = join(root, envFile)
    if (!existsSync(fullPath)) continue
    return { map: parseEnv(readFileSync(fullPath, 'utf8')), source: basename(envFile) }
  }
  return { map: new Map(), source: null }
}

const findings = []
const writeOnlyKeys = new Set()

function fail(key, reason) {
  if (writeOnlyKeys.has(key)) return
  findings.push({ key, reason })
}

function getPresent(map, key) {
  const value = map.get(key)
  return value?.trim() ? value.trim() : undefined
}

function isWriteOnly(value) {
  return value === WRITE_ONLY_PLACEHOLDER
}

function getKnown(map, key) {
  const value = getPresent(map, key)
  return isWriteOnly(value) ? undefined : value
}

function containsLegacyProductDomain(value) {
  return /(^|[.@/:])d[u]go\.(lat|capital)(?=$|[/:?@"\s>])/i.test(value)
}

function isBoundedSecret(value) {
  return value.length >= 32 && value.length <= 4_096
}

function isBoundaryAudience(value) {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function isHttpsUrl(value, exactPath) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.search === '' &&
      (!exactPath || url.pathname === exactPath)
    )
  } catch {
    return false
  }
}

function convexDeploymentName(value) {
  return /^(?:dev|prod|preview):([^:|\s]+)$/.exec(value.split('|')[0].trim())?.[1]
}

function isLocalOrigin(url) {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1' ||
    url.hostname.endsWith('.localhost')
  )
}

const { map, source } = loadEnvMap()

for (const [key, value] of map) {
  if (isWriteOnly(value.trim())) writeOnlyKeys.add(key)
}

if (!source) {
  console.error('No env file found. Create .env.local or pass --env-file=.env.production.local')
  process.exit(1)
}

const productionEnvFile = source === '.env.production' || source === '.env.production.local'

console.log(`Validating prod setup from ${source} (values redacted).\n`)

for (const { key, reason } of REQUIRED_PRODUCTION_APP_ENV) {
  if (!getPresent(map, key)) fail(key, `missing (${reason})`)
}

const apiKey = getKnown(map, 'WORKOS_API_KEY')
const clientId = getKnown(map, 'WORKOS_CLIENT_ID')
const cookiePassword = getKnown(map, 'WORKOS_COOKIE_PASSWORD')
const webhookSecret = getKnown(map, 'WORKOS_WEBHOOK_SECRET')
const appUrl = getKnown(map, 'NEXT_PUBLIC_APP_URL')
const redirectUri = getKnown(map, 'NEXT_PUBLIC_WORKOS_REDIRECT_URI')
const convexUrl = getKnown(map, 'NEXT_PUBLIC_CONVEX_URL')
const convexDeployKey = getKnown(map, 'CONVEX_DEPLOY_KEY')
const sharedWebhookSecret = getKnown(map, 'WEBHOOK_SECRET')
const storageSecret = getKnown(map, 'STORAGE_SECRET')
const convexEnv = getKnown(map, 'CONVEX_ENV')
const scannerUrl = getKnown(map, 'VDR_FILE_SCANNER_URL')
const scannerToken = getKnown(map, 'VDR_FILE_SCANNER_TOKEN')
const guestIdentitySecret = getKnown(map, 'GUEST_IDENTITY_HASH_SECRET')
const guestOtpPepper = getKnown(map, 'GUEST_OTP_PEPPER')
const vdrGuestServerSecret = getKnown(map, 'VDR_GUEST_SERVER_SECRET')
const vdrGuestServerAudience = getKnown(map, 'VDR_GUEST_SERVER_AUDIENCE')
const adminVdrCapabilitySecret = getKnown(map, 'ADMIN_VDR_CAPABILITY_SECRET')
const vdrMcpEnabledValue = getKnown(map, 'VDR_MCP_ENABLED')
const vdrMcpEnabled = vdrMcpEnabledValue === 'true'
const oauthIssuer = getKnown(map, 'MCP_OAUTH_ISSUER')
const oauthJwksUrl = getKnown(map, 'MCP_OAUTH_JWKS_URL')
const oauthTenantClaim = getKnown(map, 'MCP_OAUTH_TENANT_CLAIM')
const oauthClientIdClaim = getKnown(map, 'MCP_OAUTH_CLIENT_ID_CLAIM')
const vdrMcpServerSecret = getKnown(map, 'VDR_MCP_SERVER_SECRET')
const vdrMcpServerAudience = getKnown(map, 'VDR_MCP_SERVER_AUDIENCE')
const vdrMcpOauthAudience = getKnown(map, 'VDR_MCP_OAUTH_AUDIENCE')
const vdrMcpOauthScopeBase = getKnown(map, 'VDR_MCP_OAUTH_SCOPE_BASE')
const rateLimitProvider = getKnown(map, RATE_LIMIT_OPT_OUT.key)
const intakeDemoMode = getKnown(map, 'INTAKE_DEMO_MODE')
const intakeServerSecret = getKnown(map, 'INTAKE_SERVER_SECRET')
const intakeServerAudience = getKnown(map, 'INTAKE_SERVER_AUDIENCE')

if (vdrMcpEnabledValue !== 'true' && vdrMcpEnabledValue !== 'false') {
  fail('VDR_MCP_ENABLED', 'must be exactly true or false')
}
if (vdrMcpEnabled) {
  for (const { key, reason } of VDR_MCP_PRODUCTION_ENV) {
    if (!getPresent(map, key)) fail(key, `required when VDR_MCP_ENABLED=true (${reason})`)
  }
}

if (!apiKey) fail('WORKOS_API_KEY', 'missing')
else if (!/^sk_(test|live)_/.test(apiKey))
  fail('WORKOS_API_KEY', 'expected prefix sk_test_ or sk_live_')

if (!clientId) fail('WORKOS_CLIENT_ID', 'missing')
else if (!/^client_/.test(clientId)) fail('WORKOS_CLIENT_ID', 'expected prefix client_')

if (!cookiePassword) fail('WORKOS_COOKIE_PASSWORD', 'missing')
else if (cookiePassword.length < 32)
  fail('WORKOS_COOKIE_PASSWORD', 'must be at least 32 characters')

if (!webhookSecret) fail('WORKOS_WEBHOOK_SECRET', 'missing')
else if (webhookSecret.length < 16) fail('WORKOS_WEBHOOK_SECRET', 'must be at least 16 characters')

let parsedAppUrl
if (!appUrl) fail('NEXT_PUBLIC_APP_URL', 'missing')
else {
  try {
    parsedAppUrl = new URL(appUrl)
    if (containsLegacyProductDomain(appUrl)) {
      fail('NEXT_PUBLIC_APP_URL', 'legacy product domain is not allowed for Sherlock beta')
    }
  } catch {
    fail('NEXT_PUBLIC_APP_URL', 'invalid URL')
  }
}

let parsedRedirectUri
if (!redirectUri) fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'missing')
else {
  try {
    const url = new URL(redirectUri)
    parsedRedirectUri = url
    if (containsLegacyProductDomain(redirectUri)) {
      fail(
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
        'legacy product domain is not allowed for Sherlock beta'
      )
    }
    if (url.pathname !== '/callback') {
      fail(
        'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
        'path must be exactly /callback (see src/app/callback/route.ts)'
      )
    }
    if (url.username || url.password || url.search || url.hash) {
      fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'must not carry credentials, query, or fragment')
    }
  } catch {
    fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'invalid URL')
  }
}

const convexDeployment = getKnown(map, 'CONVEX_DEPLOYMENT')
const deploymentName = convexDeployment ? convexDeploymentName(convexDeployment) : undefined

if (!convexUrl) fail('NEXT_PUBLIC_CONVEX_URL', 'missing')
else {
  let convexHost
  try {
    const url = new URL(convexUrl)
    if (url.protocol === 'https:' && /\.convex\.(cloud|site)$/.test(url.hostname)) {
      convexHost = url.hostname
    }
  } catch {
    convexHost = undefined
  }
  if (!convexHost) {
    fail('NEXT_PUBLIC_CONVEX_URL', 'expected an https://<deployment>.convex.cloud URL')
  } else if (deploymentName && convexHost.split('.')[0] !== deploymentName) {
    fail(
      'NEXT_PUBLIC_CONVEX_URL',
      `does not match CONVEX_DEPLOYMENT (expected ${deploymentName}.convex.cloud)`
    )
  }
}

if (!convexDeployKey) {
  fail('CONVEX_DEPLOY_KEY', 'missing (required for WorkOS webhook → Convex admin client)')
} else {
  const deployKeyName = convexDeploymentName(convexDeployKey)
  if (deployKeyName && deploymentName && deployKeyName !== deploymentName) {
    fail(
      'CONVEX_DEPLOY_KEY',
      `points at deployment ${deployKeyName}, not the selected CONVEX_DEPLOYMENT`
    )
  }
}
if (!sharedWebhookSecret) fail('WEBHOOK_SECRET', 'missing (must match Convex deployment env)')
if (!storageSecret) fail('STORAGE_SECRET', 'missing (must match Convex deployment env)')

if (convexEnv !== 'production') {
  fail(
    'CONVEX_ENV',
    convexEnv
      ? 'must be exactly production for this production preflight'
      : 'missing (must be exactly production for this production preflight)'
  )
}

if (!scannerUrl) {
  fail('VDR_FILE_SCANNER_URL', 'missing (required in app and Convex production env)')
} else {
  try {
    const url = new URL(scannerUrl)
    if (url.protocol !== 'https:') {
      fail('VDR_FILE_SCANNER_URL', 'must use https in production')
    }
  } catch {
    fail('VDR_FILE_SCANNER_URL', 'invalid URL')
  }
}
if (!scannerToken) {
  fail('VDR_FILE_SCANNER_TOKEN', 'missing (required in app and Convex production env)')
}
if (!guestIdentitySecret) {
  fail('GUEST_IDENTITY_HASH_SECRET', 'missing (required in Convex production env)')
} else if (guestIdentitySecret.length < 32) {
  fail('GUEST_IDENTITY_HASH_SECRET', 'must be at least 32 characters')
}
if (!guestOtpPepper) {
  fail('GUEST_OTP_PEPPER', 'missing (required in Convex production env)')
} else if (guestOtpPepper.length < 32) {
  fail('GUEST_OTP_PEPPER', 'must be at least 32 characters')
}
if (vdrGuestServerSecret && !isBoundedSecret(vdrGuestServerSecret)) {
  fail('VDR_GUEST_SERVER_SECRET', 'must be between 32 and 4096 characters')
}
if (vdrGuestServerAudience && !isBoundaryAudience(vdrGuestServerAudience)) {
  fail('VDR_GUEST_SERVER_AUDIENCE', 'invalid deployment audience')
}
if (adminVdrCapabilitySecret && !isBoundedSecret(adminVdrCapabilitySecret)) {
  fail('ADMIN_VDR_CAPABILITY_SECRET', 'must be between 32 and 4096 characters')
}
if (vdrMcpEnabled) {
  if (oauthIssuer && (oauthIssuer.length > 2_048 || !isHttpsUrl(oauthIssuer))) {
    fail('MCP_OAUTH_ISSUER', 'must be a bounded HTTPS issuer URL')
  }
  if (oauthJwksUrl && !isHttpsUrl(oauthJwksUrl)) {
    fail('MCP_OAUTH_JWKS_URL', 'must be an HTTPS JWKS URL')
  }
  const claimNamePattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/
  if (
    oauthTenantClaim &&
    (!claimNamePattern.test(oauthTenantClaim) || oauthTenantClaim === 'sub')
  ) {
    fail('MCP_OAUTH_TENANT_CLAIM', 'invalid tenant claim name')
  }
  if (
    oauthClientIdClaim &&
    (!claimNamePattern.test(oauthClientIdClaim) ||
      oauthClientIdClaim === 'sub' ||
      oauthClientIdClaim === oauthTenantClaim)
  ) {
    fail('MCP_OAUTH_CLIENT_ID_CLAIM', 'invalid or duplicate client claim name')
  }
}
if (vdrMcpEnabled) {
  if (vdrMcpServerSecret && !isBoundedSecret(vdrMcpServerSecret)) {
    fail('VDR_MCP_SERVER_SECRET', 'must be between 32 and 4096 characters')
  }
  if (vdrMcpServerAudience && !isBoundaryAudience(vdrMcpServerAudience)) {
    fail('VDR_MCP_SERVER_AUDIENCE', 'invalid deployment audience')
  }
}
if (vdrMcpEnabled) {
  if (
    vdrMcpOauthAudience &&
    (vdrMcpOauthAudience.length > 2_048 || !isHttpsUrl(vdrMcpOauthAudience, '/api/vdr-mcp'))
  ) {
    fail('VDR_MCP_OAUTH_AUDIENCE', 'must be the canonical HTTPS /api/vdr-mcp URL')
  }
  if (vdrMcpOauthAudience && parsedAppUrl) {
    let audienceOrigin
    try {
      audienceOrigin = new URL(vdrMcpOauthAudience).origin
    } catch {
      audienceOrigin = undefined
    }
    if (audienceOrigin !== parsedAppUrl.origin) {
      fail('VDR_MCP_OAUTH_AUDIENCE', 'must be served from the public app origin')
    }
  }
  if (oauthTenantClaim && oauthTenantClaim !== VDR_MCP_TENANT_CLAIM) {
    fail(
      'MCP_OAUTH_TENANT_CLAIM',
      `must be exactly ${VDR_MCP_TENANT_CLAIM}, the tenant claim WorkOS emits for the VDR resource`
    )
  }
  if (vdrMcpOauthScopeBase && vdrMcpOauthScopeBase !== 'openid') {
    fail('VDR_MCP_OAUTH_SCOPE_BASE', 'must be the WorkOS-supported openid scope')
  }
}
if (!writeOnlyKeys.has(RATE_LIMIT_OPT_OUT.key) && rateLimitProvider !== RATE_LIMIT_OPT_OUT.value) {
  for (const { key, reason } of REDIS_RATE_LIMIT_PRODUCTION_ENV) {
    if (!getPresent(map, key)) {
      fail(key, `required unless ${RATE_LIMIT_OPT_OUT.key}=${RATE_LIMIT_OPT_OUT.value} (${reason})`)
    }
  }
}
if (intakeDemoMode && intakeDemoMode !== 'true' && intakeDemoMode !== 'false') {
  fail('INTAKE_DEMO_MODE', 'must be exactly true or false')
}
if (intakeDemoMode === 'true') {
  if (!intakeServerSecret) {
    fail('INTAKE_SERVER_SECRET', 'required when INTAKE_DEMO_MODE=true')
  } else if (!isBoundedSecret(intakeServerSecret)) {
    fail('INTAKE_SERVER_SECRET', 'must be between 32 and 4096 characters')
  }
  if (!intakeServerAudience) {
    fail('INTAKE_SERVER_AUDIENCE', 'required when INTAKE_DEMO_MODE=true')
  } else if (!isBoundaryAudience(intakeServerAudience)) {
    fail('INTAKE_SERVER_AUDIENCE', 'invalid deployment audience')
  }
}

// Carril opt-in: sin la variable el probe responde 404 y no hay nada que
// comprobar. Configurada pero corta, `env.ts` la rechaza al arrancar y eso es
// un 500 en TODO el sitio, así que el formato sí se valida cuando está puesta.
for (const { key, reason } of OBSERVABILITY_PROBE_PRODUCTION_ENV) {
  const value = getKnown(map, key)
  if (value && !isBoundedSecret(value)) {
    fail(key, `must be between 32 and 4096 characters (${reason})`)
  }
}

if (parsedAppUrl && parsedRedirectUri) {
  const appOrigin = parsedAppUrl.origin
  const redirect = parsedRedirectUri
  const productionLike = appOrigin !== 'http://localhost:3000'
  if (productionEnvFile && isLocalOrigin(parsedAppUrl)) {
    fail('NEXT_PUBLIC_APP_URL', 'must not point at localhost in a production env file')
  }
  if (productionEnvFile && isLocalOrigin(redirect)) {
    fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'must not point at localhost in a production env file')
  }
  if (productionLike && redirect.protocol !== 'https:') {
    fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'must use HTTPS outside localhost')
  }
  if (productionLike && redirect.origin !== appOrigin) {
    fail('NEXT_PUBLIC_WORKOS_REDIRECT_URI', 'must share the public app origin')
  }
  if (productionLike && apiKey?.startsWith('sk_test_')) {
    fail('WORKOS_API_KEY', 'production-looking app origins require an sk_live_ key')
  }
}

if (findings.length === 0 && writeOnlyKeys.size === 0) {
  console.log('Format checks passed for WorkOS + Convex app env.\n')
} else if (findings.length > 0) {
  console.error('Setup validation failed:\n')
  for (const { key, reason } of findings) {
    console.error(`  ✗ ${key}: ${reason}`)
  }
  console.error('')
}

if (writeOnlyKeys.size > 0) {
  console.error('Setup validation UNKNOWN: write-only — verify in Vercel')
  for (const key of [...writeOnlyKeys].sort()) {
    console.error(`  ? ${key}: write-only — verify in Vercel`)
  }
  console.error('')
}

console.log('WorkOS dashboard checklist:')
const redirectUriDisplay = parsedRedirectUri
  ? `${parsedRedirectUri.origin}${parsedRedirectUri.pathname}`
  : writeOnlyKeys.has('NEXT_PUBLIC_WORKOS_REDIRECT_URI')
    ? '<write-only — verify in Vercel>'
    : redirectUri
      ? '<invalid NEXT_PUBLIC_WORKOS_REDIRECT_URI>'
      : '<set NEXT_PUBLIC_WORKOS_REDIRECT_URI>'
console.log(`  • Redirect URI: ${redirectUriDisplay}`)
console.log('  • Events webhook: https://<your-domain>/api/webhooks/workos')
console.log('  • Subscribe to events:')
for (const event of WORKOS_EVENTS) {
  console.log(`      - ${event}`)
}

console.log('\nConvex dashboard → Settings → Environment variables:')
const convexDashboardKeys = [
  ...CONVEX_DASHBOARD_KEYS,
  ...(vdrMcpEnabled ? VDR_MCP_CONVEX_KEYS : []),
]
for (const { key, note } of convexDashboardKeys) {
  const value = getPresent(map, key)
  const present = isWriteOnly(value)
    ? 'write-only — verify in Vercel'
    : value
      ? 'present in app env'
      : 'set in Convex dashboard'
  console.log(`  • ${key} (${note}) — ${present}`)
}
// ===== PROD SECURITY PREREQUISITES en el deployment remoto =====
// Con CONVEX_DEPLOY_KEY presente, consulta el env real del deployment al que
// apunta el deploy key y FALLA si hay bypass dev o faltan gates VDR obligatorios.
// Sin deploy key, queda como recordatorio manual (no hay forma de verificar).
if (convexDeployKey) {
  console.log('  • Production VDR security — checking remote deployment env...')
  // fail() + print inmediato: el listado "Setup validation failed" ya corrió
  // arriba, así que este check tardío reporta lo suyo aquí mismo.
  const failRemote = (key, reason) => {
    findings.push({ key, reason })
    console.error(`    ✗ ${key}: ${reason}`)
  }
  const knownProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => !isWriteOnly(value?.trim()))
  )
  const result = spawnSync('bunx', ['convex', 'env', 'list'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...knownProcessEnv, CONVEX_DEPLOY_KEY: convexDeployKey },
    timeout: 60_000,
  })
  if (result.status === 0 && typeof result.stdout === 'string') {
    const remoteEnv = parseEnv(result.stdout)
    const bypassAuth = getKnown(remoteEnv, 'BYPASS_AUTH')?.toLowerCase()
    const remoteConvexEnv = getKnown(remoteEnv, 'CONVEX_ENV')
    let remoteClean = true
    let remoteUnknown = writeOnlyKeys.size > 0
    const rejectRemote = (key, reason) => {
      remoteClean = false
      failRemote(key, reason)
    }
    if (bypassAuth && ['true', '1', 'yes', 'on'].includes(bypassAuth)) {
      rejectRemote(
        'BYPASS_AUTH',
        'set on the deployment the deploy key points at — unset it (bun x convex env remove BYPASS_AUTH) before prod'
      )
    }
    if (remoteConvexEnv !== 'production') {
      rejectRemote(
        'CONVEX_ENV',
        remoteConvexEnv
          ? 'must be exactly production on the deployment the deploy key points at'
          : 'missing on the deployment the deploy key points at'
      )
    }
    const appIntakeMode = intakeDemoMode === 'true'
    const remoteIntakeMode = getKnown(remoteEnv, 'INTAKE_DEMO_MODE') === 'true'
    if (!writeOnlyKeys.has('INTAKE_DEMO_MODE') && appIntakeMode !== remoteIntakeMode) {
      rejectRemote('INTAKE_DEMO_MODE', 'does not match app environment')
    }
    const sharedKeys = [...SHARED_CONVEX_APP_KEYS]
    if (vdrMcpEnabled) {
      sharedKeys.push(...VDR_MCP_CONVEX_KEYS.map(({ key }) => key))
    }
    if (appIntakeMode) sharedKeys.push('INTAKE_SERVER_SECRET', 'INTAKE_SERVER_AUDIENCE')
    for (const key of sharedKeys) {
      const appValue = getKnown(map, key)
      const remoteValue = getKnown(remoteEnv, key)
      if (writeOnlyKeys.has(key)) remoteUnknown = true
      if (!remoteValue) {
        rejectRemote(key, 'missing on the production Convex deployment')
      } else if (!writeOnlyKeys.has(key) && (!appValue || remoteValue !== appValue)) {
        rejectRemote(key, 'does not match app environment')
      }
    }
    const remoteScannerUrl = getKnown(remoteEnv, 'VDR_FILE_SCANNER_URL')
    if (!remoteScannerUrl) {
      rejectRemote('VDR_FILE_SCANNER_URL', 'missing on the production Convex deployment')
    } else {
      try {
        if (new URL(remoteScannerUrl).protocol !== 'https:') {
          rejectRemote('VDR_FILE_SCANNER_URL', 'must use https on the production deployment')
        }
      } catch {
        rejectRemote('VDR_FILE_SCANNER_URL', 'invalid URL on the production deployment')
      }
    }
    if (!getKnown(remoteEnv, 'VDR_FILE_SCANNER_TOKEN')) {
      rejectRemote('VDR_FILE_SCANNER_TOKEN', 'missing on the production Convex deployment')
    }
    const remoteGuestIdentitySecret = getKnown(remoteEnv, 'GUEST_IDENTITY_HASH_SECRET')
    if (!remoteGuestIdentitySecret || remoteGuestIdentitySecret.length < 32) {
      rejectRemote(
        'GUEST_IDENTITY_HASH_SECRET',
        'missing or shorter than 32 characters on the production Convex deployment'
      )
    }
    const remoteGuestOtpPepper = getKnown(remoteEnv, 'GUEST_OTP_PEPPER')
    if (!remoteGuestOtpPepper || remoteGuestOtpPepper.length < 32) {
      rejectRemote(
        'GUEST_OTP_PEPPER',
        'missing or shorter than 32 characters on the production Convex deployment'
      )
    }
    if (remoteClean && !remoteUnknown) {
      console.log('    ✓ remote deployment has production VDR security prerequisites')
    } else if (remoteClean) {
      console.log(
        '    ? remote deployment parity is UNKNOWN — write-only app values require verification in Vercel'
      )
    }
  } else {
    failRemote(
      'CONVEX_DEPLOY_KEY',
      `could not list remote Convex env (bunx convex env list exited ${result.status ?? 'with error'}) — verify the deploy key/deployment manually`
    )
  }
} else if (writeOnlyKeys.has('CONVEX_DEPLOY_KEY')) {
  console.log(
    '  • remote Convex verification is UNKNOWN — CONVEX_DEPLOY_KEY is write-only; verify in Vercel'
  )
} else {
  console.log(
    '  • Ensure BYPASS_AUTH is unset on prod deployment (set CONVEX_DEPLOY_KEY to verify remotely)'
  )
}

if (pingWorkos && apiKey) {
  console.log('\nPinging WorkOS API...')
  try {
    const res = await fetch('https://api.workos.com/user_management/users?limit=1', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      console.log('  ✓ WORKOS_API_KEY accepted (HTTP 200)')
    } else {
      console.error(`  ✗ WorkOS API returned HTTP ${res.status}`)
      process.exit(findings.length > 0 ? 1 : 1)
    }
  } catch (error) {
    console.error(
      `  ✗ WorkOS API ping failed: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
} else if (pingWorkos && !writeOnlyKeys.has('WORKOS_API_KEY')) {
  console.error('\n--ping-workos skipped: WORKOS_API_KEY missing')
}

process.exit(findings.length > 0 ? 1 : writeOnlyKeys.size > 0 ? 2 : 0)
