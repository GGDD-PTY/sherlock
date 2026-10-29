export const REQUIRED_PRODUCTION_APP_ENV = [
  { key: 'WORKOS_API_KEY', reason: 'WorkOS AuthKit server API key' },
  { key: 'WORKOS_CLIENT_ID', reason: 'WorkOS AuthKit client ID' },
  { key: 'WORKOS_COOKIE_PASSWORD', reason: 'WorkOS AuthKit cookie encryption password' },
  { key: 'WORKOS_WEBHOOK_SECRET', reason: 'WorkOS webhook signature secret' },
  { key: 'NEXT_PUBLIC_APP_URL', reason: 'Public Sherlock app origin' },
  { key: 'NEXT_PUBLIC_WORKOS_REDIRECT_URI', reason: 'WorkOS OAuth callback URL' },
  { key: 'NEXT_PUBLIC_CONVEX_URL', reason: 'Convex backend URL' },
  { key: 'CONVEX_DEPLOYMENT', reason: 'Convex deployment id' },
  { key: 'CONVEX_DEPLOY_KEY', reason: 'Convex deploy key for webhooks/admin routes' },
  { key: 'WEBHOOK_SECRET', reason: 'Shared Convex webhook secret' },
  { key: 'STORAGE_SECRET', reason: 'Signed storage URL secret' },
  { key: 'VDR_GUEST_SERVER_SECRET', reason: 'Guest VDR server proof secret' },
  { key: 'VDR_GUEST_SERVER_AUDIENCE', reason: 'Guest VDR deployment audience' },
  { key: 'ADMIN_VDR_CAPABILITY_SECRET', reason: 'Admin VDR capability secret' },
  { key: 'VDR_MCP_ENABLED', reason: 'Explicit client-facing VDR MCP release state' },
]

// Distributed rate limiting defaults ON in production: src/lib/env.ts marks the
// Upstash pair required unless the operator explicitly opts out with
// RATE_LIMIT_PROVIDER=memory. Metadata-only checks (no values) must treat the
// presence of the opt-out key as the opt-out signal; value-aware checks verify
// it is exactly 'memory'.
export const RATE_LIMIT_OPT_OUT = {
  key: 'RATE_LIMIT_PROVIDER',
  value: 'memory',
  reason: 'explicit opt-out from distributed rate limiting (single-instance hosts only)',
}

export const REDIS_RATE_LIMIT_PRODUCTION_ENV = [
  { key: 'UPSTASH_REDIS_REST_URL', reason: 'Upstash Redis REST URL for distributed rate limiting' },
  {
    key: 'UPSTASH_REDIS_REST_TOKEN',
    reason: 'Upstash Redis REST token for distributed rate limiting',
  },
]

export const VDR_MCP_PRODUCTION_ENV = [
  { key: 'VDR_MCP_SERVER_SECRET', reason: 'VDR MCP App-to-Convex proof secret' },
  { key: 'VDR_MCP_SERVER_AUDIENCE', reason: 'VDR MCP deployment audience' },
  { key: 'MCP_OAUTH_ISSUER', reason: 'WorkOS MCP OAuth authorization server issuer' },
  { key: 'VDR_MCP_OAUTH_AUDIENCE', reason: 'VDR MCP OAuth protected resource audience' },
  { key: 'MCP_OAUTH_JWKS_URL', reason: 'WorkOS MCP OAuth JWKS endpoint' },
  { key: 'MCP_OAUTH_TENANT_CLAIM', reason: 'MCP OAuth tenant claim name' },
  { key: 'MCP_OAUTH_CLIENT_ID_CLAIM', reason: 'MCP OAuth client claim name' },
  { key: 'VDR_MCP_OAUTH_SCOPE_BASE', reason: 'WorkOS-supported VDR MCP identity scope' },
]

export const INTAKE_PRODUCTION_ENV = [
  { key: 'INTAKE_DEMO_MODE', reason: 'Explicit /mycroft intake release state' },
  { key: 'INTAKE_SERVER_SECRET', reason: 'Intake App-to-Convex proof secret' },
  { key: 'INTAKE_SERVER_AUDIENCE', reason: 'Intake deployment audience' },
]

// Carril de operador OPT-IN: sin esta variable `POST /api/observability/probe`
// responde 404 y no hay nada que romper, así que no entra en el bloque
// requerido. Se lista acá para que el preflight pueda comprobarla cuando el
// operador quiera el probe vivo (`--observability-probe-enabled`).
export const OBSERVABILITY_PROBE_PRODUCTION_ENV = [
  {
    key: 'OBSERVABILITY_PROBE_SECRET',
    reason: 'operator bearer for the synthetic 5xx probe (opt-in; the route 404s without it)',
  },
]
