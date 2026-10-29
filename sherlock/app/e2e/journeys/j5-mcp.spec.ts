import { expect, test } from '@playwright/test'

import {
  JOURNEY_COMPANY_NAME,
  JOURNEY_GOAL_MS,
  JOURNEY_OWNER_EMAIL,
  journeyDeliverableName,
  journeyMcpCall,
  mintJourneyMcpToken,
  startHeadlessJourney,
} from '../helpers/journeys'

// J5: el cliente conecta el MCP de su sala con el token local (O4-03) y hace
// las tres preguntas del plan: `sala_resumen`, `documento_buscar` y
// `modelo_resumen`. Sin navegador: es el camino de terminal.
const TOOLS = ['sala_resumen', 'documento_buscar', 'modelo_resumen'] as const

type ToolPayload = Record<string, unknown>

type McpDocument = { documentId?: unknown; nombre?: unknown; mimeType?: unknown }

const XLSX_MIME = /spreadsheetml|excel/i

/**
 * El libro que J3 subió en esta corrida, o el último de la sala.
 *
 * Vive fuera del `test` porque leer una respuesta ajena es decidir entre casos,
 * y dentro del cuerpo de una prueba esas decisiones se leen como ramas de la
 * prueba misma.
 */
function pickDeliverableWorkbook(payload: ToolPayload): McpDocument | undefined {
  const documents = (payload.documentos as McpDocument[] | undefined) ?? []
  const workbooks = documents.filter(
    (document) => typeof document.mimeType === 'string' && XLSX_MIME.test(document.mimeType)
  )
  return (
    workbooks.find((document) => document.nombre === journeyDeliverableName()) ?? workbooks.at(-1)
  )
}

function documentIdOf(document: McpDocument | undefined): string {
  return typeof document?.documentId === 'string' ? document.documentId : ''
}

function sheetNamesOf(payload: ToolPayload): string[] {
  const hojas = payload.hojas
  return Array.isArray(hojas) ? hojas.filter((hoja) => typeof hoja === 'string') : []
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

test.describe('J5 el cliente conecta su MCP y pregunta por su sala', () => {
  test.setTimeout(JOURNEY_GOAL_MS.J5 * 2)

  test('token local, initialize, tools/list y las tres herramientas', async () => {
    const journey = startHeadlessJourney('J5')

    const token = await journey.step('token', async () => mintJourneyMcpToken(JOURNEY_OWNER_EMAIL))

    const protocolHeader = await journey.step('initialize', async () => {
      const initialize = await journeyMcpCall(token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sherlock-e2e-j5', version: '0.0.0' },
        },
      })
      expect(initialize.status, JSON.stringify(initialize.json)).toBe(200)
      const negotiated = (initialize.json.result as { protocolVersion?: string }).protocolVersion
      expect(negotiated).toBeTruthy()
      return { 'mcp-protocol-version': String(negotiated) }
    })

    /**
     * Llama una herramienta y devuelve su payload.
     *
     * Un fallo de herramienta NO es un error de JSON-RPC: la respuesta llega 200
     * con `isError: true` y `structuredContent.error` (`src/lib/vdr-mcp/mcp.ts`).
     * Asertar solo el status dejaba pasar «esta sala no tiene un modelo».
     */
    let nextId = 10
    const callTool = async (name: string, args: ToolPayload): Promise<ToolPayload> => {
      const response = await journeyMcpCall(
        token,
        {
          jsonrpc: '2.0',
          id: (nextId += 1),
          method: 'tools/call',
          params: { name, arguments: args },
        },
        protocolHeader
      )
      const shown = JSON.stringify(response.json).slice(0, 600)
      expect(response.status, shown).toBe(200)
      expect(response.json.error, shown).toBeUndefined()
      const result = response.json.result as
        { isError?: boolean; structuredContent?: ToolPayload } | undefined
      expect(result, `${name} no devolvió result: ${shown}`).toBeDefined()
      expect(result?.isError, `${name} contestó con error: ${shown}`).toBeFalsy()
      const payload = result?.structuredContent
      expect(payload, `${name} no devolvió structuredContent: ${shown}`).toBeDefined()
      expect(payload?.error, `${name} contestó con error: ${shown}`).toBeUndefined()
      return payload as ToolPayload
    }

    await journey.step('tools/list', async () => {
      const listed = await journeyMcpCall(
        token,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        protocolHeader
      )
      expect(listed.status, JSON.stringify(listed.json)).toBe(200)
      const tools = (listed.json.result as { tools?: Array<{ name: string }> } | undefined)?.tools
      expect(tools).toBeDefined()
      expect(tools!.map((tool) => tool.name)).toEqual(expect.arrayContaining([...TOOLS]))
    })

    await journey.step('sala_resumen', async () => {
      const payload = await callTool('sala_resumen', {})
      expect(JSON.stringify(payload)).toContain(JOURNEY_COMPANY_NAME)
    })

    await journey.step('documento_buscar', async () => {
      // `Legales 1.pdf` lo siembra `buildCustomSeedDocuments` para Journeys
      // (`--docs 1`): el cuerpo lleva «Cifras ficticias.» en texto extraíble.
      const payload = await callTool('documento_buscar', { consulta: 'Cifras ficticias' })
      const hits = payload.resultados
      expect(Array.isArray(hits), JSON.stringify(payload).slice(0, 400)).toBe(true)
      expect(
        (hits as unknown[]).length,
        `documento_buscar no encontró «Cifras ficticias» en Legales 1.pdf: ${JSON.stringify(payload).slice(0, 400)}`
      ).toBeGreaterThanOrEqual(1)
    })

    await journey.step('modelo_resumen', async () => {
      // El modelo se pide por `documento_id`. Sin él, una sala con dos libros
      // contesta ARGUMENTO_INVALIDO (`resolveModelDocumentEffect`), y la
      // segunda corrida del banco deja dos: el de esta corrida y el de la
      // anterior. Se busca el que J3 acaba de subir y, si J3 no corrió en esta
      // vuelta, el último libro de la sala.
      const room = await callTool('sala_documentos', { limite: 200 })
      const documentoId = documentIdOf(pickDeliverableWorkbook(room))
      expect(
        documentoId,
        `la sala de ${JOURNEY_COMPANY_NAME} no tiene modelo XLSX: corre J3 antes de J5`
      ).not.toBe('')

      const sheets = await callTool('modelo_hojas', { documento_id: documentoId })
      const hojas = sheetNamesOf(sheets)
      expect(hojas.length, `el modelo no declaró hojas: ${JSON.stringify(sheets)}`).toBeGreaterThan(
        0
      )

      const payload = await callTool('modelo_resumen', {
        documento_id: documentoId,
        hoja: hojas[0],
      })
      expect(payload.hoja).toBe(hojas[0])
      expect(textOf(payload.resumen).length).toBeGreaterThan(0)
    })

    journey.end()
  })
})
