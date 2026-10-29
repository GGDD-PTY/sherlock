// @vitest-environment node
// ============================================================================
// VDR READ MCP — the tool facade against real synthetic fixtures
// ============================================================================
// The workbook is read by the real engine and the documents by the real
// extractors: a citation that points at a range or a page is checked against
// the actual blob, not against a stub.
//
// Fictional issuer: "Andina Solar, S. A." — see
// scripts/generate-vdr-mcp-fixtures.mjs. No client data lives in this tree.
// ============================================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  computeRoomProgress,
  roomProgressInputFromSala,
  STAGE_ORDER,
} from '@/lib/vdr/room-progress'
import { decodeCitation } from '@/lib/vdr-mcp/citations'
import { VdrToolError } from '@/lib/vdr-mcp/errors'
import { EXTRACT_MAX_BYTES } from '@/lib/vdr-mcp/extract'
import type { Room, RoomDocument, VdrReadStore } from '@/lib/vdr-mcp/store'
import { runTool, toolInputSchemas, type VdrToolContext } from '@/lib/vdr-mcp/tools'
import { MODEL_MAX_CELLS_PER_CALL } from '@/lib/vdr-mcp/workbook'
import esMessages from '@/messages/es.json'

import { buildPasswordProtectedPdf, buildScannedPdf } from '../../../convex/_localSeed'
import { VDR_MCP_READ_MAX_BYTES } from '../../../convex/_documents/uploadLimits'
import { VDR_READ_MAX_BYTES } from '../../../convex/vdrRead'

const FIXTURES = resolve(process.cwd(), 'src/__tests__/fixtures/vdr-mcp')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)))
}

