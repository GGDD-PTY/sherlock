// ============================================================================
// VALIDACIÓN DE ENVIRONMENT VARIABLES
// ============================================================================
import { Config, ConfigProvider, Effect, Exit, Schema } from 'effect'

import { runServerEffectSync } from '@/lib/effect/runtime'
import { parseAppOrigin } from '@/lib/site/app-url'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import {
  isValidVdrGuestServerAudience,
  isValidVdrGuestServerSecret,
} from '@/../convex/_guests/serverProofFormat'
import { isValidAdminVdrCapabilitySecret } from '@/../convex/_adminVdr/capabilityFormat'
import {
  isValidIntakeServerAudience,
  isValidIntakeServerSecret,
} from '@/../convex/_intake/proofFormat'
import {
  isValidVdrReadServerAudience,
  isValidVdrReadServerSecret,
} from '@/../convex/_vdrRead/serverProofFormat'
import { isValidObservabilityProbeSecret } from '@/lib/observability/probe'

// Este archivo valida que todas las variables de entorno necesarias estén
// configuradas al iniciar la aplicación. Si falta alguna, lanza un error
// claro indicando cuál falta.
//
// IMPORTANTE: Este archivo se importa en el layout principal para validar
// al inicio de la aplicación.
// ============================================================================

// ============================================================================
// TIPOS
// ============================================================================

interface EnvVar {
  name: EnvironmentVariableName
  required: boolean
  description: string
  schema?: Schema.ConstraintDecoder<unknown>
  // Formato que se AVISA, no se exige. `schema` hace fallar el arranque, que
  // para un secreto requerido es lo correcto: sin él la feature no funciona y
  // fallar temprano es más barato que fallar en la primera request. Para un
  // carril opt-in es lo contrario — un dedo gordo en `vercel env add` tumbaría
  // el sitio entero por una variable que nadie necesita — así que el valor mal
  // formado se trata como ausente y se deja el ruido en el log.
  softSchema?: Schema.ConstraintDecoder<unknown>
}

const optionalEnvironmentValue = (name: string) =>
  Config.schema(Schema.UndefinedOr(Schema.String), name)

