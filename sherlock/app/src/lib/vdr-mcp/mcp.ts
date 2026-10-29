// ============================================================================
// VDR READ MCP — MCP server surface
// ============================================================================
// Read tools plus documento_subir / documento_confirmar. Zero resources, zero
// prompts. Everything the tools can answer comes from `runTool`.
//
// This module only shares the OAuth core in `@/lib/mcp-shared`: it never
// reaches the team tooling, a worker or a private route. Enforced by
// `src/__tests__/vdr-mcp/boundary.test.ts`.
// ============================================================================

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import { Effect, Predicate } from 'effect'
import { createHash } from 'node:crypto'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { runServerEffect } from '@/lib/effect/runtime'
import { createLogger } from '@/lib/logger'
import { checkRateLimitDistributed, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'
import {
  VDR_MCP_RESPONSE_HEADERS,
  VDR_MCP_SERVER_NAME,
  VDR_MCP_SERVER_VERSION,
} from '@/lib/vdr-mcp/config'
import { VdrToolError, toToolErrorPayload } from '@/lib/vdr-mcp/errors'
import { VDR_MCP_TOOL_NAMES, isVdrMcpWriteToolName, type VdrMcpToolName } from '@/lib/vdr-mcp/oauth'
import type { McpOAuthPrincipal } from '@/lib/mcp-shared/oauth-core'
import { createVdrToolContext } from '@/lib/vdr-mcp/context'
import type { VdrReadStore } from '@/lib/vdr-mcp/store'
import { vdrToolkit } from '@/lib/vdr-mcp/toolkit'
import { runToolEffect, type VdrToolContext } from '@/lib/vdr-mcp/tools'
import type { WorkbookLoader } from '@/lib/vdr-mcp/workbook'

const log = createLogger('VdrMcp')

const READ_CACHE_HINT = { ttlMs: 0, cacheScope: 'private' } as const
const CATALOG_CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const

export type VdrMcpAudit = (entry: {
  tool: VdrMcpToolName
  argsSha256: string
  outcome: 'OK' | 'DENIED' | 'NOT_FOUND' | 'ERROR'
  errorCode?: string
  resultSummary?: string
}) => Promise<void>

export type VdrMcpHandler = Readonly<{
  fetch: (request: Request, principal: McpOAuthPrincipal, parsedBody?: unknown) => Promise<Response>
  close: () => Promise<void>
}>

function argumentsDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
}

function sdkAuthInfo(principal: McpOAuthPrincipal): AuthInfo {
  return {
    // The SDK wants a token-shaped field. Public bearer bytes are never stored,
    // forwarded to Convex, or handed to any tool.
    token: '',
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    expiresAt: Math.floor(principal.expiresAt / 1_000),
    extra: { principalId: principal.principalId, tenantId: principal.tenantId },
  }
}

function recordAudit(
  audit: VdrMcpAudit | undefined,
  entry: Parameters<VdrMcpAudit>[0]
): Effect.Effect<void, UnexpectedAppError> {
  if (!audit) return Effect.sync(() => {})
  return Effect.tryPromise({
    try: () => audit(entry),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'VdrMcp.audit',
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })
}

function registerReadTools(
  server: McpServer,
  context: VdrToolContext,
  audit: VdrMcpAudit | undefined
): void {
  for (const name of VDR_MCP_TOOL_NAMES) {
    const tool = vdrToolkit.tools[name]
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.parametersSchema,
        annotations: isVdrMcpWriteToolName(name)
          ? {
              readOnlyHint: false,
              idempotentHint: name === 'documento_confirmar',
              destructiveHint: false,
            }
          : { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
      },
      (input: unknown) => {
        const argsSha256 = argumentsDigest(input)
        return runServerEffect(
          runToolEffect(context, name, input).pipe(
            Effect.flatMap((result) => {
              const payload = { ...result.data, citations: result.citations }
              return recordAudit(audit, {
                tool: name,
                argsSha256,
                outcome: 'OK',
                resultSummary: `citations=${result.citations.length}`,
              }).pipe(
                Effect.as({
                  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
                  structuredContent: payload,
                })
              )
            }),
            Effect.catch((cause) => {
              const error = toToolErrorPayload(cause)
              // A VdrToolError is a correctable answer the agent is meant to read.
              // Anything else collapsed into the generic NO_DISPONIBLE, and without
              // this line production would have no record of what actually broke:
              // the client only ever sees the generic payload.
              if (!(cause instanceof VdrToolError)) {
                log.error('tool failed with an unexpected error', {
                  tool: name,
                  // The digest, never the arguments: it joins to the Convex audit
                  // row without putting room content in a log line.
                  argsSha256,
                  error: cause,
                })
              }
              return recordAudit(audit, {
                tool: name,
                argsSha256,
                outcome: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'ERROR',
                errorCode: error.code,
              }).pipe(
                Effect.catch((auditError) => {
                  log.error('tool audit failed', { tool: name, argsSha256, error: auditError })
                  return Effect.sync(() => {})
                }),
                Effect.as({
                  content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
                  structuredContent: { error },
                  isError: true as const,
                })
              )
            })
          )
        )
      }
    )
  }

  // No resources and no prompts are registered on this surface at all: bytes
  // never leave the room, so the SDK never advertises the capability and the
  // methods answer "method not found" without any override of ours.
}

