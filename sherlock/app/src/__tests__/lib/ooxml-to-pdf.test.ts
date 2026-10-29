import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RenditionError,
  convertDocxToPdf,
  convertOoxmlToPdf,
  convertPptxToPdf,
  toWinAnsiSafeText,
} from '@/lib/documents/renditions/ooxml-to-pdf'
import { findDescendants, parseXml } from '@/lib/documents/renditions/xml'

const FIXTURES = join(process.cwd(), 'e2e', 'fixtures')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

/**
 * pdf-lib comprime los content streams con Flate y escribe el texto dibujado
 * como cadenas hexadecimales (`<...> Tj`). Para probar que el contenido se
 * renderizo — y no solo que salio un PDF — hay que inflar y decodificar.
 */
function drawnText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1')
  const streams = /\/FlateDecode[\s\S]*?stream\r?\n([\s\S]*?)\r?\nendstream/g
  let drawn = ''

  let stream = streams.exec(raw)
  while (stream) {
    let content = ''
    try {
      content = inflateSync(Buffer.from(stream[1], 'latin1')).toString('latin1')
    } catch {
      // Streams que no inflan (xref, fuentes) no traen texto dibujado.
    }

    const shows = /<([0-9A-Fa-f]+)>\s*Tj/g
    let show = shows.exec(content)
    while (show) {
      drawn += `${Buffer.from(show[1], 'hex').toString('latin1')}\n`
      show = shows.exec(content)
    }

    stream = streams.exec(raw)
  }
  return drawn
}

async function pageSizes(pdf: Uint8Array): Promise<Array<[number, number]>> {
  const document = await PDFDocument.load(pdf)
  return document.getPages().map((page) => [page.getWidth(), page.getHeight()])
}

describe('parseXml', () => {
  it('reads nested elements, attributes and entities without regex fragility', () => {
    const root = parseXml(
      '<?xml version="1.0"?><p:sld xmlns:p="x"><p:sp a="1 &gt; 0"><a:t>Andina &amp; Solar</a:t></p:sp></p:sld>'
    )

    expect(root?.name).toBe('p:sld')
    const runs = findDescendants(root!, 'a:t')
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toBe('Andina & Solar')
    expect(findDescendants(root!, 'p:sp')[0].attributes.a).toBe('1 > 0')
  })

  it('skips comments, CDATA markers and declarations', () => {
    const root = parseXml('<a><!-- nota --><b><![CDATA[<script>]]></b></a>')
    expect(root?.children[0].text).toBe('<script>')
  })

  it('returns null for a document without a root element', () => {
    expect(parseXml('<?xml version="1.0"?>')).toBeNull()
  })
})

describe('toWinAnsiSafeText', () => {
  it('degrades typographic characters the standard PDF fonts cannot encode', () => {
    expect(toWinAnsiSafeText('4 parques · 42 MW — “Andina” … →')).toBe(
      '4 parques - 42 MW - "Andina" ... ->'
    )
  })

  it('keeps Latin-1 accents used by Panamanian Spanish copy', () => {
    expect(toWinAnsiSafeText('Presentación de gerencia — Chiriquí')).toBe(
      'Presentación de gerencia - Chiriquí'
    )
  })

  it('replaces characters outside WinAnsi instead of throwing later in pdf-lib', () => {
    expect(toWinAnsiSafeText('modelo 📈 listo')).toBe('modelo   listo')
  })
})

