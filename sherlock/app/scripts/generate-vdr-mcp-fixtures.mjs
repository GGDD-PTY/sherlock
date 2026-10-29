#!/usr/bin/env node
/**
 * Generate the synthetic VDR read-MCP fixtures.
 *
 * Fictional issuer: "Andina Solar, S. A." (Panamá, proceso de crédito). Every
 * number here is invented — no client data ever enters this tree.
 *
 * Run from the repo root:
 *   bun --cwd=sherlock/app run fixtures:vdr-mcp
 *
 * The workbook needs the MOG 1.0 CLI at ~/.local/bin/mog (override with
 * MOG_BIN). The PDF, DOCX and PPTX are written here with no dependency.
 */
import { execFileSync } from 'node:child_process'
import { deflateRawSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', '__tests__', 'fixtures', 'vdr-mcp')

// ===== minimal ZIP writer (store + deflate), enough for OOXML packages =====

function zipEntry(name, contents) {
  const raw = Buffer.from(contents, 'utf8')
  const deflated = deflateRawSync(raw)
  const useDeflate = deflated.length < raw.length
  return {
    name: Buffer.from(name, 'utf8'),
    crc: crc32(raw) >>> 0,
    rawSize: raw.length,
    method: useDeflate ? 8 : 0,
    payload: useDeflate ? deflated : raw,
  }
}

function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.payload.length, 18)
    header.writeUInt32LE(entry.rawSize, 22)
    header.writeUInt16LE(entry.name.length, 26)
    header.writeUInt16LE(0, 28)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8)
    directory.writeUInt16LE(entry.method, 10)
    directory.writeUInt16LE(0, 12)
    directory.writeUInt16LE(0, 14)
    directory.writeUInt32LE(entry.crc, 16)
    directory.writeUInt32LE(entry.payload.length, 20)
    directory.writeUInt32LE(entry.rawSize, 24)
    directory.writeUInt16LE(entry.name.length, 28)
    directory.writeUInt16LE(0, 30)
    directory.writeUInt16LE(0, 32)
    directory.writeUInt16LE(0, 34)
    directory.writeUInt16LE(0, 36)
    directory.writeUInt32LE(0, 38)
    directory.writeUInt32LE(offset, 42)

    locals.push(header, entry.name, entry.payload)
    central.push(directory, entry.name)
    offset += header.length + entry.name.length + entry.payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, end])
}

// ===== XLSX: el modelo financiero, escrito por el CLI de MOG 1.0 =====
//
// El libro lo arma el binario oficial `mog` (Office.js), no el SDK npm 0.10.x.
// Cada fila se escribe en un rango de su ancho exacto: MOG 1.0 exige que la
// matriz mida lo mismo que el rango, y así las celdas vacías quedan vacías.
// Ningún texto empieza con `-` o `+` (MOG 1.0 los vuelve fórmula).

const MOG_BIN = process.env.MOG_BIN || join(homedir(), '.local', 'bin', 'mog')

const MODEL = {
  sheets: [
    {
      name: 'Supuestos',
      rows: [
        ['Andina Solar, S. A. — Modelo financiero (sintético)'],
        ['Proceso', 'Crédito senior'],
        ['Moneda', 'USD'],
        ['Capacidad instalada (MW)', 42.5],
        ['Factor de planta', 0.238],
        ['Tarifa PPA (USD/MWh)', 78.4],
        ['Horas por año', 8760],
        ['Generación anual (MWh)', '=C4*C7*C5'],
      ],
    },
    {
      name: 'Estado de Resultados',
      rows: [
        ['Estado de Resultados (USD miles)'],
        ['Concepto', 'FY22', 'FY23', 'FY24', 'FY25E'],
        ['Ingresos', 5120, 5980, 6740, 7180],
        ['Costos de operación', -1210, -1320, -1405, -1460],
        ['Gastos administrativos', -640, -690, -712, -735],
        ['EBITDA', '=B3+B4+B5', '=C3+C4+C5', '=D3+D4+D5', '=E3+E4+E5'],
        ['Margen EBITDA', '=B6/B3', '=C6/C3', '=D6/D3', '=E6/E3'],
      ],
    },
    {
      name: 'Deuda',
      rows: [
        ['Servicio de deuda (USD miles)'],
        ['Concepto', 'FY22', 'FY23', 'FY24', 'FY25E'],
        ['Saldo inicial', 24000, 22200, 20400, 18600],
        ['Amortización', -1800, -1800, -1800, -1800],
        ['Intereses', -1680, -1554, -1428, -1302],
        ['Servicio total', '=B4+B5', '=C4+C5', '=D4+D5', '=E4+E5'],
        [
          'DSCR',
          "='Estado de Resultados'!B6/-B6",
          "='Estado de Resultados'!C6/-C6",
          "='Estado de Resultados'!D6/-D6",
          "='Estado de Resultados'!E6/-E6",
        ],
        ['DSCR mínimo', '=MIN(B7:E7)'],
      ],
    },
    {
      name: 'Resumen',
      rows: [
        ['Resumen ejecutivo'],
        ['Métrica', 'Valor'],
        ['Capacidad instalada (MW)', 42.5],
        ['Ingresos FY24 (USD miles)', 6740],
        ['EBITDA FY24 (USD miles)', "='Estado de Resultados'!D6"],
        ['Deuda neta FY24 (USD miles)', 20400],
        ['Tarifa PPA (USD/MWh)', 78.4],
      ],
    },
  ],
  names: [
    ['EBITDA_FY24', "='Estado de Resultados'!$D$6"],
    ['DSCR_min', '=Deuda!$B$8'],
    ['CAPACIDAD_MW', '=Supuestos!$B$4'],
    ['TARIFA_PPA', '=Supuestos!$B$6'],
  ],
}

