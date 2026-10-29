// ============================================================================
// VDR READ MCP — OAuth surface binding
// ============================================================================
// Its own audience (`/api/vdr-mcp`) and the provider-supported `openid` scope,
// over the WorkOS issuer and JWKS. Authorization below OAuth remains bound to
// the Sherlock room membership and document/model ownership checks. Two
// consequences the tests pin:
//
//   - a token minted for any other audience is inert here.
//   - naming a tool outside the allowlist is denied before dispatch,
//     including the verbs of the retired model-run bridge. Write tools
//     additionally require `vdr:write` on top of the identity scope, which the
//     bearer carries either as a scope or as the `sherlock_role` claim.
// ============================================================================

import { Effect, Predicate } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'
import {
  failMcpOAuth,
  scopeDemandForMessages,
  scopeDemandForMessagesEffect,
  verifyMcpBearerCoreEffect,
  type McpOAuthCoreConfig,
  type McpOAuthDependencies,
  type McpOAuthError,
  type McpOAuthPrincipal,
  type McpScopeDemand,
} from '@/lib/mcp-shared/oauth-core'
import { assertSherlockMcpAuthPolicyEffect } from '@/lib/mcp-shared/sherlock-auth-policy'
import { VDR_MCP_AUDIENCE_PATH } from '@/lib/vdr-mcp/config'

const VDR_MCP_WRITE_SCOPE = 'vdr:write' as const

// ============================================================================
// ESCRITURA POR ROL
// ============================================================================
// AuthKit no le entrega `vdr:write` a un cliente MCP. Medido contra prod el
// 2026-09-12 con el token real que AuthKit le da a Claude Code: `scope` =
// `offline_access openid`, sin claim `permissions`, y `sherlock_role` =
// `company_owner`. Pedir `vdr:write` desde un cliente CIMD o DCR responde
// `invalid_scope`, y el dashboard de WorkOS no deja asignarle scopes a esos
// clientes («Cannot set scopes for dynamically registered applications»). El
// permiso sí está asignado a los roles `company_owner`, `company_member` y
// `admin`: lo que viaja en el token es el rol, puesto por el JWT template del
// entorno (`sherlock_role` = `{{ organization_membership.role }}`). Así que la
// escritura se concede por ese claim verificado y la PRM sigue anunciando solo
// `openid` (#627). El gate de Convex —propiedad de la sala, `documentAccessLogs`
// y el preset `mcpUpload`— no cambia: esto solo abre la puerta del OAuth.
// @see https://workos.com/docs/authkit/mcp
// @see https://workos.com/blog/mcp-auth-developer-guide
export const VDR_MCP_ROLE_CLAIM = 'sherlock_role' as const
export const VDR_MCP_WRITE_ROLES = ['company_owner', 'company_member', 'admin'] as const

const WRITE_ROLES: ReadonlySet<string> = new Set(VDR_MCP_WRITE_ROLES)

function vdrMcpScopesFromClaims(claims: Readonly<Record<string, unknown>>): readonly string[] {
  const role = claims[VDR_MCP_ROLE_CLAIM]
  return typeof role === 'string' && WRITE_ROLES.has(role) ? [VDR_MCP_WRITE_SCOPE] : []
}

export type VdrMcpScopes = Readonly<{
  base: string
  write: string
}>

export type VdrMcpOAuthConfig = Readonly<{
  issuer: string
  audience: string
  jwksUri: string
  tenantClaim: string
  clientIdClaim: string
  scopes: VdrMcpScopes
  jwksTimeoutMs?: number
}>

/** Tools reachable through this surface. The list IS the allowlist. */
const VDR_MCP_DOCUMENT_TOOLS = [
  'sala_resumen',
  'sala_documentos',
  'documento_buscar',
  'documento_fragmento',
] as const

const VDR_MCP_MODEL_TOOLS = [
  'modelo_hojas',
  'modelo_resumen',
  'modelo_rango',
  'modelo_formula',
  'modelo_metrica_canonica',
] as const

const VDR_MCP_WRITE_TOOLS = ['documento_subir', 'documento_confirmar'] as const

export const VDR_MCP_TOOL_NAMES = [
  ...VDR_MCP_DOCUMENT_TOOLS,
  ...VDR_MCP_MODEL_TOOLS,
  ...VDR_MCP_WRITE_TOOLS,
] as const

export type VdrMcpToolName = (typeof VDR_MCP_TOOL_NAMES)[number]

const DOCUMENT_TOOLS: ReadonlySet<string> = new Set(VDR_MCP_DOCUMENT_TOOLS)
const MODEL_TOOLS: ReadonlySet<string> = new Set(VDR_MCP_MODEL_TOOLS)
const WRITE_TOOLS: ReadonlySet<string> = new Set(VDR_MCP_WRITE_TOOLS)

