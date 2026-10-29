// ============================================================================
// VDR READ MCP — Streamable HTTP boundary
// ============================================================================
// Streamable HTTP. `initialize` negocia la revisión del SDK
// (`VDR_MCP_PROTOCOL_VERSION`). La era 2026-07-28 exige además mcp-method /
// mcp-name. Order of checks is the contract:
//   origin -> content-type -> rate limit by ip -> bounded body -> bearer +
//   scopes -> rate limit by principal -> protocol header agreement -> dispatch.
// Everything answers `cache-control: no-store`.
// ============================================================================

import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import { Effect, Predicate } from 'effect'
import { createHash } from 'node:crypto'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  McpOAuthError,
  readBoundedJsonBody,
  type McpOAuthPrincipal,
} from '@/lib/mcp-shared/oauth-core'
import { VDR_MCP_AUDIENCE_PATH, VDR_MCP_RESPONSE_HEADERS } from '@/lib/vdr-mcp/config'
import { verifyVdrMcpBearer, type VdrMcpOAuthConfig } from '@/lib/vdr-mcp/oauth'
import type { VdrMcpHandler } from '@/lib/vdr-mcp/mcp'

const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28'
const HEADER_MISMATCH = -32020

type VerifyBearer = (
  request: Request,
  body: unknown,
  config: VdrMcpOAuthConfig
) => Promise<McpOAuthPrincipal>

type RateLimitOutcome = Readonly<{ success: boolean; retryAfterSec: number }>

export type VdrMcpPostDependencies = Readonly<{
  oauthConfig: VdrMcpOAuthConfig
  mcpHandler: VdrMcpHandler
  verifyBearer?: VerifyBearer
  rateLimit?: (principal: McpOAuthPrincipal) => Promise<RateLimitOutcome>
  rateLimitByIp?: (request: Request) => Promise<RateLimitOutcome>
}>

function jsonRpcId(body: unknown): string | number | null {
  if (!Predicate.isObject(body)) return null
  if (typeof body.id === 'string') return body.id
  if (typeof body.id === 'number' && Number.isFinite(body.id)) return body.id
  return null
}

function headerMismatch(body: unknown): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: jsonRpcId(body),
      error: { code: HEADER_MISMATCH, message: 'Header mismatch' },
    },
    { status: 400, headers: VDR_MCP_RESPONSE_HEADERS }
  )
}

function requestMeta(body: unknown): Record<string, unknown> | undefined {
  if (
    !Predicate.isObject(body) ||
    !Predicate.isObject(body.params) ||
    !Predicate.isObject(body.params._meta)
  )
    return undefined
  return body.params._meta
}

function isModernProtocolRevision(version: unknown): version is string {
  return typeof version === 'string' && version >= FIRST_MODERN_PROTOCOL_VERSION
}

function isModernMcpRequest(request: Request, body: unknown): boolean {
  return (
    isModernProtocolRevision(request.headers.get('mcp-protocol-version')) ||
    isModernProtocolRevision(requestMeta(body)?.[PROTOCOL_VERSION_META_KEY])
  )
}

function decodeMcpHeaderValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith('=?base64?') && trimmed.endsWith('?=')) {
    try {
      return Buffer.from(trimmed.slice('=?base64?'.length, -2), 'base64').toString('utf8')
    } catch {
      return undefined
    }
  }
  return trimmed
}

/**
 * La era 2026-07-28 exige que `mcp-method` / `mcp-name` coincidan con el cuerpo.
 * La revisión que negocia `initialize` (2025-11-25 hoy) no: solo manda
 * `MCP-Protocol-Version`. Desacuerdo en la era moderna es error de protocolo,
 * nunca un despacho.
 */
function modernHeaderRejection(request: Request, body: unknown): Response | undefined {
  if (!isModernMcpRequest(request, body)) return undefined
  if (!Predicate.isObject(body) || typeof body.method !== 'string') return headerMismatch(body)

  const versionHeader = request.headers.get('mcp-protocol-version')
  const claimed = requestMeta(body)?.[PROTOCOL_VERSION_META_KEY]
  if (versionHeader === null || (typeof claimed === 'string' && versionHeader !== claimed)) {
    return headerMismatch(body)
  }

  const methodHeader = request.headers.get('mcp-method')
  if (methodHeader === null || methodHeader !== body.method) return headerMismatch(body)

  if (body.method !== 'tools/call') return undefined
  const expectedName =
    Predicate.isObject(body.params) && typeof body.params.name === 'string'
      ? body.params.name
      : undefined
  if (expectedName === undefined) return undefined

  const nameHeader = request.headers.get('mcp-name')
  if (nameHeader === null) return headerMismatch(body)
  const decoded = decodeMcpHeaderValue(nameHeader)
  return decoded === expectedName ? undefined : headerMismatch(body)
}

function isWellFormedHttpOrigin(origin: string): boolean {
  if (origin === 'null' || origin.length === 0) return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (url.username !== '' || url.password !== '') return false
    return origin === url.origin
  } catch {
    return false
  }
}

function isAllowedOrigin(origin: string, audience: string): boolean {
  if (!isWellFormedHttpOrigin(origin)) return false
  try {
    return origin === new URL(audience).origin
  } catch {
    return false
  }
}

