#!/usr/bin/env node
// ============================================================================
// CONVEX LOCAL — backend aislado para desarrollo y pruebas
// ============================================================================
// `backend` y `dev` arrancan sin sembrar empresas ni documentos.
// `seed`, `seed:company` y `seed:portfolio` agregan datos sintéticos a petición.
// La base y los secretos viven en .convex-local/, fuera de git.
// Los puertos se pueden ajustar con PORT, CONVEX_LOCAL_CLOUD_PORT y
// CONVEX_LOCAL_SITE_PORT. La app se limita a 127.0.0.1.
// ============================================================================

import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const scriptPath = import.meta.filename
const scriptDir = import.meta.dirname
const appDir = path.resolve(scriptDir, '..')
const sandboxDir = path.join(appDir, '.convex-local')
const secretsFile = path.join(sandboxDir, 'local-secrets.env')
const devMcpPrivateKeyFile = path.join(sandboxDir, 'dev-mcp-private.pem')
const devMcpJwksFile = path.join(sandboxDir, 'dev-jwks.json')
const DEV_MCP_KID = 'dev-local-mcp-1'
const DEV_MCP_TENANT_ID = 'dev-local'
const DEV_MCP_CLIENT_ID = 'claude-code-local'
const DEV_MCP_SCOPE = 'openid'
const DEV_MCP_ROLE_CLAIM = 'sherlock_role'
const MAX_MCP_TOKEN_MINUTES = 1_440
const FIXED_DEV_WORKOS_SUBJECTS = {
  'admin@dev.local': 'dev_admin_001_workos',
  'company@dev.local': 'dev_company_001_workos',
  'company2@dev.local': 'dev_company_002_workos',
}
const backendStateDir = path.join(sandboxDir, '.convex')
const backendConfigFile = path.join(backendStateDir, 'local', 'default', 'config.json')
const convexBin = resolveConvexBin()

// Puertos del backend local: 3210/3211 por defecto. `CONVEX_LOCAL_CLOUD_PORT` y
// `CONVEX_LOCAL_SITE_PORT` los mueven, para que varios worktrees corran cada
// uno su propio backend a la vez (cada uno con su `.convex-local/`).
const CLOUD_PORT = Number(process.env.CONVEX_LOCAL_CLOUD_PORT || 3210)
const SITE_PORT = Number(process.env.CONVEX_LOCAL_SITE_PORT || 3211)
// Puerto de la app local, independiente de otros servidores de desarrollo.
const APP_PORT = process.env.PORT || '3100'
const APP_ORIGIN = `http://localhost:${APP_PORT}`
const CONVEX_URL = `http://127.0.0.1:${CLOUD_PORT}`
const CONVEX_SITE_URL = `http://127.0.0.1:${SITE_PORT}`
const DEPLOYMENT = 'anonymous:anonymous-agent'
const LOCAL_WORKOS_CLIENT_ID = 'client_local_dev_only'
const SEED_FUNCTION = '_localSeed:seed'
const SEED_COMPANY_FUNCTION = '_localSeed:seedCompany'
export const MAX_SEED_COMPANY_DOCUMENTS = 200
export const MAX_SEED_PORTFOLIO_COMPANIES = 50
export const PORTFOLIO_PROFILES = ['vacio', 'completo', 'desordenado']
export const PORTFOLIO_DOCUMENTS_BY_PROFILE = {
  vacio: 4,
  completo: 12,
  desordenado: 30,
}

// Nombres deliberadamente sintéticos, sin relación con empresas reales.
export const PORTFOLIO_COMPANY_NAMES = Array.from(
  { length: MAX_SEED_PORTFOLIO_COMPANIES },
  (_, index) => `Empresa Sintética ${String(index + 1).padStart(2, '0')}, S. A.`
)

// Secretos que la app y Convex tienen que compartir byte por byte: un proof
// firmado de un lado se verifica del otro. Se generan una vez y se reusan, o
// cada arranque invalidaría las URLs firmadas de los documentos ya sembrados.
const SHARED_SECRET_KEYS = [
  'WORKOS_COOKIE_PASSWORD',
  'STORAGE_SECRET',
  'WEBHOOK_SECRET',
  'VDR_GUEST_SERVER_SECRET',
  'ADMIN_VDR_CAPABILITY_SECRET',
  'INTAKE_SERVER_SECRET',
  'GUEST_IDENTITY_HASH_SECRET',
  'GUEST_OTP_PEPPER',
  'VDR_MCP_SERVER_SECRET',
]