const BLOBS: Record<string, { file: string; mimeType: string }> = {
  version_modelo: {
    file: 'andina-solar-modelo.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  version_eeff: { file: 'andina-solar-eeff-fy24.pdf', mimeType: 'application/pdf' },
  version_negocio: {
    file: 'andina-solar-negocio.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  version_mgmt: {
    file: 'andina-solar-mgmt.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
}

function document(
  documentId: string,
  versionId: keyof typeof BLOBS,
  nombre: string,
  carpeta: string
): RoomDocument {
  return {
    documentId,
    versionId,
    nombre,
    carpeta,
    tipo: BLOBS[versionId].mimeType,
    versionNumero: 1,
    estadoPublicacion: 'PUBLISHED',
    bytes: fixture(BLOBS[versionId].file).byteLength,
    sha256: `${versionId}-sha`,
    mimeType: BLOBS[versionId].mimeType,
    actualizadoEn: 1_700_000_000_000,
  }
}

function stubDocument(documentId: string, carpeta: string): RoomDocument {
  return {
    documentId,
    versionId: `${documentId}_version`,
    nombre: `${documentId}.pdf`,
    carpeta,
    tipo: 'application/pdf',
    versionNumero: 1,
    estadoPublicacion: 'PUBLISHED',
    bytes: 128,
    sha256: `${documentId}-sha`,
    mimeType: 'application/pdf',
    actualizadoEn: 1_700_000_000_000,
  }
}

const ROOM: Room = {
  sala: {
    salaId: 'company_andina',
    empresa: 'Andina Solar, S. A.',
    pais: 'PA',
    rol: 'COMPANY',
  },
  documentos: [
    document('doc_modelo', 'version_modelo', 'Modelo financiero v3.xlsx', '3. Financieros'),
    document('doc_eeff', 'version_eeff', 'EEFF auditados FY24.pdf', '3. Financieros'),
    document('doc_negocio', 'version_negocio', 'Modelo de negocio.docx', '3. Financieros'),
    document(
      'doc_mgmt',
      'version_mgmt',
      'Management presentation.pptx',
      '5. Materiales de mercadeo'
    ),
  ],
  truncado: false,
  telefonoPresente: false,
  nombreConfirmado: false,
  entregables: STAGE_ORDER.map((etapa) => ({ etapa, estado: 'PENDING' })),
  conteosPorCarpeta: { room_financial: 3, room_marketing: 1 },
  ultimoMovimiento: {
    nombre: 'Management presentation.pptx',
    actualizadoEn: 1_700_000_000_000,
  },
}

type StoreCalls = {
  bytesReadsFor: string[]
  indexWrites: string[]
  audits: number
}

function extraPdfDocument(
  documentId: string,
  nombre: string,
  carpeta: string,
  bytes: Uint8Array
): RoomDocument {
  return {
    documentId,
    versionId: `${documentId}_version`,
    nombre,
    carpeta,
    tipo: 'application/pdf',
    versionNumero: 1,
    estadoPublicacion: 'PUBLISHED',
    bytes: bytes.byteLength,
    sha256: `${documentId}-sha`,
    mimeType: 'application/pdf',
    actualizadoEn: 1_700_000_000_000,
  }
}

function createFakeStore(
  options: {
    room?: Room | { code: 'DENIED' | 'NOT_FOUND' }
    extraBlobs?: Record<string, { bytes: Uint8Array; mimeType: string }>
  } = {}
): {
  store: VdrReadStore
  calls: StoreCalls
} {
  const cache = new Map<string, { pages: Array<{ n: number; text: string }>; truncated: boolean }>()
  const calls: StoreCalls = { bytesReadsFor: [], indexWrites: [], audits: 0 }

  const store: VdrReadStore = {
    resolveRoom: async () => options.room ?? ROOM,
    readVersionBytes: async ({ documentVersionId }) => {
      const extra = options.extraBlobs?.[documentVersionId]
      if (extra) {
        calls.bytesReadsFor.push(documentVersionId)
        return {
          bytes: extra.bytes,
          mimeType: extra.mimeType,
          sha256: `${documentVersionId}-sha`,
          documentId: documentVersionId.replace(/_version$/, ''),
        }
      }
      const blob = BLOBS[documentVersionId]
      // The real store answers NOT_FOUND for anything outside the room; a fake
      // that answered otherwise would hide the very bug this suite hunts.
      if (!blob) return { code: 'NOT_FOUND' }
      calls.bytesReadsFor.push(documentVersionId)
      return {
        bytes: fixture(blob.file),
        mimeType: blob.mimeType,
        sha256: `${documentVersionId}-sha`,
        documentId: `doc_${documentVersionId}`,
      }
    },
    readTextIndex: async ({ documentVersionId }) => cache.get(documentVersionId) ?? null,
    writeTextIndex: async ({ documentVersionId, pages, truncated }) => {
      calls.indexWrites.push(documentVersionId)
      cache.set(documentVersionId, { pages, truncated })
    },
    recordAudit: async () => {
      calls.audits += 1
    },
    issueUploadIntent: async () => {
      throw new Error('unreachable in this test: issueUploadIntent')
    },
    registerUpload: async () => {
      throw new Error('unreachable in this test: registerUpload')
    },
  }
  return { store, calls }
}

function createContext(store: VdrReadStore): VdrToolContext {
  return { principal: { principalId: 'user_01ABC', clientId: 'client_01ABC' }, store }
}

describe('sala_* tools', () => {
  it('sala_resumen counts folders and workbooks without reading a single blob', async () => {
    const { store, calls } = createFakeStore()
    const result = await runTool(createContext(store), 'sala_resumen', {})

    expect(result.data.documentos).toBe(4)
    expect(result.data.modelosFinancieros).toBe(1)
    expect(result.data.carpetas).toEqual([
      { carpeta: 'room_financial', documentos: 3 },
      { carpeta: 'room_marketing', documentos: 1 },
    ])
    expect(calls.bytesReadsFor).toEqual([])
  })

  it('sala_resumen matches computeRoomProgress on percent, empty folders and next step', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'sala_resumen', {})
    const progress = computeRoomProgress(
      roomProgressInputFromSala({
        phonePresent: ROOM.telefonoPresente,
        nameConfirmed: ROOM.nombreConfirmado,
        deliverables: STAGE_ORDER.map((key, index) => ({
          key,
          status: ROOM.entregables[index]?.estado ?? 'PENDING',
        })),
        conteosPorCarpeta: ROOM.conteosPorCarpeta,
        ultimoMovimiento: {
          nombre: 'Management presentation.pptx',
          at: 1_700_000_000_000,
        },
      })
    )

    expect(ROOM.sala.empresa.length).toBeGreaterThan(0)
    expect(progress.percent).toBe(20)
    expect(progress.siguientePaso).toBe('items.nameConfirmed')
    expect(result.data.avance_pct).toBe(progress.percent)
    expect(result.data.carpetas_con_documentos).toEqual([...progress.foldersWithDocuments])
    expect(result.data.carpetas_obligatorias_vacias).toEqual([...progress.emptyRequiredFolders])
    expect(result.data.carpetas_opcionales_vacias).toEqual([...progress.emptyOptionalFolders])
    expect(result.data.siguiente_paso).toBe(esMessages.roomProgress.items.nameConfirmed)
    expect(result.data.ultimo_movimiento).toEqual({
      nombre: 'Management presentation.pptx',
      fecha: new Date(1_700_000_000_000).toISOString(),
    })
  })

  it('sala_resumen uses phone and deliverable state from the room projection', async () => {
    const room: Room = {
      ...ROOM,
      telefonoPresente: true,
      nombreConfirmado: true,
      entregables: [
        { etapa: 'MODEL_V1', estado: 'PENDING' },
        { etapa: 'MODEL_V2', estado: 'PENDING' },
        { etapa: 'TEASER', estado: 'DELIVERED', publicadoEn: 1_700_000_100_000 },
        { etapa: 'CIM', estado: 'PENDING' },
        { etapa: 'MGMT_PRESENTATION', estado: 'PENDING' },
        { etapa: 'DECKS', estado: 'PENDING' },
        { etapa: 'QA', estado: 'PENDING' },
        { etapa: 'IRL', estado: 'PENDING' },
      ],
    }
    const result = await runTool(createContext(createFakeStore({ room }).store), 'sala_resumen', {})

    expect(result.data.avance_pct).toBe(60)
    expect(result.data.siguiente_paso).toBe(esMessages.roomProgress.items.legal)
    expect(result.data.entregables).toEqual(
      expect.arrayContaining([
        { nombre: esMessages.roomProgress.stages.TEASER, estado: 'DELIVERED' },
        { nombre: esMessages.roomProgress.stages.MODEL_V1, estado: 'PENDING' },
      ])
    )
  })

  it('sala_resumen counts folders from conteosPorCarpeta, not the truncated page', async () => {
    const legalPage = Array.from({ length: 200 }, (_, index) =>
      stubDocument(`doc_legal_${index}`, 'room_legal')
    )
    const room: Room = {
      ...ROOM,
      documentos: legalPage,
      truncado: true,
      nombreConfirmado: true,
      telefonoPresente: true,
      conteosPorCarpeta: { room_legal: 200, room_financial: 5, room_corporate: 1 },
      ultimoMovimiento: { nombre: 'Estados 201.xlsx', actualizadoEn: 1_800_000_000_000 },
    }
    const result = await runTool(createContext(createFakeStore({ room }).store), 'sala_resumen', {})

    expect(result.data.documentos).toBe(200)
    expect(result.data.inventarioTruncado).toBe(true)
    expect(result.data.carpetas).toEqual([
      { carpeta: 'room_corporate', documentos: 1 },
      { carpeta: 'room_financial', documentos: 5 },
      { carpeta: 'room_legal', documentos: 200 },
    ])
    expect(result.data.avance_pct).toBe(100)
    expect(result.data.carpetas_obligatorias_vacias).toEqual([])
    expect(result.data.ultimo_movimiento).toEqual({
      nombre: 'Estados 201.xlsx',
      fecha: new Date(1_800_000_000_000).toISOString(),
    })
  })

  it('sala_documentos paginates and cites every row it returns', async () => {
    const { store } = createFakeStore()
    const first = await runTool(createContext(store), 'sala_documentos', { limite: 2 })

    expect(first.data.total).toBe(4)
    expect(first.data.hayMas).toBe(true)
    expect(first.citations).toHaveLength(2)
    for (const citation of first.citations) {
      expect(decodeCitation(citation).type).toBe('document')
    }

    const second = await runTool(createContext(store), 'sala_documentos', { limite: 2, desde: 2 })
    expect(second.data.hayMas).toBe(false)
    expect((second.data.documentos as RoomDocument[]).map((row) => row.documentId)).toEqual([
      'doc_negocio',
      'doc_mgmt',
    ])
  })

  it('sala_documentos filters by folder', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'sala_documentos', {
      carpeta: '5. Materiales de mercadeo',
    })
    expect(result.data.total).toBe(1)
  })
})