function sanitizedRequest(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  headers.delete('content-length')
  return new Request(request.url, { method: 'POST', headers, signal: request.signal })
}

function resourceMetadataUrl(audience: string): string {
  return new URL(`/.well-known/oauth-protected-resource${VDR_MCP_AUDIENCE_PATH}`, audience).href
}

export function vdrMcpErrorResponse(audience: string, cause: unknown): Response {
  if (cause instanceof McpOAuthError) {
    const headers = new Headers(VDR_MCP_RESPONSE_HEADERS)
    if (cause.status === 401 || cause.status === 403) {
      const error = cause.status === 403 ? 'insufficient_scope' : 'invalid_token'
      headers.set(
        'www-authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl(audience)}", error="${error}"`
      )
    }
    return Response.json(
      { error: cause.status === 401 || cause.status === 403 ? 'unauthorized' : 'invalid_request' },
      { status: cause.status, headers }
    )
  }
  return Response.json(
    { error: 'service_unavailable' },
    { status: 503, headers: VDR_MCP_RESPONSE_HEADERS }
  )
}

async function defaultRateLimit(principal: McpOAuthPrincipal) {
  const { checkRateLimitDistributed, RATE_LIMIT_PRESETS } = await import('@/lib/utils/rate-limit')
  const identityDigest = createHash('sha256')
    .update(`${principal.tenantId}\0${principal.principalId}\0${principal.clientId}`)
    .digest('hex')
  return checkRateLimitDistributed(`vdr-mcp:${identityDigest}`, RATE_LIMIT_PRESETS.api)
}

// Antes del bearer, por IP. El límite por principal solo existe después de
// verificar, y verificar un token con un `kid` inventado costaba un GET al
// JWKS de WorkOS por request: un caller sin token podía gastar ese fetch a
// voluntad. Mismo preset que el de principal.
async function defaultRateLimitByIp(request: Request) {
  const { checkRateLimitDistributed, getClientIp, RATE_LIMIT_PRESETS } =
    await import('@/lib/utils/rate-limit')
  return checkRateLimitDistributed(`vdr-mcp:ip:${getClientIp(request)}`, RATE_LIMIT_PRESETS.api)
}

const rateLimitedResponse = Effect.fn('VdrMcpHttp.rateLimited')(function* (
  limit: RateLimitOutcome
) {
  if (!Number.isSafeInteger(limit.retryAfterSec) || limit.retryAfterSec < 1) {
    return yield* new UnexpectedAppError({
      operation: 'VdrMcpHttp.rateLimit',
      message: 'VDR_MCP_RATE_LIMIT_INVALID',
    })
  }
  return Response.json(
    { error: 'rate_limited' },
    {
      status: 429,
      headers: { ...VDR_MCP_RESPONSE_HEADERS, 'retry-after': String(limit.retryAfterSec) },
    }
  )
})

function httpPromise<A>(
  operation: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, McpOAuthError | UnexpectedAppError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof McpOAuthError
        ? cause
        : new UnexpectedAppError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  }).pipe(Effect.withSpan(operation))
}

export function createVdrMcpPostHandler(dependencies: VdrMcpPostDependencies) {
  const verifyBearer = dependencies.verifyBearer ?? verifyVdrMcpBearer
  const rateLimit = dependencies.rateLimit ?? defaultRateLimit
  const rateLimitByIp = dependencies.rateLimitByIp ?? defaultRateLimitByIp

  const handleEffect = Effect.fn('VdrMcpHttp.POST')(function* (request: Request) {
    const origin = request.headers.get('origin')
    if (origin !== null && !isAllowedOrigin(origin, dependencies.oauthConfig.audience)) {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
        { status: 403, headers: VDR_MCP_RESPONSE_HEADERS }
      )
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
      return Response.json(
        { error: 'unsupported_media_type' },
        { status: 415, headers: VDR_MCP_RESPONSE_HEADERS }
      )
    }

    const ipLimit = yield* httpPromise('VdrMcpHttp.rateLimitByIp', () => rateLimitByIp(request))
    if (!ipLimit.success) return yield* rateLimitedResponse(ipLimit)

    const body = yield* httpPromise('VdrMcpHttp.readBody', () => readBoundedJsonBody(request))
    const principal = yield* httpPromise('VdrMcpHttp.verifyBearer', () =>
      verifyBearer(request, body, dependencies.oauthConfig)
    )

    const limit = yield* httpPromise('VdrMcpHttp.rateLimit', () => rateLimit(principal))
    if (!limit.success) return yield* rateLimitedResponse(limit)

    const rejected = modernHeaderRejection(request, body)
    if (rejected) return rejected

    const response = yield* httpPromise('VdrMcpHttp.dispatch', () =>
      dependencies.mcpHandler.fetch(sanitizedRequest(request), principal, body)
    )
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(VDR_MCP_RESPONSE_HEADERS)) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  })

  return function handleVdrMcpPost(request: Request): Promise<Response> {
    return runServerEffect(
      handleEffect(request).pipe(
        Effect.match({
          onSuccess: (response) => response,
          onFailure: (cause) => vdrMcpErrorResponse(dependencies.oauthConfig.audience, cause),
        })
      )
    )
  }
}