export function isVdrMcpWriteToolName(value: string): boolean {
  return WRITE_TOOLS.has(value)
}

export function isVdrMcpToolName(value: string): value is VdrMcpToolName {
  return DOCUMENT_TOOLS.has(value) || MODEL_TOOLS.has(value) || WRITE_TOOLS.has(value)
}

function toCoreConfig(config: VdrMcpOAuthConfig): McpOAuthCoreConfig {
  return {
    issuer: config.issuer,
    audience: config.audience,
    audiencePath: VDR_MCP_AUDIENCE_PATH,
    jwksUri: config.jwksUri,
    tenantClaim: config.tenantClaim,
    clientIdClaim: config.clientIdClaim,
    scopeTokens: [config.scopes.base, config.scopes.write],
    verifiedTokenPolicyEffect: assertSherlockMcpAuthPolicyEffect,
    grantedScopesFromClaims: vdrMcpScopesFromClaims,
    ...(config.jwksTimeoutMs === undefined ? {} : { jwksTimeoutMs: config.jwksTimeoutMs }),
  }
}

function methodScopes(message: unknown, scopes: VdrMcpScopes): McpScopeDemand {
  if (
    !Predicate.isObject(message) ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string'
  ) {
    return failMcpOAuth('MCP_OPERATION_DENIED', 403)
  }

  switch (message.method) {
    case 'initialize':
    case 'server/discover':
    case 'tools/list':
    case 'resources/list':
    case 'resources/templates/list':
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { required: [scopes.base], sufficient: [] }
    case 'tools/call': {
      if (!Predicate.isObject(message.params) || typeof message.params.name !== 'string') {
        return failMcpOAuth('MCP_OPERATION_DENIED', 403)
      }
      const name = message.params.name
      if (WRITE_TOOLS.has(name)) {
        return { required: [scopes.base, scopes.write], sufficient: [] }
      }
      if (DOCUMENT_TOOLS.has(name) || MODEL_TOOLS.has(name)) {
        return { required: [scopes.base], sufficient: [] }
      }
      // Anything else — the retired bridge verbs included — never dispatches.
      return failMcpOAuth('MCP_OPERATION_DENIED', 403)
    }
    default:
      // No resources/read: the read surface exposes no byte resource at all.
      return failMcpOAuth('MCP_OPERATION_DENIED', 403)
  }
}

export function scopeDemandForVdrMcpBody(body: unknown, scopes: VdrMcpScopes): McpScopeDemand {
  return scopeDemandForMessages(body, (message) => methodScopes(message, scopes))
}

const scopeDemandForVdrMcpBodyEffect = Effect.fn('VdrMcpOAuth.scopeDemandForBody')(
  (body: unknown, scopes: VdrMcpScopes): Effect.Effect<McpScopeDemand, McpOAuthError> =>
    scopeDemandForMessagesEffect(body, (message) => methodScopes(message, scopes))
)

export function vdrMcpScopesFromEnv(): VdrMcpScopes {
  return {
    base: process.env.VDR_MCP_OAUTH_SCOPE_BASE ?? '',
    write: VDR_MCP_WRITE_SCOPE,
  }
}

export function vdrMcpOAuthConfigFromEnv(): VdrMcpOAuthConfig {
  return {
    // WorkOS AuthKit is the authorization server; this is its only resource.
    issuer: process.env.MCP_OAUTH_ISSUER ?? '',
    audience: process.env.VDR_MCP_OAUTH_AUDIENCE ?? '',
    jwksUri: process.env.MCP_OAUTH_JWKS_URL ?? '',
    tenantClaim: process.env.MCP_OAUTH_TENANT_CLAIM ?? '',
    clientIdClaim: process.env.MCP_OAUTH_CLIENT_ID_CLAIM ?? '',
    scopes: vdrMcpScopesFromEnv(),
  }
}

export const verifyVdrMcpBearerEffect = Effect.fn('VdrMcpOAuth.verifyBearer')(function* (
  request: Request,
  mcpBody: unknown,
  config: VdrMcpOAuthConfig,
  dependencies: McpOAuthDependencies = {}
): Effect.fn.Return<McpOAuthPrincipal, McpOAuthError> {
  return yield* verifyMcpBearerCoreEffect(
    request,
    toCoreConfig(config),
    () => scopeDemandForVdrMcpBodyEffect(mcpBody, config.scopes),
    dependencies
  )
})

/** Promise adapter retained for the Streamable HTTP boundary. */
export async function verifyVdrMcpBearer(
  request: Request,
  mcpBody: unknown,
  config: VdrMcpOAuthConfig,
  dependencies: McpOAuthDependencies = {}
): Promise<McpOAuthPrincipal> {
  return runServerEffect(verifyVdrMcpBearerEffect(request, mcpBody, config, dependencies))
}