const RAW_ENVIRONMENT_CONFIG = Config.all({
  WORKOS_API_KEY: optionalEnvironmentValue('WORKOS_API_KEY'),
  WORKOS_CLIENT_ID: optionalEnvironmentValue('WORKOS_CLIENT_ID'),
  WORKOS_COOKIE_PASSWORD: optionalEnvironmentValue('WORKOS_COOKIE_PASSWORD'),
  WORKOS_WEBHOOK_SECRET: optionalEnvironmentValue('WORKOS_WEBHOOK_SECRET'),
  CONVEX_DEPLOYMENT: optionalEnvironmentValue('CONVEX_DEPLOYMENT'),
  CONVEX_DEPLOY_KEY: optionalEnvironmentValue('CONVEX_DEPLOY_KEY'),
  WEBHOOK_SECRET: optionalEnvironmentValue('WEBHOOK_SECRET'),
  VDR_GUEST_SERVER_SECRET: optionalEnvironmentValue('VDR_GUEST_SERVER_SECRET'),
  VDR_GUEST_SERVER_AUDIENCE: optionalEnvironmentValue('VDR_GUEST_SERVER_AUDIENCE'),
  ADMIN_VDR_CAPABILITY_SECRET: optionalEnvironmentValue('ADMIN_VDR_CAPABILITY_SECRET'),
  INTAKE_DEMO_MODE: optionalEnvironmentValue('INTAKE_DEMO_MODE'),
  INTAKE_SERVER_SECRET: optionalEnvironmentValue('INTAKE_SERVER_SECRET'),
  INTAKE_SERVER_AUDIENCE: optionalEnvironmentValue('INTAKE_SERVER_AUDIENCE'),
  POSTHOG_INGEST_HOST: optionalEnvironmentValue('POSTHOG_INGEST_HOST'),
  OBSERVABILITY_PROBE_SECRET: optionalEnvironmentValue('OBSERVABILITY_PROBE_SECRET'),
  VDR_MCP_ENABLED: optionalEnvironmentValue('VDR_MCP_ENABLED'),
  MCP_OAUTH_ISSUER: optionalEnvironmentValue('MCP_OAUTH_ISSUER'),
  MCP_OAUTH_JWKS_URL: optionalEnvironmentValue('MCP_OAUTH_JWKS_URL'),
  MCP_OAUTH_TENANT_CLAIM: optionalEnvironmentValue('MCP_OAUTH_TENANT_CLAIM'),
  MCP_OAUTH_CLIENT_ID_CLAIM: optionalEnvironmentValue('MCP_OAUTH_CLIENT_ID_CLAIM'),
  VDR_MCP_SERVER_SECRET: optionalEnvironmentValue('VDR_MCP_SERVER_SECRET'),
  VDR_MCP_SERVER_AUDIENCE: optionalEnvironmentValue('VDR_MCP_SERVER_AUDIENCE'),
  VDR_MCP_OAUTH_AUDIENCE: optionalEnvironmentValue('VDR_MCP_OAUTH_AUDIENCE'),
  VDR_MCP_OAUTH_SCOPE_BASE: optionalEnvironmentValue('VDR_MCP_OAUTH_SCOPE_BASE'),
  STORAGE_SECRET: optionalEnvironmentValue('STORAGE_SECRET'),
  UPSTASH_REDIS_REST_URL: optionalEnvironmentValue('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: optionalEnvironmentValue('UPSTASH_REDIS_REST_TOKEN'),
  NEXT_PUBLIC_APP_URL: optionalEnvironmentValue('NEXT_PUBLIC_APP_URL'),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: optionalEnvironmentValue('NEXT_PUBLIC_WORKOS_REDIRECT_URI'),
  NEXT_PUBLIC_CONVEX_URL: optionalEnvironmentValue('NEXT_PUBLIC_CONVEX_URL'),
  NODE_ENV: optionalEnvironmentValue('NODE_ENV'),
  RATE_LIMIT_PROVIDER: optionalEnvironmentValue('RATE_LIMIT_PROVIDER'),
  VERCEL: optionalEnvironmentValue('VERCEL'),
  VERCEL_ENV: optionalEnvironmentValue('VERCEL_ENV'),
  NEXT_PHASE: optionalEnvironmentValue('NEXT_PHASE'),
  SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS: optionalEnvironmentValue(
    'SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS'
  ),
})

type RawEnvironment = Effect.Success<typeof RAW_ENVIRONMENT_CONFIG>
type EnvironmentVariableName = keyof RawEnvironment

function environmentConfigProvider(): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })
}

const loadRawEnvironmentEffect = Effect.fn('Env.loadRaw')(function* () {
  return yield* RAW_ENVIRONMENT_CONFIG.parse(environmentConfigProvider())
})

const INITIAL_ENVIRONMENT = runServerEffectSync(loadRawEnvironmentEffect())

// Vercel preview and Next.js production builds often run with a reduced env set.
// Keep production runtime strict, but avoid hard-failing build/preview steps.
const RELAXED_ENV_VALIDATION =
  (INITIAL_ENVIRONMENT.VERCEL === '1' && INITIAL_ENVIRONMENT.VERCEL_ENV === 'preview') ||
  INITIAL_ENVIRONMENT.NEXT_PHASE === 'phase-production-build'
const OPTIONAL_ENV_WARNING_FLAG = '__SHERLOCK_OPTIONAL_ENV_WARNING_SHOWN__'

