// ============================================================================
// RENDITIONS: PPTX / DOCX -> PDF
// ============================================================================
// Conversor pure-JS e isomorfico (corre igual en Node y en el navegador):
// JSZip abre el paquete OOXML, el lector XML de `./xml` recorre las partes y
// pdf-lib escribe el PDF. Sin binarios, sin LibreOffice, sin servicio externo:
// funciona dentro del runtime de Vercel y dentro del visor del VDR.
//
// La fidelidad es BASICA a proposito — texto, imagenes y fondo por diapositiva,
// posicionados con el `a:xfrm` del shape cuando existe. No hay temas, layouts
// heredados, tablas, graficos ni animaciones. El original siempre se conserva:
// la rendition es una vista, nunca la version custodiada.
//
// Frontera de confianza: el paquete lo sube el productor, asi que aqui NUNCA se
// interpreta HTML ni se ejecuta nada del archivo. Se leen tags conocidos y se
// dibujan primitivas de PDF.
//
// Cada paso del conversor falla con un `RenditionError` tipado y con codigo
// estable: quien llama (la ruta del grant, el visor) decide con ese codigo, no
// con el mensaje crudo de JSZip o pdf-lib. Las firmas exportadas siguen siendo
// promesas porque el visor del VDR es React.
// ============================================================================

import { Cause, Duration, Effect, Schema } from 'effect'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'

import { runServerEffect, throwEffectError } from '@/lib/effect/runtime'
import {
  childrenNamed,
  findDescendant,
  findDescendants,
  parseXml,
  parseXmlEffect,
  type XmlNode,
} from './xml'

/** Techo del paquete de entrada. Arriba de esto la rendition no es el camino. */
const RENDITION_MAX_INPUT_BYTES = 40 * 1024 * 1024
/** Techo de paginas/diapositivas emitidas: acota CPU y tamano de salida. */
const RENDITION_MAX_PAGES = 200
/** Techo total de conversion: corta paquetes que dejan una operacion pendiente. */
const RENDITION_TIMEOUT = Duration.seconds(15)

export const RenditionErrorCodeSchema = Schema.Literals([
  'INPUT_TOO_LARGE',
  'NOT_A_PACKAGE',
  'MISSING_MAIN_PART',
  'EMPTY_DOCUMENT',
  'RENDER_FAILED',
])

export class RenditionError extends Schema.TaggedError<RenditionError>()('RenditionError', {
  message: Schema.String,
  code: RenditionErrorCodeSchema,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Un paso del conversor que vive en una promesa (JSZip, pdf-lib). */
function renditionPromise<A>(
  operation: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, RenditionError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RenditionError
        ? cause
        : new RenditionError({
            message: `La rendition fallo en ${operation}`,
            code: 'RENDER_FAILED',
            cause,
          }),
  })
}

/** Puente para los consumidores que siguen en promesas (ruta y visor React). */
async function runRenditionEffect(
  effect: Effect.Effect<Uint8Array, RenditionError>
): Promise<Uint8Array> {
  const outcome = await runServerEffect(
    effect.pipe(
      Effect.timeout(RENDITION_TIMEOUT),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new RenditionError({
              message: 'La rendition excedio el tiempo permitido',
              code: 'RENDER_FAILED',
              cause: error,
            })
          : error
      ),
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (!outcome.ok) throwEffectError(outcome.error)
  return outcome.value
}

// ===== GEOMETRIA ============================================================
// OOXML mide en EMU (English Metric Units): 914,400 por pulgada. El PDF mide en
// puntos: 72 por pulgada.
const EMU_PER_POINT = 12_700
const LETTER: [number, number] = [612, 792]
const DEFAULT_SLIDE: [number, number] = [720, 540] // 10 x 7.5 pulgadas (4:3)

function emuToPoints(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed / EMU_PER_POINT : null
}

// ===== TEXTO ================================================================
// Las fuentes estandar de PDF codifican WinAnsi. Un caracter fuera de ese
// repertorio hace lanzar a pdf-lib y tumbaria la rendition entera, asi que se
// normaliza antes de dibujar: los tipograficos comunes se degradan a su
// equivalente ASCII y el resto se cambia por un espacio.
const TYPOGRAPHIC_REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '•': '-',
  '·': '-',
  '…': '...',
  ' ': ' ',
  '→': '->',
  '≥': '>=',
  '≤': '<=',
  '\t': '    ',
}

export function toWinAnsiSafeText(value: string): string {
  let normalized = value
  for (const [from, to] of Object.entries(TYPOGRAPHIC_REPLACEMENTS)) {
    normalized = normalized.split(from).join(to)
  }
  // Bandera `u`: un emoji (par suplente) se reemplaza por UN espacio, no dos.
  return normalized.replace(/[^\n -~¡-ÿ]/gu, ' ')
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    lines.push(current)
  }
  return lines
}

