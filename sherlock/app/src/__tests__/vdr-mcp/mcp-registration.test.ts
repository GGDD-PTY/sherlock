// ============================================================================
// VDR READ MCP — real registration against the SDK
// ============================================================================
// Every other vdr-mcp test drives `createVdrMcpPostHandler` with a hand-built
// `stubHandler()` (a plain `{ fetch, close }` double), so none of them ever
// call `McpServer.registerTool` for real. That is the one place a raw Effect
// `Schema.Struct` passed as `inputSchema` throws at construction time — the
// SDK requires a Standard Schema (`~standard`), and `Schema.Struct` does not
// implement it. This test calls the real `createVdrMcpHandler` so a schema
// that stops being convertible fails here, not in the first client's session.
// ============================================================================

import { describe, expect, it } from 'vitest'

import { createVdrMcpHandler } from '@/lib/vdr-mcp/mcp'
import { VDR_MCP_TOOL_NAMES } from '@/lib/vdr-mcp/oauth'
import type { McpOAuthPrincipal } from '@/lib/mcp-shared/oauth-core'
import type { VdrReadStore } from '@/lib/vdr-mcp/store'

const principal: McpOAuthPrincipal = {
  issuer: 'https://issuer.example.test',
  audience: 'https://sherlock.example.test/api/vdr-mcp',
  principalId: 'user_01ABC',
  tenantId: 'org_01ABC',
  clientId: 'client_01ABC',
  scopes: ['openid'],
  expiresAt: Date.now() + 600_000,
}

// tools/list never reaches the store — only registration and the JSON Schema
// conversion are under test — so every method can refuse to be called.
function unusedStore(): VdrReadStore {
  const unreachable = (name: string) => async () => {
    throw new Error(`unreachable in this test: ${name}`)
  }
  return {
    resolveRoom: unreachable('resolveRoom'),
    readVersionBytes: unreachable('readVersionBytes'),
    readTextIndex: unreachable('readTextIndex'),
    writeTextIndex: unreachable('writeTextIndex'),
    recordAudit: unreachable('recordAudit'),
    issueUploadIntent: unreachable('issueUploadIntent'),
    registerUpload: unreachable('registerUpload'),
  }
}

describe('createVdrMcpHandler — real SDK registration', () => {
  it('registers all eleven tools without registerTool throwing, and answers tools/list', async () => {
    const handler = createVdrMcpHandler({ store: unusedStore() })
    try {
      const response = await handler.fetch(
        new Request('https://sherlock.example.test/api/vdr-mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        principal
      )

      expect(response.status).toBe(200)
      // The SDK answers a single POST as an SSE stream by default (no
      // `responseMode: 'json'` is configured), so the JSON-RPC result sits
      // behind a `data: ` line rather than being the whole body.
      const sse = await response.text()
      const dataLine = sse.split('\n').find((line) => line.startsWith('data: '))
      expect(dataLine).toBeDefined()
      const body = JSON.parse(dataLine!.slice('data: '.length)) as {
        result?: { tools?: Array<{ name: string; inputSchema?: unknown }> }
      }
      expect(body.result?.tools).toBeDefined()
      const tools = body.result!.tools!
      expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(VDR_MCP_TOOL_NAMES))

      // Every tool must carry a real JSON Schema object (what
      // Schema.toStandardJSONSchemaV1 produces), not the raw Effect
      // Schema.Struct this bug used to hand the SDK.
      const schemaTypes = tools.map(
        (tool) => (tool.inputSchema as { type?: unknown } | undefined)?.type
      )
      expect(schemaTypes).toEqual(tools.map(() => 'object'))

      // The client brings its own model, and the parameter description is all
      // that model reads about a parameter. One without it, or with an empty or
      // blank one, fails here by name.
      const undescribed = tools.flatMap((tool) => {
        const properties =
          (tool.inputSchema as { properties?: Record<string, { description?: unknown }> })
            .properties ?? {}
        return Object.entries(properties)
          .filter(
            ([, property]) =>
              typeof property.description !== 'string' || property.description.trim().length === 0
          )
          .map(([parameter]) => `${tool.name}.${parameter}`)
      })
      expect(undescribed).toEqual([])
    } finally {
      await handler.close()
    }
  })
})