// Distributed rate limiting (src/lib/utils/rate-limit.ts) needs Upstash Redis in
// production; without it the limiter silently degrades to per-instance in-memory
// state, which is ineffective on serverless. Operators can explicitly opt out
// with RATE_LIMIT_PROVIDER=memory (not recommended outside single-instance hosts).
const REDIS_RATE_LIMIT_REQUIRED =
  INITIAL_ENVIRONMENT.NODE_ENV === 'production' &&
  INITIAL_ENVIRONMENT.RATE_LIMIT_PROVIDER !== 'memory'
const INTAKE_DEMO_MODE_ENABLED = INITIAL_ENVIRONMENT.INTAKE_DEMO_MODE === 'true'
// El único MCP es el del cliente sobre su VDR ([F] 2026-09-06, DECISIONS): el
// bloque OAuth de WorkOS (issuer/JWKS/claims) se exige solo cuando está encendido.
const VDR_MCP_ENABLED = INITIAL_ENVIRONMENT.VDR_MCP_ENABLED === 'true'

const OAUTH_CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/

function checkedStringSchema(predicate: (value: string) => boolean) {
  return Schema.String.check(
    Schema.makeFilter((value) => (predicate(value) ? undefined : 'Invalid configured value'))
  )
}

function httpsUrlSchema(exactPath?: string) {
  return Schema.URLFromString.check(
    Schema.makeFilter((url) =>
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.search === '' &&
      (!exactPath || url.pathname === exactPath)
        ? undefined
        : 'Expected a bounded HTTPS URL'
    )
  )
}

const MCP_OAUTH_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

function mcpOAuthUrlSchema(exactPath?: string) {
  return Schema.URLFromString.check(
    Schema.makeFilter((url) => {
      const bounded =
        url.username === '' &&
        url.password === '' &&
        url.hash === '' &&
        url.search === '' &&
        (!exactPath || url.pathname === exactPath)
      if (!bounded) return 'Expected a bounded HTTPS URL'
      if (url.protocol === 'https:') return undefined
      if (
        DEV_AUTH_ENABLED &&
        url.protocol === 'http:' &&
        MCP_OAUTH_LOOPBACK_HOSTS.has(url.hostname)
      ) {
        return undefined
      }
      return 'Expected a bounded HTTPS URL'
    })
  )
}

const PUBLIC_APP_URL_SCHEMA = Schema.String.check(
  Schema.makeFilter((value) =>
    parseAppOrigin(value, INITIAL_ENVIRONMENT.NODE_ENV === 'production') !== null
      ? undefined
      : 'Expected a public application URL'
  )
)
const BOOLEAN_STRING_SCHEMA = Schema.Literals(['true', 'false'])
const OAUTH_CLAIM_NAME_SCHEMA = Schema.String.check(
  Schema.isPattern(OAUTH_CLAIM_NAME),
  Schema.makeFilter((value) => (value !== 'sub' ? undefined : 'Reserved OAuth claim'))
)
const VDR_GUEST_SERVER_SECRET_SCHEMA = checkedStringSchema(isValidVdrGuestServerSecret)
const VDR_GUEST_SERVER_AUDIENCE_SCHEMA = checkedStringSchema(isValidVdrGuestServerAudience)
const ADMIN_VDR_CAPABILITY_SECRET_SCHEMA = checkedStringSchema(isValidAdminVdrCapabilitySecret)
const INTAKE_SERVER_SECRET_SCHEMA = checkedStringSchema(isValidIntakeServerSecret)
const INTAKE_SERVER_AUDIENCE_SCHEMA = checkedStringSchema(isValidIntakeServerAudience)
const OBSERVABILITY_PROBE_SECRET_SCHEMA = checkedStringSchema(isValidObservabilityProbeSecret)
const VDR_READ_SERVER_SECRET_SCHEMA = checkedStringSchema(isValidVdrReadServerSecret)
const VDR_READ_SERVER_AUDIENCE_SCHEMA = checkedStringSchema(isValidVdrReadServerAudience)

// ============================================================================
// VARIABLES DE ENTORNO REQUERIDAS
// ============================================================================