// ===== PAQUETE ==============================================================
interface Package {
  readonly zip: JSZip
  text(path: string): Promise<string | null>
  bytes(path: string): Promise<Uint8Array | null>
}

const openPackage = Effect.fn('Rendition.openPackage')(function* (
  input: ArrayBuffer | Uint8Array
): Effect.fn.Return<Package, RenditionError> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength > RENDITION_MAX_INPUT_BYTES) {
    return yield* new RenditionError({
      message: 'El archivo excede el tope de la rendition',
      code: 'INPUT_TOO_LARGE',
    })
  }

  const zip = yield* Effect.tryPromise({
    try: () => JSZip.loadAsync(bytes),
    catch: (cause) =>
      new RenditionError({
        message: 'El archivo no es un paquete OOXML valido',
        code: 'NOT_A_PACKAGE',
        cause,
      }),
  })

  return {
    zip,
    async text(path) {
      const entry = zip.file(path)
      return entry ? entry.async('string') : null
    },
    async bytes(path) {
      const entry = zip.file(path)
      return entry ? entry.async('uint8array') : null
    },
  }
})

/** `ppt/slides/slide1.xml` + `../media/x.png` -> `ppt/media/x.png`. */
function resolveRelativePath(basePath: string, target: string): string {
  const segments = target.startsWith('/') ? [] : basePath.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

const readRelationships = Effect.fn('Rendition.readRelationships')(function* (
  pkg: Package,
  partPath: string
): Effect.fn.Return<Map<string, { type: string; target: string }>, RenditionError> {
  const segments = partPath.split('/')
  const relsPath = [
    ...segments.slice(0, -1),
    '_rels',
    `${segments[segments.length - 1]}.rels`,
  ].join('/')
  const relationships = new Map<string, { type: string; target: string }>()

  const source = yield* renditionPromise('readRelationships', () => pkg.text(relsPath))
  if (!source) return relationships

  const root = parseXml(source)
  if (!root) return relationships

  for (const relationship of childrenNamed(root, 'Relationship')) {
    const id = relationship.attributes.Id
    const target = relationship.attributes.Target
    if (!id || !target) continue
    relationships.set(id, { type: relationship.attributes.Type ?? '', target })
  }
  return relationships
})

// ===== PPTX =================================================================
interface SlideTextBlock {
  readonly lines: string[]
  readonly x: number | null
  readonly y: number | null
  readonly width: number | null
  readonly emphasis: boolean
}

interface SlidePicture {
  readonly path: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function readOffsetAndExtent(shape: XmlNode): {
  x: number | null
  y: number | null
  width: number | null
  height: number | null
} {
  const transform = findDescendant(shape, 'a:xfrm')
  const offset = transform ? findDescendant(transform, 'a:off') : null
  const extent = transform ? findDescendant(transform, 'a:ext') : null
  return {
    x: emuToPoints(offset?.attributes.x),
    y: emuToPoints(offset?.attributes.y),
    width: emuToPoints(extent?.attributes.cx),
    height: emuToPoints(extent?.attributes.cy),
  }
}

function readShapeText(shape: XmlNode): string[] {
  const body = findDescendant(shape, 'p:txBody')
  if (!body) return []
  return findDescendants(body, 'a:p')
    .map((paragraph) =>
      findDescendants(paragraph, 'a:t')
        .map((run) => run.text)
        .join('')
        .trim()
    )
    .filter((line) => line.length > 0)
}

function readSlideBackground(slide: XmlNode): [number, number, number] | null {
  const background = findDescendant(slide, 'p:bg')
  const color = background ? findDescendant(background, 'a:srgbClr') : null
  const value = color?.attributes.val
  if (!value || !/^[0-9a-fA-F]{6}$/.test(value)) return null
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ]
}

const readSlidePaths = Effect.fn('Rendition.readSlidePaths')(function* (
  pkg: Package
): Effect.fn.Return<string[], RenditionError> {
  const presentationSource = yield* renditionPromise('readSlidePaths', () =>
    pkg.text('ppt/presentation.xml')
  )
  if (!presentationSource) {
    return yield* new RenditionError({
      message: 'El paquete no trae ppt/presentation.xml',
      code: 'MISSING_MAIN_PART',
    })
  }

  const presentation = yield* parseXmlEffect('ppt/presentation.xml', presentationSource).pipe(
    Effect.mapError(
      () =>
        new RenditionError({
          message: 'ppt/presentation.xml no es XML valido',
          code: 'MISSING_MAIN_PART',
        })
    )
  )

  const relationships = yield* readRelationships(pkg, 'ppt/presentation.xml')
  const paths: string[] = []
  for (const slideId of findDescendants(presentation, 'p:sldId')) {
    const relationshipId = slideId.attributes['r:id']
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined
    if (!relationship) continue
    paths.push(resolveRelativePath('ppt/presentation.xml', relationship.target))
  }

  // Un paquete sin `sldIdLst` utilizable todavia puede traer las partes: se
  // ordena por el numero del nombre para no devolver un PDF vacio.
  if (paths.length === 0) {
    const fallback = Object.keys(pkg.zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(
        (a, b) =>
          Number.parseInt(a.replace(/\D+/g, ''), 10) - Number.parseInt(b.replace(/\D+/g, ''), 10)
      )
    paths.push(...fallback)
  }

  return paths.slice(0, RENDITION_MAX_PAGES)
})

function readPresentationSize(presentation: XmlNode | null): [number, number] {
  const size = presentation ? findDescendant(presentation, 'p:sldSz') : null
  const width = emuToPoints(size?.attributes.cx)
  const height = emuToPoints(size?.attributes.cy)
  return width && height ? [width, height] : DEFAULT_SLIDE
}

const embedPicture = Effect.fn('Rendition.embedPicture')(function* (
  pdf: PDFDocument,
  pkg: Package,
  path: string
): Effect.fn.Return<PDFImage | null, RenditionError> {
  const bytes = yield* renditionPromise('embedPicture', () => pkg.bytes(path))
  if (!bytes) return null
  // Una imagen ilegible degrada la diapositiva, no tumba la rendition.
  return yield* Effect.tryPromise({
    try: async () => {
      if (path.toLowerCase().endsWith('.png')) return await pdf.embedPng(bytes)
      if (/\.jpe?g$/i.test(path)) return await pdf.embedJpg(bytes)
      return null
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed<PDFImage | null>(null)))
})

function drawTextBlocks(
  page: PDFPage,
  blocks: SlideTextBlock[],
  fonts: { regular: PDFFont; bold: PDFFont },
  slideHeight: number,
  slideWidth: number
) {
  const margin = 36
  let flowY = slideHeight - margin

  for (const block of blocks) {
    const size = block.emphasis ? 22 : 14
    const font = block.emphasis ? fonts.bold : fonts.regular
    const width = block.width ?? slideWidth - margin * 2
    const x = block.x ?? margin
    // OOXML mide `y` desde arriba; el PDF desde abajo.
    let y = block.y === null ? flowY : slideHeight - block.y - size

    for (const line of block.lines) {
      for (const wrapped of wrapText(toWinAnsiSafeText(line), font, size, width)) {
        if (y < margin) break
        page.drawText(wrapped, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) })
        y -= size * 1.35
      }
    }
    flowY = Math.min(flowY, y) - size * 0.5
  }
}

const renderPptxToPdf = Effect.fn('Rendition.pptxToPdf')(function* (
  input: ArrayBuffer | Uint8Array
): Effect.fn.Return<Uint8Array, RenditionError> {
  const pkg = yield* openPackage(input)
  const slidePaths = yield* readSlidePaths(pkg)
  if (slidePaths.length === 0) {
    return yield* new RenditionError({
      message: 'La presentacion no tiene diapositivas',
      code: 'EMPTY_DOCUMENT',
    })
  }

  const presentationSource = yield* renditionPromise('pptxToPdf.presentation', () =>
    pkg.text('ppt/presentation.xml')
  )
  const [slideWidth, slideHeight] = readPresentationSize(
    presentationSource ? parseXml(presentationSource) : null
  )

  const pdf = yield* renditionPromise('pptxToPdf.create', () => PDFDocument.create())
  const fonts = {
    regular: yield* renditionPromise('pptxToPdf.font', () =>
      pdf.embedFont(StandardFonts.Helvetica)
    ),
    bold: yield* renditionPromise('pptxToPdf.font', () =>
      pdf.embedFont(StandardFonts.HelveticaBold)
    ),
  }

  for (const slidePath of slidePaths) {
    const page = pdf.addPage([slideWidth, slideHeight])
    const source = yield* renditionPromise('pptxToPdf.slide', () => pkg.text(slidePath))
    const slide = source ? parseXml(source) : null
    if (!slide) continue

    const background = readSlideBackground(slide)
    if (background) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: slideWidth,
        height: slideHeight,
        color: rgb(background[0], background[1], background[2]),
      })
    }

    const relationships = yield* readRelationships(pkg, slidePath)
    const pictures: SlidePicture[] = []
    for (const picture of findDescendants(slide, 'p:pic')) {
      const blip = findDescendant(picture, 'a:blip')
      const embedId = blip?.attributes['r:embed']
      const relationship = embedId ? relationships.get(embedId) : undefined
      if (!relationship) continue
      const geometry = readOffsetAndExtent(picture)
      pictures.push({
        path: resolveRelativePath(slidePath, relationship.target),
        x: geometry.x ?? 0,
        y: geometry.y ?? 0,
        width: geometry.width ?? slideWidth,
        height: geometry.height ?? slideHeight,
      })
    }

    for (const picture of pictures) {
      const image = yield* embedPicture(pdf, pkg, picture.path)
      if (!image) continue
      page.drawImage(image, {
        x: picture.x,
        y: slideHeight - picture.y - picture.height,
        width: picture.width,
        height: picture.height,
      })
    }

    const blocks: SlideTextBlock[] = []
    for (const [index, shape] of findDescendants(slide, 'p:sp').entries()) {
      const lines = readShapeText(shape)
      if (lines.length === 0) continue
      const geometry = readOffsetAndExtent(shape)
      blocks.push({
        lines,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        // Sin layout heredado no hay "titulo" fiable: el primer bloque con
        // texto de la diapositiva es la mejor aproximacion.
        emphasis: index === 0,
      })
    }

    drawTextBlocks(page, blocks, fonts, slideHeight, slideWidth)
  }

  return yield* renditionPromise('pptxToPdf.save', () => pdf.save())
})

