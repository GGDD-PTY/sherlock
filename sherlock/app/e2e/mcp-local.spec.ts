import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

const APP_DIR = resolve(process.cwd())
const SCRIPT = resolve(APP_DIR, 'scripts/convex-local.mjs')
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3114'
const MCP_URL = `${BASE_URL.replace(/\/$/, '')}/api/vdr-mcp`
const BUDGET_MS = 5_000

function mintToken(scope = 'openid', role?: string): string {
  const appPort = new URL(BASE_URL).port || '80'
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      'mcp-token',
      '--email',
      'company@dev.local',
      '--scope',
      scope,
      ...(role === undefined ? [] : ['--role', role]),
    ],
    {
      cwd: APP_DIR,
      encoding: 'utf8',
      env: { ...process.env, PORT: appPort },
    }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || 'mcp-token falló')
  }
  const token = result.stdout.trim().split('\n')[0]
  if (!token || token.split('.').length !== 3) {
    throw new Error('mcp-token no imprimió un JWT')
  }
  return token
}

function toolData(json: Record<string, unknown>): {
  upload_url?: string
  intent_id?: string
} {
  const result = json.result as
    { structuredContent?: { upload_url?: string; intent_id?: string } } | undefined
  return result?.structuredContent ?? {}
}

async function readJsonRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const raw = dataLine === undefined ? text : dataLine.slice('data: '.length)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`MCP no devolvió JSON (${response.status}): ${text.slice(0, 400)}`, {
      cause,
    })
  }
}

async function mcpCall(
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ ms: number; json: Record<string, unknown>; status: number }> {
  const started = Date.now()
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - started
  const json = await readJsonRpc(response)
  return { ms, json, status: response.status }
}

/** Sube un PDF por MCP y lo publica: `documento_subir`, el POST del intent y
 *  `documento_confirmar`, más la lista de la carpeta como recibo. */
async function subeYConfirma(token: string, nombre: string, idBase: number): Promise<void> {
  const initialize = await mcpCall(token, {
    jsonrpc: '2.0',
    id: idBase,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'sherlock-e2e-mcp-upload', version: '0.0.0' },
    },
  })
  expect(initialize.status, JSON.stringify(initialize.json)).toBe(200)
  const negotiated = (initialize.json.result as { protocolVersion: string }).protocolVersion
  expect(negotiated).toEqual(expect.any(String))
  const protocolHeader = { 'mcp-protocol-version': negotiated }

  const pdf = Buffer.alloc(100 * 1024, 32)
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').copy(pdf)

  const issued = await mcpCall(
    token,
    {
      jsonrpc: '2.0',
      id: idBase + 1,
      method: 'tools/call',
      params: {
        name: 'documento_subir',
        arguments: {
          carpeta: 'room_legal',
          nombre,
          mime: 'application/pdf',
          tamano_bytes: pdf.byteLength,
          nota: 'subida por MCP O4-05',
        },
      },
    },
    protocolHeader
  )
  expect(issued.status, JSON.stringify(issued.json)).toBe(200)
  const issuedData = toolData(issued.json)
  const uploadUrl = issuedData.upload_url
  const intentId = issuedData.intent_id
  expect(uploadUrl).toMatch(/^https?:\/\//)
  expect(intentId).toEqual(expect.any(String))
  // `toolData` los declara opcionales porque el `structuredContent` puede venir
  // vacío; el guard es lo que los convierte en `string` para el POST del intent
  // y para `documento_confirmar`.
  if (uploadUrl === undefined || intentId === undefined) {
    throw new Error(
      `documento_subir no devolvió upload_url/intent_id: ${JSON.stringify(issuedData)}`
    )
  }

  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: pdf,
  })
  const uploadedText = await uploaded.text()
  expect(uploaded.ok, uploadedText).toBe(true)
  const receipt = JSON.parse(uploadedText) as { storageId?: string }
  expect(receipt.storageId).toBeTruthy()

  const confirmed = await mcpCall(
    token,
    {
      jsonrpc: '2.0',
      id: idBase + 2,
      method: 'tools/call',
      params: {
        name: 'documento_confirmar',
        arguments: { intent_id: intentId, storage_id: receipt.storageId },
      },
    },
    protocolHeader
  )
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200)
  expect(JSON.stringify(confirmed.json)).toContain(nombre)

  const listed = await mcpCall(
    token,
    {
      jsonrpc: '2.0',
      id: idBase + 3,
      method: 'tools/call',
      params: { name: 'sala_documentos', arguments: { carpeta: 'room_legal' } },
    },
    protocolHeader
  )
  expect(listed.status, JSON.stringify(listed.json)).toBe(200)
  expect(JSON.stringify(listed.json)).toContain(nombre)
}