// Variables del servidor (solo disponibles en server-side)
const SERVER_ENV_VARS: EnvVar[] = [
  {
    name: 'WORKOS_API_KEY',
    required: !DEV_AUTH_ENABLED,
    description: 'WorkOS API key for AuthKit server calls',
  },
  {
    name: 'WORKOS_CLIENT_ID',
    required: !DEV_AUTH_ENABLED,
    description: 'WorkOS client ID for AuthKit integration',
  },
  {
    name: 'WORKOS_COOKIE_PASSWORD',
    required: !DEV_AUTH_ENABLED,
    description: 'WorkOS AuthKit cookie encryption password',
  },
  {
    name: 'WORKOS_WEBHOOK_SECRET',
    required: !DEV_AUTH_ENABLED,
    description: 'WorkOS webhook signature secret (required by the WorkOS events handler)',
  },
  {
    name: 'CONVEX_DEPLOYMENT',
    required: true,
    description: 'ID del deployment de Convex',
  },
  {
    name: 'CONVEX_DEPLOY_KEY',
    required: !DEV_AUTH_ENABLED,
    description: 'Deploy key de Convex para rutas internas/admin (webhooks y sync)',
  },
  {
    name: 'WEBHOOK_SECRET',
    required: !DEV_AUTH_ENABLED,
    description: 'Shared secret for Convex webhook mutations (credits, must match Convex env)',
  },
  {
    name: 'VDR_GUEST_SERVER_SECRET',
    required: !DEV_AUTH_ENABLED,
    description:
      'Dedicated server-only HMAC secret for guest VDR calls (32-4096 chars; must match Convex env)',
    schema: VDR_GUEST_SERVER_SECRET_SCHEMA,
  },
  {
    name: 'VDR_GUEST_SERVER_AUDIENCE',
    required: !DEV_AUTH_ENABLED,
    description: 'Bounded guest VDR deployment audience (must match Convex env; never NEXT_PUBLIC)',
    schema: VDR_GUEST_SERVER_AUDIENCE_SCHEMA,
  },
  {
    name: 'ADMIN_VDR_CAPABILITY_SECRET',
    required: !DEV_AUTH_ENABLED,
    description:
      'Dedicated server-only HMAC secret for one-use admin VDR capabilities (32-4096 chars; must match Convex env)',
    schema: ADMIN_VDR_CAPABILITY_SECRET_SCHEMA,
  },
  {
    name: 'INTAKE_DEMO_MODE',
    required: false,
    description: 'Default-off server switch for temporary no-signup intake (true or false)',
    schema: BOOLEAN_STRING_SCHEMA,
  },
  {
    name: 'INTAKE_SERVER_SECRET',
    required: INTAKE_DEMO_MODE_ENABLED,
    description:
      'Dedicated server-only HMAC secret for temporary intake authority (must match Convex env)',
    schema: INTAKE_SERVER_SECRET_SCHEMA,
  },
  {
    name: 'INTAKE_SERVER_AUDIENCE',
    required: INTAKE_DEMO_MODE_ENABLED,
    description: 'Bounded temporary intake deployment audience (must match Convex env)',
    schema: INTAKE_SERVER_AUDIENCE_SCHEMA,
  },
  {
    name: 'POSTHOG_INGEST_HOST',
    required: false,
    description: 'HTTPS PostHog ingestion origin used by server-side conversion events',
    schema: httpsUrlSchema(),
  },
  {
    name: 'OBSERVABILITY_PROBE_SECRET',
    required: false,
    description:
      'Server-only operator bearer for POST /api/observability/probe (32-4096 chars); without it — or with a value outside those bounds — the route answers 404',
    // softSchema, no schema: un valor fuera de rango deja el probe apagado
    // (`resolveObservabilityProbeSecret` devuelve null y la ruta responde 404),
    // nunca tumba el sitio.
    softSchema: OBSERVABILITY_PROBE_SECRET_SCHEMA,
  },
  {
    name: 'VDR_MCP_ENABLED',
    required: false,
    description:
      'Default-off server switch for the client-facing VDR read MCP surface (true or false)',
    schema: BOOLEAN_STRING_SCHEMA,
  },
  {
    name: 'MCP_OAUTH_ISSUER',
    required: VDR_MCP_ENABLED,
    description:
      'WorkOS OAuth issuer for the VDR MCP resource server (HTTPS; http loopback only with DEV_AUTH_ENABLED)',
    schema: VDR_MCP_ENABLED ? mcpOAuthUrlSchema() : undefined,
  },
  {
    name: 'MCP_OAUTH_JWKS_URL',
    required: VDR_MCP_ENABLED,
    description:
      'Bounded-fetch JWKS endpoint for MCP bearer verification (HTTPS; http loopback only with DEV_AUTH_ENABLED)',
    schema: VDR_MCP_ENABLED ? mcpOAuthUrlSchema() : undefined,
  },
  {
    name: 'MCP_OAUTH_TENANT_CLAIM',
    required: VDR_MCP_ENABLED,
    description: 'Bounded JWT claim name carrying Sherlock tenant authority',
    schema: VDR_MCP_ENABLED ? OAUTH_CLAIM_NAME_SCHEMA : undefined,
  },
  {
    name: 'MCP_OAUTH_CLIENT_ID_CLAIM',
    required: VDR_MCP_ENABLED,
    description: 'Bounded JWT claim name carrying OAuth client identity',
    schema: VDR_MCP_ENABLED ? OAUTH_CLAIM_NAME_SCHEMA : undefined,
  },
  {
    name: 'VDR_MCP_SERVER_SECRET',
    required: VDR_MCP_ENABLED,
    description: 'Dedicated HMAC secret for App-to-Convex VDR read calls (never NEXT_PUBLIC)',
    schema: VDR_MCP_ENABLED ? VDR_READ_SERVER_SECRET_SCHEMA : undefined,
  },
  {
    name: 'VDR_MCP_SERVER_AUDIENCE',
    required: VDR_MCP_ENABLED,
    description: 'Bounded deployment audience for App-to-Convex VDR read calls',
    schema: VDR_MCP_ENABLED ? VDR_READ_SERVER_AUDIENCE_SCHEMA : undefined,
  },
  {
    name: 'VDR_MCP_OAUTH_AUDIENCE',
    required: VDR_MCP_ENABLED,
    description:
      'Canonical VDR read MCP resource audience ending exactly /api/vdr-mcp (HTTPS; http loopback only with DEV_AUTH_ENABLED)',
    schema: VDR_MCP_ENABLED ? mcpOAuthUrlSchema('/api/vdr-mcp') : undefined,
  },
  {
    name: 'VDR_MCP_OAUTH_SCOPE_BASE',
    required: VDR_MCP_ENABLED,
    description: 'WorkOS-supported identity scope for the VDR read MCP resource server',
    schema: VDR_MCP_ENABLED ? Schema.Literal('openid') : undefined,
  },
  {
    name: 'STORAGE_SECRET',
    required: !DEV_AUTH_ENABLED,
    description: 'Secret para firmar URLs de storage (requerido en producción)',
  },
  {
    name: 'UPSTASH_REDIS_REST_URL',
    required: REDIS_RATE_LIMIT_REQUIRED,
    description:
      'Upstash Redis REST URL for distributed rate limiting (set RATE_LIMIT_PROVIDER=memory to opt out)',
  },
  {
    name: 'UPSTASH_REDIS_REST_TOKEN',
    required: REDIS_RATE_LIMIT_REQUIRED,
    description:
      'Upstash Redis REST token for distributed rate limiting (set RATE_LIMIT_PROVIDER=memory to opt out)',
  },
]