describe('documento_* tools', () => {
  it('documento_buscar finds a term in the real PDF and cites its page', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'documento_buscar', {
      consulta: 'deuda financiera',
      documento_id: 'doc_eeff',
    })

    const hits = result.data.resultados as Array<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].documentId).toBe('doc_eeff')
    expect(hits[0].pagina).toBe(2)
    expect(String(hits[0].pasaje)).toContain('Deuda financiera')
    expect(decodeCitation(result.citations[0])).toMatchObject({
      type: 'excerpt',
      documentId: 'doc_eeff',
      versionId: 'version_eeff',
      page: 2,
    })
  })

  it('documento_buscar ranks by document and keeps every citation on its own hit', async () => {
    const { store } = createFakeStore()
    // Una consulta que toca varios documentos es justo donde fallaba: los
    // resultados se ordenaban por coincidencias y las citas se quedaban en el
    // orden de lectura, asi que la cita numero uno señalaba otro archivo.
    const result = await runTool(createContext(store), 'documento_buscar', {
      consulta: 'PPA',
    })

    const hits = result.data.resultados as Array<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(1)
    hits.forEach((hit, index) => {
      const citation = decodeCitation(result.citations[index])
      expect(citation).toMatchObject({
        documentId: hit.documentId,
        versionId: hit.versionId,
        page: hit.pagina,
      })
    })

    // El documento con mas coincidencias encabeza, y sus paginas van juntas.
    const ranking = result.data.documentos as Array<Record<string, unknown>>
    expect(ranking[0].documentId).toBe(hits[0].documentId)
    const documentIds = hits.map((hit) => hit.documentId)
    const grouped = documentIds.filter(
      (documentId, index) => index === 0 || documentIds[index - 1] !== documentId
    )
    expect(new Set(grouped).size, 'las paginas de un documento no se intercalan').toBe(
      grouped.length
    )
  })

  it('documento_buscar reads DOCX and PPTX too, and reuses the cached index', async () => {
    const { store, calls } = createFakeStore()
    const context = createContext(store)

    const docx = await runTool(context, 'documento_buscar', {
      consulta: 'PPA',
      documento_id: 'doc_negocio',
    })
    expect((docx.data.resultados as unknown[]).length).toBeGreaterThan(0)

    const pptx = await runTool(context, 'documento_buscar', {
      consulta: 'EBITDA',
      documento_id: 'doc_mgmt',
    })
    const pptxHits = pptx.data.resultados as Array<Record<string, unknown>>
    expect(pptxHits[0].pagina).toBe(3)

    const readsBefore = calls.bytesReadsFor.length
    await runTool(context, 'documento_buscar', { consulta: 'PPA', documento_id: 'doc_negocio' })
    expect(calls.bytesReadsFor.length, 'the second search hits the index, not storage').toBe(
      readsBefore
    )
  })

  it('documento_buscar omite el PDF protegido y el escaneo y devuelve el legible (o5-04-5)', async () => {
    const protegidoBytes = buildPasswordProtectedPdf()
    const escaneoBytes = buildScannedPdf({ mark: 'scan0001 o5-04-5' })
    const protegido = extraPdfDocument(
      'doc_protegido',
      'estados financieros FINAL FINAL.pdf',
      '3. Financieros',
      protegidoBytes
    )
    const escaneo = extraPdfDocument('doc_escaneo', 'scan0001.pdf', '2. Operaciones', escaneoBytes)
    const legible = document(
      'doc_eeff',
      'version_eeff',
      'EEFF auditados FY24.pdf',
      '3. Financieros'
    )
    const room: Room = {
      ...ROOM,
      documentos: [protegido, escaneo, legible],
      conteosPorCarpeta: { room_financial: 2, room_operations: 1 },
    }
    const result = await runTool(
      createContext(
        createFakeStore({
          room,
          extraBlobs: {
            [protegido.versionId]: { bytes: protegidoBytes, mimeType: 'application/pdf' },
            [escaneo.versionId]: { bytes: escaneoBytes, mimeType: 'application/pdf' },
          },
        }).store
      ),
      'documento_buscar',
      { consulta: 'deuda financiera' }
    )

    const hits = result.data.resultados as Array<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.documentId === 'doc_eeff')).toBe(true)
    expect(result.data.documentosRevisados).toBe(1)
    expect(result.data.omitidos).toEqual([
      {
        documentId: 'doc_protegido',
        nombre: 'estados financieros FINAL FINAL.pdf',
        motivo: 'protegido',
      },
      { documentId: 'doc_escaneo', nombre: 'scan0001.pdf', motivo: 'sin texto' },
    ])
  })

  it('documento_buscar sigue respondiendo FORMATO_NO_SOPORTADO si ningún documento es legible (o5-04-5)', async () => {
    const protegidoBytes = buildPasswordProtectedPdf()
    const escaneoBytes = buildScannedPdf({ mark: 'scan-sin-legible o5-04-5' })
    const protegido = extraPdfDocument(
      'doc_protegido',
      'estados financieros FINAL FINAL.pdf',
      '3. Financieros',
      protegidoBytes
    )
    const escaneo = extraPdfDocument('doc_escaneo', 'scan0001.pdf', '2. Operaciones', escaneoBytes)
    const room: Room = {
      ...ROOM,
      documentos: [protegido, escaneo],
      conteosPorCarpeta: { room_financial: 1, room_operations: 1 },
    }

    await expect(
      runTool(
        createContext(
          createFakeStore({
            room,
            extraBlobs: {
              [protegido.versionId]: { bytes: protegidoBytes, mimeType: 'application/pdf' },
              [escaneo.versionId]: { bytes: escaneoBytes, mimeType: 'application/pdf' },
            },
          }).store
        ),
        'documento_buscar',
        { consulta: 'deuda financiera' }
      )
    ).rejects.toMatchObject({ code: 'FORMATO_NO_SOPORTADO' })
  })

  it('documento_buscar omite el archivo que pasa el tope de extracción como demasiado grande (o5-04-5)', async () => {
    const grandeBytes = new Uint8Array(EXTRACT_MAX_BYTES + 1)
    const grande = extraPdfDocument(
      'doc_grande',
      'estados financieros 2014-2024.pdf',
      '3. Financieros',
      grandeBytes
    )
    const legible = document(
      'doc_eeff',
      'version_eeff',
      'EEFF auditados FY24.pdf',
      '3. Financieros'
    )
    const room: Room = {
      ...ROOM,
      documentos: [grande, legible],
      conteosPorCarpeta: { room_financial: 2 },
    }
    const result = await runTool(
      createContext(
        createFakeStore({
          room,
          extraBlobs: {
            [grande.versionId]: { bytes: grandeBytes, mimeType: 'application/pdf' },
          },
        }).store
      ),
      'documento_buscar',
      { consulta: 'deuda financiera' }
    )

    const hits = result.data.resultados as Array<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.documentId === 'doc_eeff')).toBe(true)
    expect(result.data.documentosRevisados).toBe(1)
    expect(result.data.omitidos).toEqual([
      {
        documentId: 'doc_grande',
        nombre: 'estados financieros 2014-2024.pdf',
        motivo: 'demasiado grande',
      },
    ])
  })

  it('documento_fragmento never returns more than 2000 characters', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'documento_fragmento', {
      documento_id: 'doc_eeff',
      pagina: 1,
    })
    expect(String(result.data.texto).length).toBeLessThanOrEqual(2_000)
    expect(result.data.pagina).toBe(1)
    expect(decodeCitation(result.citations[0])).toMatchObject({ type: 'excerpt', page: 1 })
  })

  it('documento_fragmento rejects a page the document does not have, with a range', async () => {
    const { store } = createFakeStore()
    await expect(
      runTool(createContext(store), 'documento_fragmento', {
        documento_id: 'doc_eeff',
        pagina: 99,
      })
    ).rejects.toMatchObject({ code: 'ARGUMENTO_INVALIDO' })
  })

  it('answers a uniform NOT_FOUND for a document that is not in this room', async () => {
    const { store } = createFakeStore()
    await expect(
      runTool(createContext(store), 'documento_fragmento', { documento_id: 'doc_de_otra_empresa' })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'El documento solicitado no existe en esta sala.',
    })
  })
})

