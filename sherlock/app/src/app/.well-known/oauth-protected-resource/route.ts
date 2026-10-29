// ============================================================================
// VDR READ MCP — PRM raíz (RFC 9728 §3.1)
// ============================================================================
// El cliente MCP pide esta URL antes que la PRM por path. Mientras no existió,
// caía en el redirect de locale, recibía HTML en vez de JSON y terminaba
// intentando registro dinámico en `/register` con un 404 por respuesta.
// Solo hay un recurso protegido (`/api/vdr-mcp`), así que las dos URLs son la
// misma superficie: esta no rearma el documento ni sus señuelos de verbo, corre
// el mismo programa y reexporta los mismos handlers. Lo único propio es el
// span, para poder distinguir en la traza cuál de las dos URL pidió el cliente.
// ============================================================================

import { Effect } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'

import { getProtectedResourceMetadata } from './api/vdr-mcp/route'

export { POST, PUT, PATCH, DELETE, OPTIONS } from './api/vdr-mcp/route'

export function GET(): Promise<Response> {
  return runServerEffect(getProtectedResourceMetadata().pipe(Effect.withSpan('VdrMcpPrm.rootGET')))
}