// Variables públicas (disponibles en cliente y servidor)
const PUBLIC_ENV_VARS: EnvVar[] = [
  {
    name: 'NEXT_PUBLIC_APP_URL',
    required: !DEV_AUTH_ENABLED,
    description: 'Public Sherlock app origin',
    schema: PUBLIC_APP_URL_SCHEMA,
  },
  {
    name: 'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
    required: !DEV_AUTH_ENABLED,
    description: 'Public WorkOS AuthKit callback URL',
  },
  {
    name: 'NEXT_PUBLIC_CONVEX_URL',
    required: true,
    description: 'URL del backend de Convex',
  },
]

// ============================================================================
// FUNCIONES DE VALIDACIÓN
// ============================================================================

function shouldLogOptionalEnvWarnings(): boolean {
  const warningShown: unknown = Reflect.get(globalThis, OPTIONAL_ENV_WARNING_FLAG)
  if (warningShown) {
    return false
  }

  Reflect.set(globalThis, OPTIONAL_ENV_WARNING_FLAG, true)
  return true
}

const schemaAcceptsEnvironmentValue = Effect.fn('Env.schemaAcceptsValue')(function* (
  schema: Schema.ConstraintDecoder<unknown>,
  value: string
) {
  const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(schema)(value))
  return Exit.isSuccess(decoded)
})