describe('modelo_* tools', () => {
  it('modelo_hojas lists the real sheets of the workbook', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'modelo_hojas', {})
    expect(result.data.hojas).toEqual(['Supuestos', 'Estado de Resultados', 'Deuda', 'Resumen'])
    expect(decodeCitation(result.citations[0])).toMatchObject({
      type: 'document',
      documentId: 'doc_modelo',
    })
  })

  it('modelo_resumen describes one sheet and cites its used range', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'modelo_resumen', {
      hoja: 'Estado de Resultados',
    })
    expect(String(result.data.resumen)).toContain('Estado de Resultados')
    expect(decodeCitation(result.citations[0])).toMatchObject({
      type: 'cell',
      sheet: 'Estado de Resultados',
    })
  })

  // Un cliente MCP reusa UN contexto por pregunta y despacha varias
  // herramientas seguidas. Sin memo, cada herramienta de modelo se volvia a
  // bajar el libro entero de Convex: cinco herramientas por pregunta eran cinco
  // descargas del mismo blob, cobradas como egress de archivos.
  it('varias herramientas de modelo sobre un contexto bajan el libro una sola vez', async () => {
    const { store, calls } = createFakeStore()
    const context = createContext(store)

    await runTool(context, 'modelo_hojas', {})
    await runTool(context, 'modelo_resumen', { hoja: 'Estado de Resultados' })
    await runTool(context, 'modelo_rango', { hoja: 'Estado de Resultados', rango: 'A3:E6' })

    expect(calls.bytesReadsFor).toEqual(['version_modelo'])
  })

  // Un contexto nuevo es una peticion nueva: el memo no cruza peticiones, para
  // que una version publicada entre dos preguntas se vea en la siguiente.
  it('un contexto nuevo vuelve a bajar el libro', async () => {
    const { store, calls } = createFakeStore()
    await runTool(createContext(store), 'modelo_hojas', {})
    await runTool(createContext(store), 'modelo_hojas', {})
    expect(calls.bytesReadsFor).toHaveLength(2)
  })

  it('modelo_rango returns real values and formulas inside the cell budget', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'modelo_rango', {
      hoja: 'Estado de Resultados',
      rango: 'A3:E6',
    })
    const cells = result.data.celdas as Array<{ celda: string; valor: unknown; formula: unknown }>
    expect(cells).toHaveLength(20)
    expect(cells.find((cell) => cell.celda === 'D3')?.valor).toBe(6740)
    expect(cells.find((cell) => cell.celda === 'D6')?.formula).toBe('=D3+D4+D5')
    expect(decodeCitation(result.citations[0])).toMatchObject({
      type: 'cell',
      sheet: 'Estado de Resultados',
      range: 'A3:E6',
    })
  })

  it('modelo_formula separates a computed cell from an input cell', async () => {
    const { store } = createFakeStore()
    const computed = await runTool(createContext(store), 'modelo_formula', {
      hoja: 'Estado de Resultados',
      celda: 'D6',
    })
    expect(computed.data.valor).toBe(4623)
    expect(computed.data.formula).toBe('=D3+D4+D5')
    expect(computed.data.esInput).toBe(false)

    const input = await runTool(createContext(store), 'modelo_formula', {
      hoja: 'Supuestos',
      celda: 'B4',
    })
    expect(input.data.valor).toBe(42.5)
    expect(input.data.esInput).toBe(true)
  })

  it('refuses a range above the per-call cell budget with a corrective suggestion', async () => {
    const { store } = createFakeStore()
    await expect(
      runTool(createContext(store), 'modelo_rango', { hoja: 'Supuestos', rango: 'A1:Z100' })
    ).rejects.toMatchObject({ code: 'RANGO_DEMASIADO_GRANDE' })

    const error = await runTool(createContext(store), 'modelo_rango', {
      hoja: 'Supuestos',
      rango: 'A1:Z100',
    }).catch((cause: VdrToolError) => cause)
    expect((error as VdrToolError).message).toContain(String(MODEL_MAX_CELLS_PER_CALL))
  })

  it('refuses an unknown sheet and lists the real ones', async () => {
    const { store } = createFakeStore()
    const error = await runTool(createContext(store), 'modelo_resumen', {
      hoja: 'Flujo de caja',
    }).catch((cause: VdrToolError) => cause)

    expect((error as VdrToolError).code).toBe('HOJA_DESCONOCIDA')
    expect((error as VdrToolError).opciones).toEqual([
      'Supuestos',
      'Estado de Resultados',
      'Deuda',
      'Resumen',
    ])
  })

  it('refuses a malformed range instead of guessing', async () => {
    const { store } = createFakeStore()
    await expect(
      runTool(createContext(store), 'modelo_rango', { hoja: 'Supuestos', rango: 'no-es-un-rango' })
    ).rejects.toMatchObject({ code: 'RANGO_INVALIDO' })
  })

  it('refuses to treat a PDF as a workbook', async () => {
    const { store } = createFakeStore()
    await expect(
      runTool(createContext(store), 'modelo_hojas', { documento_id: 'doc_eeff' })
    ).rejects.toMatchObject({ code: 'FORMATO_NO_SOPORTADO' })
  })
})