export function convertPptxToPdf(input: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return runRenditionEffect(renderPptxToPdf(input))
}

// ===== DOCX =================================================================
interface DocxParagraph {
  readonly text: string
  readonly heading: boolean
}

function readDocxParagraphs(document: XmlNode): DocxParagraph[] {
  const body = findDescendant(document, 'w:body')
  if (!body) return []

  return findDescendants(body, 'w:p')
    .map((paragraph) => {
      const style = findDescendant(paragraph, 'w:pStyle')?.attributes['w:val'] ?? ''
      const text = findDescendants(paragraph, 'w:t')
        .map((run) => run.text)
        .join('')
        .trim()
      return { text, heading: /^heading/i.test(style) || /^Titulo/i.test(style) }
    })
    .filter((paragraph) => paragraph.text.length > 0)
}

const renderDocxToPdf = Effect.fn('Rendition.docxToPdf')(function* (
  input: ArrayBuffer | Uint8Array
): Effect.fn.Return<Uint8Array, RenditionError> {
  const pkg = yield* openPackage(input)
  const source = yield* renditionPromise('docxToPdf.document', () => pkg.text('word/document.xml'))
  if (!source) {
    return yield* new RenditionError({
      message: 'El paquete no trae word/document.xml',
      code: 'MISSING_MAIN_PART',
    })
  }

  const document = parseXml(source)
  const paragraphs = document ? readDocxParagraphs(document) : []
  if (paragraphs.length === 0) {
    return yield* new RenditionError({
      message: 'El documento no tiene texto',
      code: 'EMPTY_DOCUMENT',
    })
  }

  const pdf = yield* renditionPromise('docxToPdf.create', () => PDFDocument.create())
  const regular = yield* renditionPromise('docxToPdf.font', () =>
    pdf.embedFont(StandardFonts.Helvetica)
  )
  const bold = yield* renditionPromise('docxToPdf.font', () =>
    pdf.embedFont(StandardFonts.HelveticaBold)
  )

  const [pageWidth, pageHeight] = LETTER
  const margin = 54
  const maxWidth = pageWidth - margin * 2

  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const nextPage = () => {
    if (pdf.getPageCount() >= RENDITION_MAX_PAGES) return false
    page = pdf.addPage([pageWidth, pageHeight])
    y = pageHeight - margin
    return true
  }

  for (const paragraph of paragraphs) {
    const size = paragraph.heading ? 16 : 11
    const font = paragraph.heading ? bold : regular
    if (paragraph.heading) y -= size * 0.6

    for (const line of wrapText(toWinAnsiSafeText(paragraph.text), font, size, maxWidth)) {
      if (y < margin) {
        if (!nextPage()) return yield* renditionPromise('docxToPdf.save', () => pdf.save())
      }
      page.drawText(line, { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.1) })
      y -= size * 1.5
    }
    y -= size * 0.5
  }

  return yield* renditionPromise('docxToPdf.save', () => pdf.save())
})

export function convertDocxToPdf(input: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return runRenditionEffect(renderDocxToPdf(input))
}

export type RenditionSourceKind = 'pptx' | 'docx'

export function convertOoxmlToPdf(
  kind: RenditionSourceKind,
  input: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  return runRenditionEffect(kind === 'pptx' ? renderPptxToPdf(input) : renderDocxToPdf(input))
}