const inspectEnvironmentVariable = Effect.fn('Env.inspectVariable')(function* (
  envVar: EnvVar,
  value: string | undefined
) {
  if (
    value &&
    envVar.softSchema &&
    !(yield* schemaAcceptsEnvironmentValue(envVar.softSchema, value))
  ) {
    return 'malformed-optional' as const
  }
  if (!value && envVar.required) {
    return 'missing' as const
  }
  if (value && envVar.schema && !(yield* schemaAcceptsEnvironmentValue(envVar.schema, value))) {
    return 'invalid' as const
  }
  if (!value && !envVar.required) {
    return 'optional-missing' as const
  }
  return 'valid' as const
})

/**
 * Valida todas las variables de entorno del servidor
 * Solo se ejecuta en el servidor (no en el navegador)
 *
 * IMPORTANT: This function is auto-called on module import (line ~260).
 * Do NOT call it explicitly in layouts - the module cache ensures single execution.
 *
 * In test environments, validation only logs warnings instead of throwing.
 */
export const validateServerEnvEffect = Effect.fn('Env.validateServer')(function* () {
  // Solo ejecutar en el servidor
  if (typeof window !== 'undefined') {
    return true
  }

  const environment = yield* loadRawEnvironmentEffect()

  // The public origin is compiled into browser bundles, so builds and previews
  // must not bypass this production prerequisite.
  if (
    environment.NODE_ENV === 'production' &&
    !parseAppOrigin(environment.NEXT_PUBLIC_APP_URL ?? '', true)
  ) {
    return yield* Effect.fail(
      new Error('NEXT_PUBLIC_APP_URL must be a valid HTTPS application origin in production.')
    )
  }

  // In test environment, be more lenient to avoid breaking test setup
  const isTestEnv = environment.NODE_ENV === 'test'

  const missing: string[] = []
  const warnings: string[] = []
  const malformedOptional: string[] = []

  for (const envVar of [...SERVER_ENV_VARS, ...PUBLIC_ENV_VARS]) {
    const status = yield* inspectEnvironmentVariable(envVar, environment[envVar.name])
    if (status === 'malformed-optional') {
      malformedOptional.push(`  - ${envVar.name}: valor inválido; ${envVar.description}`)
    } else if (status === 'missing') {
      missing.push(`  - ${envVar.name}: ${envVar.description}`)
    } else if (status === 'invalid') {
      missing.push(`  - ${envVar.name}: valor inválido; ${envVar.description}`)
    } else if (status === 'optional-missing') {
      warnings.push(`  - ${envVar.name}: ${envVar.description}`)
    }
  }

  // Un carril opt-in mal configurado se avisa SIEMPRE, también en producción:
  // el operador tiene que enterarse de que su probe está apagado. Nunca tira.
  if (malformedOptional.length > 0) {
    yield* Effect.logWarning(
      [
        '',
        '⚠️  Variables opcionales con valor inválido: se tratan como ausentes.',
        '',
        ...malformedOptional,
        '',
      ].join('\n')
    )
  }

  // Si hay variables faltantes requeridas
  if (missing.length > 0) {
    const errorMessage = [
      '',
      '============================================================',
      'ERROR: Variables de entorno faltantes',
      '============================================================',
      '',
      'Las siguientes variables de entorno son REQUERIDAS pero no están configuradas:',
      '',
      ...missing,
      '',
      'Por favor, agrega estas variables a tu archivo .env.local',
      '',
      '============================================================',
      '',
    ].join('\n')

    // In test and Vercel preview environments, warn instead of hard-failing.
    // Production remains strict to fail fast on bad configuration.
    if (isTestEnv || RELAXED_ENV_VALIDATION) {
      const mode = isTestEnv
        ? 'test'
        : environment.NEXT_PHASE === 'phase-production-build'
          ? 'next-build'
          : 'vercel-preview'
      yield* Effect.logWarning(`[ENV] ${mode} environment - env validation warnings:`, errorMessage)
      return true // Don't throw in tests
    }

    return yield* Effect.fail(new Error(errorMessage))
  }

  // Mostrar warnings para variables opcionales faltantes solo cuando se pidan.
  // En Next dev este módulo se evalúa por runtime/ruta, así que dejarlo siempre
  // activo convierte cada page load en ruido repetido en la terminal.
  if (
    warnings.length > 0 &&
    environment.NODE_ENV === 'development' &&
    environment.SHERLOCK_SHOW_OPTIONAL_ENV_WARNINGS === 'true' &&
    (yield* Effect.sync(shouldLogOptionalEnvWarnings))
  ) {
    yield* Effect.logWarning(
      [
        '',
        '⚠️  Variables de entorno opcionales no configuradas:',
        '',
        ...warnings,
        '',
        'Estas son opcionales pero algunas features pueden no funcionar.',
        '',
      ].join('\n')
    )
  }

  return true
})