describe('modelo_metrica_canonica', () => {
  it('lists the defined names of the workbook when called without a metric', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'modelo_metrica_canonica', {})
    const metrics = result.data.metricas as Array<{ metrica: string; origen: string }>
    expect(metrics.map((metric) => metric.metrica).sort()).toEqual([
      'CAPACIDAD_MW',
      'DSCR_min',
      'EBITDA_FY24',
      'TARIFA_PPA',
    ])
    expect(metrics.every((metric) => metric.origen === 'NOMBRE')).toBe(true)
  })

  it('resolves a defined name to its real cell and cites it', async () => {
    const { store } = createFakeStore()
    const result = await runTool(createContext(store), 'modelo_metrica_canonica', {
      metrica: 'EBITDA_FY24',
    })
    expect(result.data.hoja).toBe('Estado de Resultados')
    expect(result.data.rango).toBe('D6')
    expect((result.data.celdas as Array<{ valor: unknown }>)[0].valor).toBe(4623)
    expect(decodeCitation(result.citations[0])).toMatchObject({
      type: 'cell',
      sheet: 'Estado de Resultados',
      range: 'D6',
    })
  })

  it('answers a clean NOT_FOUND with the available metrics', async () => {
    const { store } = createFakeStore()
    const error = await runTool(createContext(store), 'modelo_metrica_canonica', {
      metrica: 'flujo_libre',
    }).catch((cause: VdrToolError) => cause)

    expect((error as VdrToolError).code).toBe('METRICA_DESCONOCIDA')
    expect((error as VdrToolError).opciones).toContain('EBITDA_FY24')
  })
})