const MODEL_SCRIPT = `const MODEL = ${JSON.stringify(MODEL)};
await Excel.run(async (context) => {
  const worksheets = context.workbook.worksheets;
  worksheets.load("items/name");
  await context.sync();
  MODEL.sheets.forEach((spec, index) => {
    const sheet = index === 0 ? worksheets.items[0] : worksheets.add(spec.name);
    if (index === 0) sheet.name = spec.name;
    spec.rows.forEach((row, rowIndex) => {
      const last = String.fromCharCode(64 + row.length);
      sheet.getRange("A" + (rowIndex + 1) + ":" + last + (rowIndex + 1)).formulas = [row];
    });
  });
  MODEL.names.forEach(([name, reference]) => context.workbook.names.add(name, reference));
  await context.sync();
});
`

function buildModel(target) {
  execFileSync(MOG_BIN, ['-o', target, '-e', MODEL_SCRIPT], { stdio: 'inherit' })
}

// ===== PDF: EEFF sintéticos, un PDF mínimo escrito a mano =====

function buildPdf(pages) {
  const objects = []
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  pages.forEach((lines, index) => {
    const contentId = 5 + index * 2
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    )
    const text = lines
      .map(
        (line, lineIndex) =>
          `BT /F1 12 Tf 62 ${720 - lineIndex * 20} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`
      )
      .join('\n')
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`)
  })

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// ===== DOCX / PPTX mínimos =====

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) =>
    char === '<'
      ? '&lt;'
      : char === '>'
        ? '&gt;'
        : char === '&'
          ? '&amp;'
          : char === "'"
            ? '&apos;'
            : '&quot;'
  )
}

function buildDocx(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('')
  return buildZip([
    zipEntry(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    ),
    zipEntry(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ),
    zipEntry(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    ),
  ])
}

function buildPptx(slides) {
  const entries = [
    zipEntry(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides
        .map(
          (_, index) =>
            `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        )
        .join('')}</Types>`
    ),
    zipEntry(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
    ),
    zipEntry(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
    ),
  ]

  slides.forEach((lines, index) => {
    const shapes = lines
      .map(
        (line) =>
          `<p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p></p:txBody></p:sp>`
      )
      .join('')
    entries.push(
      zipEntry(
        `ppt/slides/slide${index + 1}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`
      )
    )
  })

  return buildZip(entries)
}

// ===== main =====

mkdirSync(OUT, { recursive: true })

buildModel(join(OUT, 'andina-solar-modelo.xlsx'))

writeFileSync(
  join(OUT, 'andina-solar-eeff-fy24.pdf'),
  buildPdf([
    [
      'Andina Solar, S. A.',
      'Estados financieros auditados FY24 (sinteticos)',
      'Ingresos: USD 6,740 miles',
      'EBITDA: USD 4,623 miles',
    ],
    [
      'Notas a los estados financieros',
      'Nota 3 - Deuda financiera',
      'Saldo al cierre FY24: USD 20,400 miles',
      'Tasa promedio ponderada: 7.0 por ciento',
    ],
  ])
)

writeFileSync(
  join(OUT, 'andina-solar-negocio.docx'),
  buildDocx([
    'Andina Solar, S. A. — Modelo de negocio',
    'Andina Solar opera un parque solar fotovoltaico de 42.5 MW en la provincia de Coclé, Panamá.',
    'La generación se vende bajo un contrato PPA a 15 años con una tarifa de USD 78.40 por MWh.',
    'El proceso en curso busca financiamiento senior por USD 24 millones con garantía sobre los activos.',
  ])
)

writeFileSync(
  join(OUT, 'andina-solar-mgmt.pptx'),
  buildPptx([
    ['Andina Solar, S. A.', 'Management presentation (sintética)'],
    ['Activo', '42.5 MW en Coclé, Panamá', 'PPA a 15 años'],
    ['Financieros FY24', 'Ingresos USD 6,740 miles', 'EBITDA USD 4,623 miles'],
  ])
)

console.log(`fixtures escritos en ${OUT}`)
