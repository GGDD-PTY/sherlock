import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'
import { Schema } from 'effect'

export const VDR_MCP_AUDIENCE_PATH = '/api/vdr-mcp' as const
// `initialize` del SDK v2 negocia la era 2025 (`SUPPORTED_PROTOCOL_VERSIONS`).
// `2026-07-28` es la era moderna (`server/discover`); no entra en ese handshake.
export const VDR_MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION
export const VDR_MCP_SERVER_NAME = 'sherlock-vdr-read' as const
export const VDR_MCP_SERVER_VERSION = '1.0.0' as const

// La bandera es una variable de entorno: lo que llega es `string | undefined`.
// El único valor que prende el servidor es el literal `'true'`, declarado una
// vez — ni `'1'`, ni `'TRUE'`, ni un string vacío.
const VdrMcpEnabledFlagSchema = Schema.Literals(['true'])
const isEnabledFlag = Schema.is(VdrMcpEnabledFlagSchema)

export function isVdrMcpEnabled(value = process.env.VDR_MCP_ENABLED): boolean {
  return isEnabledFlag(value)
}

// Toda respuesta de la superficie MCP y de su PRM sale sin caché y sin
// sniffing de tipo; el cuerpo JSON-RPC o RFC 9728 no gana un `requestId`.
export const VDR_MCP_RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

export function vdrMcpUnavailableResponse(): Response {
  return Response.json({ error: 'Not found' }, { status: 404, headers: VDR_MCP_RESPONSE_HEADERS })
}

// Same reasoning as the Model Runs gate: Next.js auto-answers OPTIONS and
// undeclared verbs on any route module, so a gated route that only exports its
// real handler still leaks its existence through the other verbs. Gate off →
// the same generic 404; gate on → the default the verb would have gotten.
/** El único verbo que la ruta declara de verdad; el resto son señuelos. */
export function vdrMcpHiddenVerbHandlers(declared: 'GET' | 'POST'): {
  GET: () => Response
  POST: () => Response
  PUT: () => Response
  PATCH: () => Response
  DELETE: () => Response
  OPTIONS: () => Response
} {
  const allow = declared === 'GET' ? 'GET, HEAD, OPTIONS' : 'POST, OPTIONS'
  const fallback = (enabledResponse: () => Response) => (): Response =>
    isVdrMcpEnabled() ? enabledResponse() : vdrMcpUnavailableResponse()
  const methodNotAllowed = fallback(
    () => new Response(null, { status: 405, headers: { allow, ...VDR_MCP_RESPONSE_HEADERS } })
  )
  return {
    GET: methodNotAllowed,
    POST: methodNotAllowed,
    PUT: methodNotAllowed,
    PATCH: methodNotAllowed,
    DELETE: methodNotAllowed,
    OPTIONS: fallback(
      () => new Response(null, { status: 204, headers: { allow, ...VDR_MCP_RESPONSE_HEADERS } })
    ),
  }
}
