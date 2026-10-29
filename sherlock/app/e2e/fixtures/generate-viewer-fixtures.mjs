// ============================================================================
// FIXTURES SINTETICOS DEL VISOR DEL VDR
// ============================================================================
// Genera los archivos que consume `e2e/vdr-viewers.spec.ts` y los tests
// unitarios del conversor PPTX -> PDF. Empresa ficticia: Andina Solar, S. A.
// (Panama, proceso de credito). NUNCA se usan datos de clientes reales.
//
//   bun --cwd=sherlock/app run node e2e/fixtures/generate-viewer-fixtures.mjs
//
// Los archivos quedan versionados: este script existe para poder regenerarlos
// y para que se vea de que estan hechos, no para correr en CI.
// ============================================================================

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deflateSync } from 'node:zlib'

import JSZip from 'jszip'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const COMPANY = 'Andina Solar, S. A.'

function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`
}

function escape(value) {
  return String(value).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])
}

// ===== XLSX =====================================================================
// Dos hojas con valores literales (sin sharedStrings, sin formulas): suficiente
// para que Mog abra el libro y para probar la navegacion Hoja!Rango.
const SHEETS = [
  {
    name: 'Supuestos',
    rows: [
      ['Concepto', 'FY24', 'FY25'],
      ['Capacidad instalada (MW)', 42, 58],
      ['Factor de planta', 0.27, 0.28],
      ['Tarifa PPA (USD/MWh)', 78.5, 79.25],
    ],
  },
  {
    name: 'Flujo',
    rows: [
      ['Concepto', 'FY24', 'FY25'],
      ['Ingresos', 24_180_000, 33_940_000],
      ['EBITDA', 17_460_000, 24_610_000],
      ['Servicio de deuda', 9_120_000, 12_300_000],
    ],
  },
]

function columnName(index) {
  let name = ''
  let value = index
  do {
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return name
}

function sheetXml(rows) {
  const body = rows
    .map((cells, rowIndex) => {
      const cellXml = cells
        .map((cell, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`
          return typeof cell === 'number'
            ? `<c r="${reference}"><v>${cell}</v></c>`
            : `<c r="${reference}" t="inlineStr"><is><t>${escape(cell)}</t></is></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cellXml}</row>`
    })
    .join('')

  return xml(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  )
}

async function buildXlsx() {
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        SHEETS.map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        ).join('') +
        `</Types>`
    )
  )

  zip.file(
    '_rels/.rels',
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`
    )
  )

  zip.file(
    'xl/workbook.xml',
    xml(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        SHEETS.map(
          (sheet, index) =>
            `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        ).join('') +
        `</sheets></workbook>`
    )
  )

  zip.file(
    'xl/_rels/workbook.xml.rels',
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        SHEETS.map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
        ).join('') +
        `</Relationships>`
    )
  )

  for (const [index, sheet] of SHEETS.entries()) {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows))
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ===== DOCX =====================================================================
const DOCX_PARAGRAPHS = [
  `${COMPANY} — Modelo de negocio`,
  'Andina Solar opera cuatro parques fotovoltaicos en Panama con contratos PPA a quince anios.',
  'El proceso de credito busca refinanciar la deuda puente del parque Chiriqui II.',
  'Este documento es una ficcion de prueba: no describe ninguna empresa real.',
]

async function buildDocx() {
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`
    )
  )

  zip.file(
    '_rels/.rels',
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    )
  )

  zip.file(
    'word/document.xml',
    xml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        DOCX_PARAGRAPHS.map(
          (text) => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`
        ).join('') +
        `</w:body></w:document>`
    )
  )

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ===== PPTX =====================================================================
const SLIDES = [
  [`${COMPANY}`, 'Presentacion de gerencia — proceso de credito'],
  ['Portafolio', '4 parques · 42 MW instalados · PPA a 15 anios'],
  ['Uso de fondos', 'Refinanciar la deuda puente de Chiriqui II'],
]

async function buildPptx() {
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
        SLIDES.map(
          (_, index) =>
            `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        ).join('') +
        `</Types>`
    )
  )

  zip.file(
    '_rels/.rels',
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
        `</Relationships>`
    )
  )

  zip.file(
    'ppt/presentation.xml',
    xml(
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<p:sldIdLst>` +
        SLIDES.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('') +
        `</p:sldIdLst>` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `</p:presentation>`
    )
  )

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        SLIDES.map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
        ).join('') +
        `</Relationships>`
    )
  )

  for (const [index, [title, body]] of SLIDES.entries()) {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      xml(
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
          `<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${escape(title)}</a:t></a:r></a:p></p:txBody></p:sp>` +
          `<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${escape(body)}</a:t></a:r></a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:sld>`
      )
    )
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ===== PDF ======================================================================
// PDF 1.4 minimo escrito a mano: una pagina con texto Helvetica. Evita sumar una
// libreria de generacion solo para un fixture.
function buildPdf() {
  const lines = [
    `(${COMPANY}) Tj`,
    'T*',
    '(Estados financieros FY24 - documento sintetico de prueba) Tj',
    'T*',
    '(Ingresos: USD 24,180,000   EBITDA: USD 17,460,000) Tj',
  ]
  const content = `BT /F1 16 Tf 54 700 Td 22 TL\n${lines.join('\n')}\nET\n`

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

// ===== PNG ======================================================================
// PNG 8x8 de un color plano, escrito a mano (IHDR + IDAT + IEND).
function buildPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })

  function crc32(buffer) {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  function chunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }

  const size = 8
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor

  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.concat(Array.from({ length: size }, () => Buffer.from([0x1f, 0x3a, 0x5c]))),
      ])
    )
  )

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const files = {
  'andina-solar-modelo.xlsx': await buildXlsx(),
  'andina-solar-negocio.docx': await buildDocx(),
  'andina-solar-gerencia.pptx': await buildPptx(),
  'andina-solar-eeff.pdf': buildPdf(),
  'andina-solar-parque.png': buildPng(),
}

for (const [name, contents] of Object.entries(files)) {
  writeFileSync(join(OUT_DIR, name), contents)
  console.log(`${name} — ${contents.length} bytes`)
}