describe('room binding', () => {
  it('collapses a denied binding into the uniform NOT_FOUND', async () => {
    const { store } = createFakeStore({ room: { code: 'DENIED' } })
    await expect(runTool(createContext(store), 'sala_resumen', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No hay una sala de datos disponible para esta sesión.',
    })
  })

  it('forwards sala_id to the server, never to the tool logic', async () => {
    const { store } = createFakeStore()
    const spy = vi.spyOn(store, 'resolveRoom')
    await runTool(createContext(store), 'sala_resumen', { sala_id: 'company_otra' })
    expect(spy).toHaveBeenCalledWith({
      principalId: 'user_01ABC',
      salaId: 'company_otra',
    })
  })

  // La sala es una por empresa: el scope de transacción salió del árbol
  // ([F] 2026-09-17). Un cliente viejo que todavía lo mande recibe un
  // argumento inválido, no un scope silenciosamente ignorado.
  it('rejects the retired transaction scope argument', async () => {
    const { store } = createFakeStore()
    const error = await runTool(createContext(store), 'sala_resumen', {
      sala_id: 'company_otra',
      transaccion_id: 'deal_otro',
    }).catch((cause: VdrToolError) => cause)
    expect((error as VdrToolError).code).toBe('ARGUMENTO_INVALIDO')
  })

  it('rejects an unknown tool name with the list of real tools', async () => {
    const { store } = createFakeStore()
    const error = await runTool(createContext(store), 'prepare_financial_model', {}).catch(
      (cause: VdrToolError) => cause
    )
    expect((error as VdrToolError).code).toBe('ARGUMENTO_INVALIDO')
    expect((error as VdrToolError).opciones).toContain('sala_resumen')
    expect((error as VdrToolError).opciones).not.toContain('prepare_financial_model')
    expect((error as VdrToolError).opciones).toContain('documento_subir')
  })
})