function isDocumentoSubirCall(body: unknown): boolean {
  return (
    Predicate.isObject(body) &&
    body.method === 'tools/call' &&
    Predicate.isObject(body.params) &&
    body.params.name === 'documento_subir'
  )
}

function uploadRateLimitKey(principal: McpOAuthPrincipal): string {
  const identityDigest = createHash('sha256')
    .update(`${principal.tenantId}\0${principal.principalId}\0${principal.clientId}`)
    .digest('hex')
  return `vdr-mcp-upload:${identityDigest}`
}

export function createVdrMcpHandler(args: {
  store?: VdrReadStore
  loadWorkbook?: WorkbookLoader
  audit?: (principal: McpOAuthPrincipal) => VdrMcpAudit
}): VdrMcpHandler {
  const handlers = new Set<McpHttpHandler>()
  return {
    fetch: (request, principal, parsedBody) =>
      runServerEffect(
        Effect.gen(function* () {
          if (isDocumentoSubirCall(parsedBody)) {
            const limit = yield* Effect.tryPromise({
              try: () =>
                checkRateLimitDistributed(
                  uploadRateLimitKey(principal),
                  RATE_LIMIT_PRESETS.mcpUpload
                ),
              catch: (cause) =>
                new UnexpectedAppError({
                  operation: 'VdrMcp.uploadRateLimit',
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            })
            if (!limit.success) {
              const retryAfterSec =
                Number.isSafeInteger(limit.retryAfterSec) && limit.retryAfterSec >= 1
                  ? limit.retryAfterSec
                  : 1
              return new Response(JSON.stringify({ error: 'rate_limited' }), {
                status: 429,
                headers: { ...VDR_MCP_RESPONSE_HEADERS, 'retry-after': String(retryAfterSec) },
              })
            }
          }
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              // Shared with the in-app assistant: one context builder, one policy.
              const context: VdrToolContext = createVdrToolContext({
                principal: { principalId: principal.principalId, clientId: principal.clientId },
                ...(args.store ? { store: args.store } : {}),
                ...(args.loadWorkbook ? { loadWorkbook: args.loadWorkbook } : {}),
              })
              const audit = args.audit?.(principal)
              const handler = createMcpHandler(
                () => {
                  const server = new McpServer(
                    { name: VDR_MCP_SERVER_NAME, version: VDR_MCP_SERVER_VERSION },
                    {
                      cacheHints: {
                        'tools/list': CATALOG_CACHE_HINT,
                        'server/discover': CATALOG_CACHE_HINT,
                        'resources/list': CATALOG_CACHE_HINT,
                        'resources/templates/list': CATALOG_CACHE_HINT,
                        'resources/read': READ_CACHE_HINT,
                      },
                    }
                  )
                  registerReadTools(server, context, audit)
                  return server
                },
                { legacy: 'stateless' }
              )
              handlers.add(handler)
              return handler
            }),
            (handler) =>
              Effect.promise(() =>
                handler.fetch(request, {
                  authInfo: sdkAuthInfo(principal),
                  ...(parsedBody === undefined ? {} : { parsedBody }),
                })
              ),
            (handler) =>
              Effect.promise(() => handler.close()).pipe(
                Effect.ensuring(Effect.sync(() => handlers.delete(handler)))
              )
          )
        })
      ),
    close: () =>
      runServerEffect(
        Effect.forEach(handlers, (handler) => Effect.promise(() => handler.close()), {
          concurrency: 'unbounded',
          discard: true,
        }).pipe(Effect.ensuring(Effect.sync(() => handlers.clear())))
      ),
  }
}
