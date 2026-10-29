import { describe, expect, it } from 'vitest'

import type { McpOAuthPrincipal } from '@/lib/mcp-shared/oauth-core'
import { createVdrMcpHandler } from '@/lib/vdr-mcp/mcp'
import type { VdrReadStore } from '@/lib/vdr-mcp/store'

const principal: McpOAuthPrincipal = {
  issuer: 'https://issuer.example.test',
  audience: 'https://sherlock.example.test/api/vdr-mcp',
  principalId: `user_upload_${Date.now()}`,
  tenantId: 'org_01ABC',
  clientId: 'client_01ABC',
  scopes: ['openid', 'vdr:write'],
  expiresAt: Date.now() + 600_000,
}

function uploadStore(): VdrReadStore {
  const unreachable = (name: string) => async () => {
    throw new Error(`unreachable in this test: ${name}`)
  }
  let issued = 0
  return {
    resolveRoom: unreachable('resolveRoom'),
    readVersionBytes: unreachable('readVersionBytes'),
    readTextIndex: unreachable('readTextIndex'),
    writeTextIndex: unreachable('writeTextIndex'),
    recordAudit: async () => undefined,
    issueUploadIntent: async () => {
      issued += 1
      return {
        intentId: `intent_${issued}`,
        uploadUrl: 'https://storage.example/upload-once',
        expiresAt: Date.now() + 600_000,
      }
    },
    registerUpload: unreachable('registerUpload'),
  }
}

async function callSubir(
  handler: ReturnType<typeof createVdrMcpHandler>,
  id: number
): Promise<Response> {
  return handler.fetch(
    new Request('https://sherlock.example.test/api/vdr-mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'documento_subir',
          arguments: {
            carpeta: 'room_legal',
            nombre: 'acta.pdf',
            mime: 'application/pdf',
            tamano_bytes: 1024,
          },
        },
      }),
    }),
    principal,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'documento_subir',
        arguments: {
          carpeta: 'room_legal',
          nombre: 'acta.pdf',
          mime: 'application/pdf',
          tamano_bytes: 1024,
        },
      },
    }
  )
}

describe('documento_subir rate limit', () => {
  it('la undécima subida del mismo principal responde 429 con retry-after', async () => {
    const handler = createVdrMcpHandler({ store: uploadStore() })
    try {
      for (let index = 1; index <= 10; index += 1) {
        const response = await callSubir(handler, index)
        expect(response.status).toBe(200)
      }
      const limited = await callSubir(handler, 11)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toMatch(/^[1-9]\d*$/)
      await expect(limited.json()).resolves.toEqual({ error: 'rate_limited' })
    } finally {
      await handler.close()
    }
  })
})