describe('convertPptxToPdf', () => {
  it('renders one page per slide, in presentation order, with the slide text', async () => {
    const pdf = await convertPptxToPdf(fixture('andina-solar-gerencia.pptx'))
    const text = drawnText(pdf)

    expect(await pageSizes(pdf)).toHaveLength(3)
    expect(text).toContain('Andina Solar, S. A.')
    expect(text).toContain('Portafolio')
    expect(text).toContain('Uso de fondos')
    expect(text.indexOf('Portafolio')).toBeLessThan(text.indexOf('Uso de fondos'))
  })

  it('renders slides whose relationship targets start at the package root', async () => {
    const zip = await JSZip.loadAsync(fixture('andina-solar-gerencia.pptx'))
    const relationships = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      relationships.replaceAll('Target="slides/', 'Target="/ppt/slides/')
    )
    const pdf = await convertPptxToPdf(await zip.generateAsync({ type: 'uint8array' }))

    expect(await pageSizes(pdf)).toHaveLength(3)
    expect(drawnText(pdf)).toContain('Andina Solar, S. A.')
    expect(drawnText(pdf)).toContain('Portafolio')
    expect(drawnText(pdf)).toContain('Uso de fondos')
  })

  it('uses the declared slide size', async () => {
    const pdf = await convertPptxToPdf(fixture('andina-solar-gerencia.pptx'))
    // 9,144,000 x 6,858,000 EMU = 720 x 540 pt.
    expect(await pageSizes(pdf)).toEqual([
      [720, 540],
      [720, 540],
      [720, 540],
    ])
  })

  it('falls back to the slide parts when the presentation has no usable sldIdLst', async () => {
    const zip = await JSZip.loadAsync(fixture('andina-solar-gerencia.pptx'))
    zip.file(
      'ppt/presentation.xml',
      '<?xml version="1.0"?><p:presentation xmlns:p="p"><p:sldIdLst/></p:presentation>'
    )
    const pdf = await convertPptxToPdf(await zip.generateAsync({ type: 'uint8array' }))

    expect(await pageSizes(pdf)).toHaveLength(3)
  })

  it('rejects a file that is not an OOXML package', async () => {
    await expect(convertPptxToPdf(new TextEncoder().encode('no soy un zip'))).rejects.toMatchObject(
      {
        name: 'RenditionError',
        code: 'NOT_A_PACKAGE',
      }
    )
  })

  it('rejects a package without ppt/presentation.xml', async () => {
    const zip = new JSZip()
    zip.file('hola.txt', 'nada')
    await expect(
      convertPptxToPdf(await zip.generateAsync({ type: 'uint8array' }))
    ).rejects.toMatchObject({ code: 'MISSING_MAIN_PART' })
  })

  it('rejects an input above the rendition size ceiling before unzipping it', async () => {
    const oversized = new Uint8Array(40 * 1024 * 1024 + 1)
    await expect(convertPptxToPdf(oversized)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' })
  })
})

describe('convertDocxToPdf', () => {
  it('renders the document paragraphs into a Letter-sized PDF', async () => {
    const pdf = await convertDocxToPdf(fixture('andina-solar-negocio.docx'))

    expect(await pageSizes(pdf)).toEqual([[612, 792]])
    expect(drawnText(pdf)).toContain('Andina Solar, S. A.')
    expect(drawnText(pdf)).toContain('Chiriqu')
  })

  it('rejects a package whose main part carries no text', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="w"><w:body/></w:document>'
    )
    await expect(
      convertDocxToPdf(await zip.generateAsync({ type: 'uint8array' }))
    ).rejects.toBeInstanceOf(RenditionError)
  })
})

describe('convertOoxmlToPdf', () => {
  it('dispatches by rendition source kind', async () => {
    const fromPptx = await convertOoxmlToPdf('pptx', fixture('andina-solar-gerencia.pptx'))
    const fromDocx = await convertOoxmlToPdf('docx', fixture('andina-solar-negocio.docx'))

    expect(await pageSizes(fromPptx)).toHaveLength(3)
    expect(await pageSizes(fromDocx)).toEqual([[612, 792]])
  })

  it('maps a rendition that never resolves to RENDER_FAILED after 15 seconds', async () => {
    vi.useFakeTimers()
    vi.spyOn(JSZip, 'loadAsync').mockImplementationOnce(() => new Promise(() => {}))

    const result = convertOoxmlToPdf('pptx', new Uint8Array([80, 75])).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    let settled = false
    void result.then(() => (settled = true))

    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { name: 'RenditionError', code: 'RENDER_FAILED' },
    })
  })
})