describe('documento_subir y documento_confirmar', () => {
  it('publica el mismo techo de tamano_bytes que la lectura', () => {
    const doc = toolInputSchemas.documento_subir['~standard'].jsonSchema.input({
      target: 'draft-07',
    }) as {
      properties?: { tamano_bytes?: { maximum?: number; description?: string } }
    }
    const tamano = doc.properties?.tamano_bytes

    expect(tamano?.maximum).toBe(VDR_MCP_READ_MAX_BYTES)
    expect(tamano?.description).toContain(`${VDR_MCP_READ_MAX_BYTES / (1024 * 1024)} MB`)
  })

  it('emite upload_url e intent_id contra el store', async () => {
    const issueUploadIntent = vi.fn(async () => ({
      intentId: 'intent_1',
      uploadUrl: 'https://storage.example/upload-once',
      expiresAt: 1_700_000_600_000,
    }))
    const store = { ...createFakeStore().store, issueUploadIntent }

    const result = await runTool(createContext(store), 'documento_subir', {
      carpeta: 'room_legal',
      nombre: 'acta.pdf',
      mime: 'application/pdf',
      tamano_bytes: 1024,
      nota: 'subida por MCP',
    })

    expect(issueUploadIntent).toHaveBeenCalledWith({
      principalId: 'user_01ABC',
      carpeta: 'room_legal',
      nombre: 'acta.pdf',
      mime: 'application/pdf',
      tamanoBytes: 1024,
      nota: 'subida por MCP',
    })
    expect(result.data).toEqual({
      upload_url: 'https://storage.example/upload-once',
      storage_id_placeholder: 'pendiente_del_POST',
      intent_id: 'intent_1',
      expira_en: new Date(1_700_000_600_000).toISOString(),
      instrucciones: expect.stringContaining('POST'),
    })
  })

  it('rechaza un mime fuera de la allowlist antes de hablar con Convex', async () => {
    const issueUploadIntent = vi.fn()
    const store = { ...createFakeStore().store, issueUploadIntent }
    const error = await runTool(createContext(store), 'documento_subir', {
      carpeta: 'room_legal',
      nombre: 'foto.png',
      mime: 'image/png',
      tamano_bytes: 1024,
    }).catch((cause: VdrToolError) => cause)

    expect((error as VdrToolError).code).toBe('ARGUMENTO_INVALIDO')
    expect(issueUploadIntent).not.toHaveBeenCalled()
  })

  it('acepta un archivo del tamaño exacto del techo de lectura', async () => {
    const issueUploadIntent = vi.fn(async () => ({
      intentId: 'intent_max',
      uploadUrl: 'https://storage.example/upload-once',
      expiresAt: 1_700_000_600_000,
    }))
    const store = { ...createFakeStore().store, issueUploadIntent }

    const result = await runTool(createContext(store), 'documento_subir', {
      carpeta: 'room_legal',
      nombre: 'acta.pdf',
      mime: 'application/pdf',
      tamano_bytes: VDR_MCP_READ_MAX_BYTES,
    })

    expect(issueUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ tamanoBytes: VDR_MCP_READ_MAX_BYTES })
    )
    expect(result.data.intent_id).toBe('intent_max')
  })

  it('rechaza un PDF por encima del techo de lectura en el schema', async () => {
    const issueUploadIntent = vi.fn()
    const store = { ...createFakeStore().store, issueUploadIntent }
    const error = await runTool(createContext(store), 'documento_subir', {
      carpeta: 'room_legal',
      nombre: 'acta.pdf',
      mime: 'application/pdf',
      tamano_bytes: VDR_READ_MAX_BYTES + 1,
    }).catch((cause: VdrToolError) => cause)

    expect((error as VdrToolError).code).toBe('ARGUMENTO_INVALIDO')
    expect(issueUploadIntent).not.toHaveBeenCalled()
  })

  it('rechaza un CSV por encima del techo de lectura en el schema', async () => {
    const issueUploadIntent = vi.fn()
    const store = { ...createFakeStore().store, issueUploadIntent }
    const error = await runTool(createContext(store), 'documento_subir', {
      carpeta: 'room_financial',
      nombre: 'tape.csv',
      mime: 'text/csv',
      tamano_bytes: VDR_READ_MAX_BYTES + 1,
    }).catch((cause: VdrToolError) => cause)

    expect((error as VdrToolError).code).toBe('ARGUMENTO_INVALIDO')
    expect(issueUploadIntent).not.toHaveBeenCalled()
  })

  it('colapsa un dueño ajeno a NOT_FOUND', async () => {
    const store = {
      ...createFakeStore().store,
      issueUploadIntent: async () => ({ code: 'NOT_FOUND' as const }),
    }
    await expect(
      runTool(createContext(store), 'documento_subir', {
        carpeta: 'room_legal',
        nombre: 'acta.pdf',
        mime: 'application/pdf',
        tamano_bytes: 1024,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('registra el blob con intent_id y storage_id', async () => {
    const registerUpload = vi.fn(async () => ({
      documentId: 'document_1',
      versionId: 'version_1',
      versionNumero: 1,
      nombre: 'acta.pdf',
      carpeta: 'room_legal',
    }))
    const store = { ...createFakeStore().store, registerUpload }

    const result = await runTool(createContext(store), 'documento_confirmar', {
      intent_id: 'intent_1',
      storage_id: 'storage_1',
    })

    expect(registerUpload).toHaveBeenCalledWith({
      principalId: 'user_01ABC',
      intentId: 'intent_1',
      storageId: 'storage_1',
    })
    expect(result.data).toEqual({
      document_id: 'document_1',
      version_id: 'version_1',
      version_numero: 1,
      nombre: 'acta.pdf',
      carpeta: 'room_legal',
    })
  })
})