function resolveConvexBin() {
  const candidates = [
    path.join(appDir, 'node_modules', '.bin', 'convex'),
    path.join(appDir, '..', '..', 'node_modules', '.bin', 'convex'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    console.error('No encuentro el CLI de Convex. Corre `bun install` primero.')
    process.exit(1)
  }
  return found
}

function parseEnvFile(file) {
  if (!existsSync(file)) return {}
  const parsed = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    parsed[match[1]] = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return parsed
}

function serializeEnv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
}

function ensureDevMcpIssuer() {
  if (existsSync(devMcpPrivateKeyFile) && existsSync(devMcpJwksFile)) return
  mkdirSync(sandboxDir, { recursive: true })
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(devMcpPrivateKeyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  })
  const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: DEV_MCP_KID,
    alg: 'RS256',
    use: 'sig',
  }
  writeFileSync(devMcpJwksFile, `${JSON.stringify({ keys: [jwk] })}\n`)
}

function encodeJwtJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function seedIdentitySlug(email) {
  return email
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

export function workosSubjectForDevEmail(email) {
  const normalized = email.trim().toLowerCase()
  if (FIXED_DEV_WORKOS_SUBJECTS[normalized]) return FIXED_DEV_WORKOS_SUBJECTS[normalized]
  if (!normalized.endsWith('@dev.local') || normalized.length <= '@dev.local'.length) {
    throw new Error('--email tiene que ser un correo @dev.local')
  }
  return `dev_${seedIdentitySlug(normalized)}_workos`
}

const MCP_TOKEN_SCOPES = new Set(['openid', 'vdr:write'])

export function parseMcpScope(raw) {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) {
    throw new Error('--scope no puede estar vacío')
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error('--scope no admite duplicados')
  }
  for (const token of tokens) {
    if (!MCP_TOKEN_SCOPES.has(token)) {
      throw new Error(`alcance no permitido: ${token}`)
    }
  }
  if (!tokens.includes('openid')) {
    throw new Error('--scope debe incluir openid')
  }
  return tokens.join(' ')
}

// El banco local imita el JWT template de WorkOS, que manda el slug del rol de
// la membresía. Cualquier slug entra a propósito: así se puede probar que un
// rol sin escritura (`member`) recibe 403 del servidor.
const MCP_TOKEN_ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

export function parseMcpRole(raw) {
  const role = raw.trim()
  if (!MCP_TOKEN_ROLE_PATTERN.test(role)) {
    throw new Error('--role debe ser un slug en minúsculas, por ejemplo company_owner')
  }
  return role
}

export function parseMcpTokenArgs(argv) {
  let email = null
  let minutes = 60
  let scope = DEV_MCP_SCOPE
  let role = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--email') {
      email = requireFlagValue(arg, argv, ++index)
      continue
    }
    if (arg === '--minutos') {
      const raw = requireFlagValue(arg, argv, ++index)
      if (!/^\d+$/.test(raw)) {
        throw new Error('--minutos debe ser un entero mayor o igual a 1')
      }
      minutes = Number(raw)
      continue
    }
    if (arg === '--scope') {
      scope = parseMcpScope(requireFlagValue(arg, argv, ++index))
      continue
    }
    if (arg === '--role') {
      role = parseMcpRole(requireFlagValue(arg, argv, ++index))
      continue
    }
    throw new Error(`argumento desconocido: ${arg}`)
  }
  if (!email || !email.trim()) {
    throw new Error('--email es obligatorio')
  }
  const normalized = email.trim().toLowerCase()
  if (!normalized.endsWith('@dev.local') || normalized.length <= '@dev.local'.length) {
    throw new Error('--email tiene que ser un correo @dev.local')
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MCP_TOKEN_MINUTES) {
    throw new Error(`--minutos debe estar entre 1 y ${MAX_MCP_TOKEN_MINUTES}`)
  }
  return { email: normalized, minutes, scope, role }
}