// Puente síncrono para el auto-arranque y callers existentes.
export function validateServerEnv(): void {
  runServerEffectSync(validateServerEnvEffect())
}

// ============================================================================
// ENV TIPADO (Type-safe access)
// ============================================================================

/**
 * Helper Effect para resolver una variable requerida.
 * Lanza el mismo error claro si la variable falta o está vacía.
 */
const resolveRequiredEnvironmentValueEffect = Effect.fn('Env.resolveRequiredValue')(function* (
  name: EnvironmentVariableName,
  value: string | undefined,
  options?: { allowEmptyInDevAuth?: boolean }
) {
  // ===== DEMO MODE: PERMITIR VACÍO =====
  // ES: En demo, permitimos vars de auth vacías para evitar bloqueos.
  // EN: In demo, allow empty auth vars to avoid blocking.
  if (options?.allowEmptyInDevAuth && DEV_AUTH_ENABLED) {
    return value ?? ''
  }

  if (!value || value.trim() === '') {
    if (RELAXED_ENV_VALIDATION) {
      return ''
    }
    return yield* Effect.fail(
      new Error(
        `Missing required environment variable: ${name}. Please add it to your .env.local file.`
      )
    )
  }
  return value
})

const loadEnvironmentEffect = Effect.fn('Env.load')(function* (environment: RawEnvironment) {
  return {
    // ===== WORKOS AUTHKIT =====
    WORKOS_API_KEY: yield* resolveRequiredEnvironmentValueEffect(
      'WORKOS_API_KEY',
      environment.WORKOS_API_KEY,
      { allowEmptyInDevAuth: true }
    ),
    WORKOS_CLIENT_ID: yield* resolveRequiredEnvironmentValueEffect(
      'WORKOS_CLIENT_ID',
      environment.WORKOS_CLIENT_ID,
      { allowEmptyInDevAuth: true }
    ),
    WORKOS_COOKIE_PASSWORD: yield* resolveRequiredEnvironmentValueEffect(
      'WORKOS_COOKIE_PASSWORD',
      environment.WORKOS_COOKIE_PASSWORD,
      { allowEmptyInDevAuth: true }
    ),
    WORKOS_WEBHOOK_SECRET: environment.WORKOS_WEBHOOK_SECRET,
    NEXT_PUBLIC_APP_URL: yield* resolveRequiredEnvironmentValueEffect(
      'NEXT_PUBLIC_APP_URL',
      environment.NEXT_PUBLIC_APP_URL,
      { allowEmptyInDevAuth: true }
    ),
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: yield* resolveRequiredEnvironmentValueEffect(
      'NEXT_PUBLIC_WORKOS_REDIRECT_URI',
      environment.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
      { allowEmptyInDevAuth: true }
    ),

    // ===== CONVEX =====
    CONVEX_DEPLOYMENT: yield* resolveRequiredEnvironmentValueEffect(
      'CONVEX_DEPLOYMENT',
      environment.CONVEX_DEPLOYMENT
    ),
    CONVEX_DEPLOY_KEY: environment.CONVEX_DEPLOY_KEY,
    NEXT_PUBLIC_CONVEX_URL: yield* resolveRequiredEnvironmentValueEffect(
      'NEXT_PUBLIC_CONVEX_URL',
      environment.NEXT_PUBLIC_CONVEX_URL
    ),

    // ===== TEMPORARY INTAKE (server only; default off) =====
    INTAKE_DEMO_MODE: environment.INTAKE_DEMO_MODE,
    INTAKE_SERVER_SECRET: environment.INTAKE_SERVER_SECRET,
    INTAKE_SERVER_AUDIENCE: environment.INTAKE_SERVER_AUDIENCE,

    // ===== CLIENT VDR MCP (never public) =====
    VDR_MCP_ENABLED,
    MCP_OAUTH_ISSUER: environment.MCP_OAUTH_ISSUER,
    MCP_OAUTH_JWKS_URL: environment.MCP_OAUTH_JWKS_URL,
    MCP_OAUTH_TENANT_CLAIM: environment.MCP_OAUTH_TENANT_CLAIM,
    MCP_OAUTH_CLIENT_ID_CLAIM: environment.MCP_OAUTH_CLIENT_ID_CLAIM,
    VDR_MCP_SERVER_SECRET: environment.VDR_MCP_SERVER_SECRET,
    VDR_MCP_SERVER_AUDIENCE: environment.VDR_MCP_SERVER_AUDIENCE,
    VDR_MCP_OAUTH_AUDIENCE: environment.VDR_MCP_OAUTH_AUDIENCE,
    VDR_MCP_OAUTH_SCOPE_BASE: environment.VDR_MCP_OAUTH_SCOPE_BASE,

    WEBHOOK_SECRET: environment.WEBHOOK_SECRET,

    // ===== OBSERVABILIDAD (server only; sin ella el probe responde 404) =====
    OBSERVABILITY_PROBE_SECRET: environment.OBSERVABILITY_PROBE_SECRET,

    // ===== META =====
    NODE_ENV: environment.NODE_ENV as 'development' | 'production' | 'test',
    IS_PRODUCTION: environment.NODE_ENV === 'production',
    IS_DEVELOPMENT: environment.NODE_ENV === 'development',
  } as const
})

/**
 * Objeto con las variables de entorno tipadas.
 * Config/ConfigProvider leen el snapshot y este puente lo materializa para los
 * callers síncronos existentes.
 */
export const env = runServerEffectSync(loadEnvironmentEffect(INITIAL_ENVIRONMENT))

// ============================================================================
// AUTO-VALIDACIÓN AL IMPORTAR (Solo servidor)
// ============================================================================
// Validar automáticamente al importar este módulo (solo en servidor)
validateServerEnv()
