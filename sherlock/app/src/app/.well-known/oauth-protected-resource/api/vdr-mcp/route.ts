import { Effect } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'
import {
  VDR_MCP_AUDIENCE_PATH,
  isVdrMcpEnabled,
  vdrMcpHiddenVerbHandlers,
  vdrMcpUnavailableResponse,
} from '@/lib/vdr-mcp/config'
import { vdrMcpScopesFromEnv, type VdrMcpScopes } from '@/lib/vdr-mcp/oauth'

export const { POST, PUT, PATCH, DELETE, OPTIONS } = vdrMcpHiddenVerbHandlers('GET')

type ProtectedResourceConfig = Readonly<{
  resource: string
  authorizationServer: string
  scopes: VdrMcpScopes
}>

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/

// Las mismas cabeceras que `VDR_MCP_RESPONSE_HEADERS`, declaradas aquí: este
// archivo vive bajo `.well-known/`, un directorio con punto que el `src/**`
// de `tsconfig.json` no recorre, y el lint con tipos ve sus imports como
// valores sin tipo; cada uso de un import cuenta como asignación insegura.
const PRM_RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function isLocalDevAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return (
    process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true' ||
    process.env.BYPASS_AUTH === 'true' ||
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'
  )
}

function isAllowedPrmUrlProtocol(url: URL): boolean {
  if (url.protocol === 'https:') return true
  return isLocalDevAuthEnabled() && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

function exactHttpsUrl(value: string, requiredPath?: string): string {
  try {
    const url = new URL(value)
    if (
      !isAllowedPrmUrlProtocol(url) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (requiredPath !== undefined && url.pathname !== requiredPath)
    ) {
      throw new Error('VDR_MCP_PRM_CONFIG_INVALID')
    }
    return value
  } catch {
    throw new Error('VDR_MCP_PRM_CONFIG_INVALID')
  }
}

export function createVdrProtectedResourceMetadataResponse(
  config: ProtectedResourceConfig
): Response {
  const resource = exactHttpsUrl(config.resource, VDR_MCP_AUDIENCE_PATH)
  const authorizationServer = exactHttpsUrl(config.authorizationServer)
  // Solo el scope base. Un cliente MCP pide todo lo que liste `scopes_supported`,
  // y AuthKit de prod responde `invalid_scope` a `vdr:write` (medido el
  // 2026-09-12; WorkOS no deja asignar scopes a clientes registrados por DCR).
  // Las herramientas de escritura siguen exigiendo `vdr:write` y sin él dan 403.
  const scopes = [config.scopes.base]
  if (scopes.some((scope) => !SCOPE_TOKEN.test(scope)) || new Set(scopes).size !== scopes.length) {
    throw new Error('VDR_MCP_PRM_CONFIG_INVALID')
  }
  return Response.json(
    {
      resource,
      authorization_servers: [authorizationServer],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    },
    { headers: PRM_RESPONSE_HEADERS }
  )
}

/** La PRM raíz describe este mismo y único recurso, así que sirve este mismo
 *  documento: lo importa desde acá en vez de rearmar el JSON. */
export const getProtectedResourceMetadata = () => {
  if (!isVdrMcpEnabled()) return Effect.succeed(vdrMcpUnavailableResponse())
  return Effect.sync(() =>
    createVdrProtectedResourceMetadataResponse({
      resource: process.env.VDR_MCP_OAUTH_AUDIENCE ?? '',
      // The WorkOS AuthKit authorization server.
      authorizationServer: process.env.MCP_OAUTH_ISSUER ?? '',
      scopes: vdrMcpScopesFromEnv(),
    })
  ).pipe(
    Effect.catchCause(() =>
      Effect.succeed(
        Response.json(
          { error: 'resource_metadata_unavailable' },
          { status: 503, headers: PRM_RESPONSE_HEADERS }
        )
      )
    )
  )
}

export function GET(): Promise<Response> {
  return runServerEffect(getProtectedResourceMetadata())
}