function mintDevMcpToken({ email, minutes, scope, role }) {
  ensureSandbox()
  ensureDevMcpIssuer()
  const subject = workosSubjectForDevEmail(email)
  const privateKey = createPrivateKey(readFileSync(devMcpPrivateKeyFile))
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const header = encodeJwtJson({ alg: 'RS256', kid: DEV_MCP_KID, typ: 'JWT' })
  const payload = encodeJwtJson({
    iss: `${APP_ORIGIN}/api/dev`,
    aud: `${APP_ORIGIN}/api/vdr-mcp`,
    sub: subject,
    organization_id: DEV_MCP_TENANT_ID,
    client_id: DEV_MCP_CLIENT_ID,
    scope,
    ...(role === null ? {} : { [DEV_MCP_ROLE_CLAIM]: role }),
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + minutes * 60,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

function commandMcpToken() {
  let args
  try {
    args = parseMcpTokenArgs(process.argv.slice(3))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  const token = mintDevMcpToken(args)
  const audience = `${APP_ORIGIN}/api/vdr-mcp`
  process.stdout.write(`${token}\n`)
  process.stdout.write(
    `claude mcp add --transport http sherlock-local ${audience} --header "Authorization: Bearer ${token}"\n`
  )
}

function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return
  writeFileSync(file, content)
}

function ensureSandbox() {
  mkdirSync(sandboxDir, { recursive: true })
  // El sandbox se auto-ignora: adentro viven la base sqlite, los blobs y los
  // secretos locales, y ninguno de los tres entra a git.
  // Reescribir la misma config despierta a los watchers durante los journeys.
  writeIfChanged(path.join(sandboxDir, '.gitignore'), '*\n')
  writeIfChanged(
    path.join(sandboxDir, 'convex.json'),
    `${JSON.stringify({ functions: '../convex/' }, null, 2)}\n`
  )
  // El CLI lee el package.json de su cwd para exigir la dependencia `convex` y
  // para adivinar el framework; sin él aborta antes de empaquetar.
  writeIfChanged(
    path.join(sandboxDir, 'package.json'),
    `${JSON.stringify(
      { name: 'sherlock-convex-local', private: true, dependencies: { convex: '1.42.0' } },
      null,
      2
    )}\n`
  )
}

function ensureSharedSecrets() {
  const existing = parseEnvFile(secretsFile)
  const secrets = {}
  let changed = false
  for (const key of SHARED_SECRET_KEYS) {
    if (existing[key] && existing[key].length >= 32) {
      secrets[key] = existing[key]
      continue
    }
    secrets[key] = randomBytes(32).toString('hex')
    changed = true
  }
  if (changed) writeFileSync(secretsFile, serializeEnv(secrets), { mode: 0o600 })
  return secrets
}

// Valores vacíos explícitos impiden que Next los recargue desde .env.local.
const PROVIDER_ENV_KEYS = [
  'WORKOS_API_KEY',
  'WORKOS_CLIENT_ID',
  'WORKOS_COOKIE_PASSWORD',
  'WORKOS_WEBHOOK_SECRET',
  'WORKOS_COOKIE_NAME',
  'WORKOS_ADMIN_STEP_UP_COOKIE_SECRET',
  'WORKOS_ADMIN_STEP_UP_METHODS',
  'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_FROM_EMAIL',
  'RESEND_TEST_MODE',
  'POSTHOG_API_KEY',
  'POSTHOG_PERSONAL_API_KEY',
  'POSTHOG_PROJECT_ID',
  'POSTHOG_HOST',
  'POSTHOG_INGEST_HOST',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_POSTHOG_HOST',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_URL',
  'UPSTASH_REDIS_TOKEN',
  'UPSTASH_REDIS_PASSWORD',
]

export function localProviderEnv(inherited = process.env) {
  const keys = new Set([
    ...PROVIDER_ENV_KEYS,
    ...Object.keys(inherited).filter((key) =>
      /^(?:NEXT_PUBLIC_)?(?:WORKOS|RESEND|POSTHOG|UPSTASH)_/.test(key)
    ),
  ])
  return Object.fromEntries([...keys].map((key) => [key, '']))
}

/** Env del deployment Convex local. `CONVEX_ENV=dev` + `BYPASS_AUTH=true` son
 *  lo que enciende los usuarios dev y desbloquea el guard del seed. */
function convexDeploymentEnv(secrets) {
  return {
    ...localProviderEnv(),
    ...secrets,
    CONVEX_ENV: 'dev',
    BYPASS_AUTH: 'true',
    APP_URL: APP_ORIGIN,
    // auth.config.ts lanza si falta; el backend local nunca valida un JWT real
    // porque dev-auth resuelve la identidad antes de llegar al proveedor.
    WORKOS_CLIENT_ID: LOCAL_WORKOS_CLIENT_ID,
    VDR_GUEST_SERVER_AUDIENCE: 'sherlock-local',
    INTAKE_SERVER_AUDIENCE: 'sherlock-local',
    INTAKE_DEMO_MODE: 'true',
    RESEND_TEST_MODE: 'true',
    VDR_MCP_SERVER_AUDIENCE: 'sherlock-local',
  }
}

/** Admin key del backend anónimo, la que el propio CLI usa para `convex run`.
 *  La app la necesita para que el backend local vea al usuario elegido en
 *  `/dev-login` (`src/lib/dev-auth/local-convex-identity.ts`); sin ella todo
 *  resuelve al admin de bypass y la sala del cliente no puede subir. Vive en
 *  `.convex-local/.convex/local/default/config.json`, que ya está en git-ignore. */
function localAdminKey() {
  if (!existsSync(backendConfigFile)) return ''
  try {
    const config = JSON.parse(readFileSync(backendConfigFile, 'utf8'))
    return typeof config.adminKey === 'string' ? config.adminKey : ''
  } catch {
    return ''
  }
}

/** Env de `next dev`. Gana sobre `.env.local` porque Next no sobreescribe una
 *  variable que ya está en process.env. */
function appEnv(secrets) {
  return {
    ...localProviderEnv(),
    ...secrets,
    NEXT_PUBLIC_CONVEX_URL: CONVEX_URL,
    NEXT_PUBLIC_CONVEX_SITE_URL: CONVEX_SITE_URL,
    NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: localAdminKey(),
    CONVEX_DEPLOYMENT: DEPLOYMENT,
    // En blanco a propósito: con la deploy key de la nube puesta, el cliente
    // admin de los webhooks escribiría en el deployment remoto desde local.
    CONVEX_DEPLOY_KEY: '',
    WORKOS_CLIENT_ID: LOCAL_WORKOS_CLIENT_ID,
    BYPASS_AUTH: 'true',
    NEXT_PUBLIC_BYPASS_AUTH: 'true',
    NEXT_PUBLIC_DEV_AUTH_ENABLED: 'true',
    NEXT_PUBLIC_APP_URL: APP_ORIGIN,
    APP_URL: APP_ORIGIN,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${APP_ORIGIN}/callback`,
    NEXT_PUBLIC_ENABLE_POSTHOG_IN_DEV: 'false',
    RESEND_TEST_MODE: 'true',
    VDR_GUEST_SERVER_AUDIENCE: 'sherlock-local',
    INTAKE_SERVER_AUDIENCE: 'sherlock-local',
    INTAKE_DEMO_MODE: 'true',
    RATE_LIMIT_PROVIDER: 'memory',
    VDR_MCP_ENABLED: 'true',
    MCP_OAUTH_ISSUER: `${APP_ORIGIN}/api/dev`,
    MCP_OAUTH_JWKS_URL: `${APP_ORIGIN}/api/dev/jwks`,
    MCP_OAUTH_TENANT_CLAIM: 'organization_id',
    MCP_OAUTH_CLIENT_ID_CLAIM: 'client_id',
    VDR_MCP_OAUTH_AUDIENCE: `${APP_ORIGIN}/api/vdr-mcp`,
    VDR_MCP_OAUTH_SCOPE_BASE: 'openid',
    VDR_MCP_SERVER_AUDIENCE: 'sherlock-local',
  }
}

function convexCliEnv() {
  return {
    ...process.env,
    ...localProviderEnv(),
    CONVEX_AGENT_MODE: 'anonymous',
    CONVEX_DEPLOYMENT: DEPLOYMENT,
    CONVEX_DEPLOY_KEY: '',
    // El CLI hereda el cwd del sandbox, pero estas dos las lee de process.env
    // antes de mirar cualquier archivo: dejarlas fijas hace el arranque
    // determinista aunque el `.env.local` del sandbox todavía no exista.
    CONVEX_SELF_HOSTED_URL: '',
    CONVEX_SELF_HOSTED_ADMIN_KEY: '',
  }
}

function runConvex(args, { inherit = true } = {}) {
  return spawnSync(convexBin, args, {
    cwd: sandboxDir,
    env: convexCliEnv(),
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    const settle = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

/** Cada invocación corta del CLI (`env set`, el bootstrap) levanta el backend y
 *  lo mata al salir, pero el SIGTERM es asíncrono: sin esperar a que el puerto
 *  quede libre, la siguiente invocación aborta con "a local backend is still
 *  running on port 3210". */
async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await isPortBusy(port))) return
    await sleep(250)
  }
  console.error(
    `El puerto ${port} sigue ocupado. Cierra el backend local (o el proceso que lo tenga) y reintenta.`
  )
  process.exit(1)
}

/** `convex env set` sobre un deployment que todavía no existe muere con
 *  "Could not find deployment": el env solo se puede fijar después de crearlo,
 *  y el push no puede ir primero porque `auth.config.ts` lanza si
 *  `WORKOS_CLIENT_ID` no está puesto en el deployment. `dev --once --skip-push`
 *  lo crea sin empaquetar funciones, pero NO termina solo: sin el push, nada
 *  cierra el proceso y el backend hijo mantiene vivo el event loop. Por eso se
 *  lanza como líder de su propio grupo y se mata el grupo entero al aparecer el
 *  config, que es la señal de que el deployment ya existe en disco.
 */
async function bootstrapDeployment() {
  if (existsSync(backendConfigFile)) return

  const child = spawn(
    convexBin,
    [
      'dev',
      '--once',
      '--skip-push',
      '--local-cloud-port',
      String(CLOUD_PORT),
      '--local-site-port',
      String(SITE_PORT),
    ],
    { cwd: sandboxDir, env: convexCliEnv(), stdio: 'inherit', detached: true }
  )

  try {
    for (let attempt = 0; attempt < 480; attempt += 1) {
      if (existsSync(backendConfigFile) && (await isPortBusy(CLOUD_PORT))) break
      if (child.exitCode !== null) break
      await sleep(250)
    }
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }

  await waitForPortFree(CLOUD_PORT)
  if (!existsSync(backendConfigFile)) {
    console.error('No se pudo crear el backend local.')
    process.exit(1)
  }
}

/** `--force`: sin él, `env set --from-file` aborta si una variable ya existe
 *  con otro valor, y un sandbox creado antes del cambio de puerto (#557) guarda
 *  `APP_URL` con el 3000. Este archivo es la única fuente del env local. */
async function pushDeploymentEnv(secrets) {
  const envFile = path.join(sandboxDir, 'deployment.env')
  writeFileSync(envFile, serializeEnv(convexDeploymentEnv(secrets)), { mode: 0o600 })
  const result = runConvex(['env', 'set', '--force', '--from-file', 'deployment.env'])
  if (result.status !== 0) {
    console.error('No se pudo fijar el env del deployment local.')
    process.exit(result.status ?? 1)
  }
  await waitForPortFree(CLOUD_PORT)
}

async function startWatcher(runArgs) {
  ensureSandbox()
  const secrets = ensureSharedSecrets()
  ensureDevMcpIssuer()
  await bootstrapDeployment()
  await pushDeploymentEnv(secrets)

  const child = spawn(
    convexBin,
    [
      'dev',
      '--local-cloud-port',
      String(CLOUD_PORT),
      '--local-site-port',
      String(SITE_PORT),
      '--typecheck',
      'disable',
      ...runArgs,
    ],
    { cwd: sandboxDir, env: { ...convexCliEnv(), ...appEnv(secrets) }, stdio: 'inherit' }
  )
  child.on('exit', (code) => process.exit(code ?? 0))
}

function seedRunningBackend() {
  const result = runConvex(['run', SEED_FUNCTION])
  if (result.status !== 0) {
    console.error(
      '\nEl seed falló. Si el backend local no está corriendo, levántalo con ' +
        '`bun run dev:local` (o `bun run convex:local`) y vuelve a intentar.'
    )
    process.exit(result.status ?? 1)
  }
}

async function commandBackend() {
  await startWatcher([])
}

async function commandDev() {
  const afterPush = `cd ${JSON.stringify(appDir)} && node scripts/convex-local.mjs after-push`
  await startWatcher(['--start', afterPush])
}

function commandAfterPush() {
  const viewerAssets = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'build-viewer-assets.mjs')],
    { cwd: appDir, env: { ...process.env, ...appEnv(ensureSharedSecrets()) }, stdio: 'inherit' }
  )
  if (viewerAssets.status !== 0) {
    console.error('No se pudieron preparar los visores locales.')
    process.exit(viewerAssets.status ?? 1)
  }
  console.log(`\nApp local: ${APP_ORIGIN}/es/dev-login`)
  const child = spawn(
    'bash',
    [
      path.join(scriptDir, 'with-project-node.sh'),
      'sh',
      '-c',
      'node scripts/dev-health.mjs && next dev --webpack --hostname 127.0.0.1',
    ],
    {
      cwd: appDir,
      env: { ...process.env, ...appEnv(ensureSharedSecrets()), PORT: APP_PORT },
      stdio: 'inherit',
    }
  )
  child.on('exit', (code) => process.exit(code ?? 0))
}

function commandSeed() {
  ensureSandbox()
  ensureSharedSecrets()
  seedRunningBackend()
}

export function slugifyCompanyName(name) {
  return name
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function requireFlagValue(flag, argv, index) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requiere un valor`)
  }
  return value
}

export function parseSeedCompanyArgs(argv) {
  const options = {
    name: null,
    documents: 8,
    profile: 'completo',
    ownerEmail: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    switch (arg) {
      case '--name':
        options.name = requireFlagValue(arg, argv, ++index)
        break
      case '--docs': {
        const raw = requireFlagValue(arg, argv, ++index)
        if (!/^\d+$/.test(raw)) {
          throw new Error('--docs debe ser un entero mayor o igual a 0')
        }
        options.documents = Number(raw)
        if (options.documents > MAX_SEED_COMPANY_DOCUMENTS) {
          throw new Error(`--docs no puede ser mayor a ${MAX_SEED_COMPANY_DOCUMENTS}`)
        }
        break
      }
      case '--perfil':
        options.profile = requireFlagValue(arg, argv, ++index)
        break
      case '--email':
        options.ownerEmail = requireFlagValue(arg, argv, ++index)
        break
      default:
        throw new Error(`argumento desconocido: ${arg}`)
    }
  }

  if (!options.name || !options.name.trim()) {
    throw new Error('--name es obligatorio')
  }
  const name = options.name.trim()
  const slug = slugifyCompanyName(name)
  if (!slug) {
    throw new Error('--name no produce un slug usable')
  }
  if (!Number.isInteger(options.documents) || options.documents < 0) {
    throw new Error('--docs debe ser un entero mayor o igual a 0')
  }
  if (options.documents > MAX_SEED_COMPANY_DOCUMENTS) {
    throw new Error(`--docs no puede ser mayor a ${MAX_SEED_COMPANY_DOCUMENTS}`)
  }
  const profile = options.profile.trim().toLowerCase()
  if (profile !== 'vacio' && profile !== 'completo' && profile !== 'desordenado') {
    throw new Error('--perfil debe ser vacio, completo o desordenado')
  }
  const ownerEmail = (options.ownerEmail ?? `${slug}@dev.local`).trim().toLowerCase()
  if (!ownerEmail.includes('@')) {
    throw new Error('--email no es un correo válido')
  }

  return { slug, name, documents: options.documents, profile, ownerEmail }
}

export function parseConvexRunJson(stdout) {
  const text = (stdout ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const start = text.search(/[{[]/)
    if (start < 0) return null
    try {
      return JSON.parse(text.slice(start))
    } catch {
      return null
    }
  }
}

function runSeedCompany(args) {
  const result = runConvex(
    [
      'run',
      SEED_COMPANY_FUNCTION,
      JSON.stringify({
        slug: args.slug,
        name: args.name,
        ownerEmail: args.ownerEmail,
        documents: args.documents,
        profile: args.profile,
      }),
    ],
    { inherit: false }
  )
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    console.error(
      '\nEl seed de la empresa falló. Si el backend local no está corriendo, levántalo con ' +
        '`bun run dev:local` (o `bun run convex:local`) y vuelve a intentar.'
    )
    process.exit(result.status ?? 1)
  }
  return parseConvexRunJson(result.stdout)
}

function seedCompanyRunningBackend(args) {
  const parsed = runSeedCompany(args)
  // El subject lo devuelve seedCompany; la regla email -> identidad vive en
  // `src/lib/dev-auth/seed-identity.ts` y aquí no se duplica.
  if (parsed && typeof parsed === 'object' && typeof parsed.providerUserId === 'string') {
    console.log(
      `\n"${args.name}" sembrada: ${parsed.documents} documentos, dueño ${parsed.ownerEmail}.`
    )
    console.log(`Subject del dueño: ${parsed.providerUserId}`)
    console.log(`Entra por ${APP_ORIGIN}/es/dev-login con ${args.ownerEmail}`)
  }
}

function commandSeedCompany() {
  let args
  try {
    args = parseSeedCompanyArgs(process.argv.slice(3))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  ensureSandbox()
  ensureSharedSecrets()
  seedCompanyRunningBackend(args)
}

export function parseSeedPortfolioArgs(argv) {
  let n = 10
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--n') {
      const raw = requireFlagValue(arg, argv, ++index)
      if (!/^\d+$/.test(raw)) {
        throw new Error('--n debe ser un entero mayor o igual a 1')
      }
      n = Number(raw)
      continue
    }
    throw new Error(`argumento desconocido: ${arg}`)
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('--n debe ser un entero mayor o igual a 1')
  }
  if (n > MAX_SEED_PORTFOLIO_COMPANIES) {
    throw new Error(`--n no puede ser mayor a ${MAX_SEED_PORTFOLIO_COMPANIES}`)
  }
  return { n }
}

export function buildPortfolioSeedPlan(n) {
  return PORTFOLIO_COMPANY_NAMES.slice(0, n).map((name, index) => {
    const slug = slugifyCompanyName(name)
    const profile = PORTFOLIO_PROFILES[index % PORTFOLIO_PROFILES.length]
    return {
      name,
      slug,
      ownerEmail: `${slug}@dev.local`,
      profile,
      documents: PORTFOLIO_DOCUMENTS_BY_PROFILE[profile],
    }
  })
}

function commandSeedPortfolio() {
  let args
  try {
    args = parseSeedPortfolioArgs(process.argv.slice(3))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  ensureSandbox()
  ensureSharedSecrets()
  const plan = buildPortfolioSeedPlan(args.n)
  console.log('empresa\temail\tperfil\tdocumentos\tcreados')
  for (const row of plan) {
    const seeded = runSeedCompany(row)
    const created =
      seeded && typeof seeded === 'object' && typeof seeded.documentsCreated === 'number'
        ? seeded.documentsCreated
        : '?'
    console.log(`${row.name}\t${row.ownerEmail}\t${row.profile}\t${row.documents}\t${created}`)
  }
}

function commandReset() {
  rmSync(backendStateDir, { recursive: true, force: true })
  // El CLI escribe este `.env.local` al configurar el deployment; sin borrarlo
  // queda apuntando a una base que ya no existe.
  rmSync(path.join(sandboxDir, '.env.local'), { force: true })
  console.log(`Base local borrada: ${backendStateDir}`)
  console.log(
    'El próximo `bun run dev:local` crea un backend vacío. Usa `bun run seed:local` para cargar datos sintéticos de prueba.'
  )
}

function commandEnv() {
  ensureSandbox()
  ensureDevMcpIssuer()
  process.stdout.write(serializeEnv(appEnv(ensureSharedSecrets())))
}

const commands = {
  backend: commandBackend,
  dev: commandDev,
  'after-push': commandAfterPush,
  seed: commandSeed,
  'seed:company': commandSeedCompany,
  'seed:portfolio': commandSeedPortfolio,
  reset: commandReset,
  env: commandEnv,
  'mcp-token': commandMcpToken,
}

async function main() {
  const command = process.argv[2] ?? 'dev'
  const handler = commands[command]
  if (!handler) {
    console.error(`Comando desconocido: ${command}. Usa: ${Object.keys(commands).join(', ')}`)
    process.exit(1)
  }
  await handler()
}

const isDirectRun = Boolean(process.argv[1]) && scriptPath === path.resolve(process.argv[1])

if (isDirectRun) {
  await main()
}