test.describe('MCP local contra /api/vdr-mcp', () => {
  test('initialize, tools/list, sala_resumen y documento_buscar en menos de 5 s', async () => {
    const token = mintToken()

    const initialize = await mcpCall(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'sherlock-e2e-mcp-local', version: '0.0.0' },
      },
    })
    expect(initialize.status, JSON.stringify(initialize.json)).toBe(200)
    expect(initialize.ms).toBeLessThan(BUDGET_MS)
    expect(initialize.json.result).toBeTruthy()
    const negotiated = (initialize.json.result as { protocolVersion?: string }).protocolVersion
    expect(negotiated).toBeTruthy()
    const protocolHeader = { 'mcp-protocol-version': negotiated ?? '' }

    const listed = await mcpCall(
      token,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
      protocolHeader
    )
    expect(listed.status, JSON.stringify(listed.json)).toBe(200)
    expect(listed.ms).toBeLessThan(BUDGET_MS)
    const tools = (listed.json.result as { tools?: Array<{ name: string }> } | undefined)?.tools
    expect(tools).toBeDefined()
    expect(tools!.length).toBeGreaterThanOrEqual(9)
    expect(tools!.length).toBeLessThanOrEqual(11)
    expect(tools!.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'sala_resumen',
        'documento_buscar',
        'documento_subir',
        'documento_confirmar',
      ])
    )

    const resumen = await mcpCall(
      token,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'sala_resumen', arguments: {} },
      },
      protocolHeader
    )
    expect(resumen.status, JSON.stringify(resumen.json)).toBe(200)
    expect(resumen.ms).toBeLessThan(BUDGET_MS)
    const resumenText = JSON.stringify(resumen.json)
    expect(resumenText).toMatch(/Sintética Uno/)

    const buscar = await mcpCall(
      token,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'documento_buscar', arguments: { consulta: 'Sintetica' } },
      },
      protocolHeader
    )
    expect(buscar.status, JSON.stringify(buscar.json)).toBe(200)
    expect(buscar.ms).toBeLessThan(BUDGET_MS)
    expect(buscar.json.result).toBeTruthy()
  })

  test('openid solo no puede documento_subir; openid vdr:write sube un PDF a room_legal', async () => {
    const readToken = mintToken()
    const denied = await mcpCall(readToken, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'documento_subir',
        arguments: {
          carpeta: 'room_legal',
          nombre: 'acta-mcp.pdf',
          mime: 'application/pdf',
          tamano_bytes: 100 * 1024,
          nota: 'subida por MCP O4-05',
        },
      },
    })
    expect(denied.status).toBe(403)

    await subeYConfirma(mintToken('openid vdr:write'), 'acta-mcp.pdf', 11)
  })

  // El token real de AuthKit nunca trae `vdr:write`: llega con `openid` y el
  // rol en `sherlock_role` (medido contra prod el 2026-09-12). El banco local
  // firma ese mismo token con `--role` y la escritura tiene que abrir igual.
  test('un token openid con rol company_owner sube y publica un PDF en room_legal', async () => {
    const roleToken = mintToken('openid', 'company_owner')

    await subeYConfirma(roleToken, 'acta-mcp-rol.pdf', 20)
  })
})
