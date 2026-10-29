// ============================================================================
// VDR READ MCP — text extraction (PDF / DOCX / PPTX / plain text)
// ============================================================================
// Node runtime only. Output is always a list of pages `{ n, text }` so a
// citation can point at a real page: PDF pages are PDF pages, PPTX slides are
// pages, and DOCX (which has no fixed pagination) is chunked into stable
// blocks so `page` stays meaningful and reproducible for the same blob.
// ============================================================================

import { Effect, Predicate, Schema, type Scope } from 'effect'

import { runServerEffect, throwEffectError } from '@/lib/effect/runtime'
import { VdrToolError } from '@/lib/vdr-mcp/errors'
import { readOoxmlPartsEffect } from '@/lib/vdr-mcp/zip'
import { VDR_MCP_READ_MAX_BYTES } from '../../../convex/_documents/uploadLimits'

export const EXTRACT_MAX_BYTES = VDR_MCP_READ_MAX_BYTES
const EXTRACT_MAX_PAGES = 400
const EXTRACT_MAX_TOTAL_CHARS = 400_000
const DOCX_CHARS_PER_PAGE = 2_500

export type ExtractorKind = 'PDF' | 'DOCX' | 'PPTX' | 'TXT'

type ExtractedPage = Readonly<{ n: number; text: string }>

export type Extraction = Readonly<{
  extractor: ExtractorKind
  pages: ExtractedPage[]
  truncated: boolean
}>

// pdfjs-dist exporta cinco excepciones tipadas. El agente sigue viendo
// `FORMATO_NO_SOPORTADO` para todas (`toToolErrorPayload`); el tag es para el
// log y la traza, no para cambiar la respuesta.
const ExtractionPdfReasonSchema = Schema.Literals([
  'password',
  'invalid',
  'aborted',
  'response',
  'cancelled',
])

export type ExtractionPdfReason = typeof ExtractionPdfReasonSchema.Type

export class ExtractionError extends Schema.TaggedError<ExtractionError>()('ExtractionError', {
  operation: Schema.String,
  message: Schema.String,
  reason: Schema.optionalKey(ExtractionPdfReasonSchema),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function extractionError(
  operation: string,
  cause: unknown,
  reason?: ExtractionPdfReason
): ExtractionError {
  return new ExtractionError({
    operation,
    message: Predicate.isError(cause) ? cause.message : String(cause),
    ...(reason === undefined ? {} : { reason }),
    ...(cause === undefined ? {} : { cause }),
  })
}

type PdfjsLegacy = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

// pdfjs en Node arranca con dos cargas que el tracer de archivos de Vercel no
// ve, y por eso el lambda de `/api/vdr-mcp` no las traía: el polyfill de
// `DOMMatrix` sale de `@napi-rs/canvas` por un `createRequire`, y el worker se
// importa con una cadena calculada en runtime. Sin la primera `pdf.mjs` ni
// evalúa (`DOMMatrix is not defined`); sin la segunda `getDocument` muere en
// «Setting up fake worker failed». Los literales de aquí abajo son lo que mete
// ambos archivos en la traza. El worker registra `globalThis.pdfjsWorker` al
// cargarse, así que pdfjs deja de buscarlo en disco. `webpackIgnore` porque
// `@napi-rs/canvas` trae un binario por plataforma que no debe entrar al
// bundle: queda como import de Node, que es lo que la traza sigue.
async function loadPdfjs(): Promise<PdfjsLegacy> {
  await import(/* webpackIgnore: true */ '@napi-rs/canvas')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return pdfjs
}

function isConstructor(input: unknown): input is abstract new (...args: never[]) => object {
  return Predicate.isFunction(input) && Predicate.hasProperty(input, 'prototype')
}

function isPdfException(ctor: unknown, cause: unknown): boolean {
  return isConstructor(ctor) && cause instanceof ctor
}

function pdfExtractionReason(pdfjs: PdfjsLegacy, cause: unknown): ExtractionPdfReason | undefined {
  if (isPdfException(pdfjs.PasswordException, cause)) return 'password'
  if (isPdfException(pdfjs.InvalidPDFException, cause)) return 'invalid'
  if (isPdfException(pdfjs.AbortException, cause)) return 'aborted'
  if (isPdfException(pdfjs.ResponseException, cause)) return 'response'
  if (isPdfException(pdfjs.RenderingCancelledException, cause)) return 'cancelled'
  return undefined
}

function extractionErrorFromPdf(
  pdfjs: PdfjsLegacy,
  operation: string,
  cause: unknown
): ExtractionError {
  return extractionError(operation, cause, pdfExtractionReason(pdfjs, cause))
}

const PDF_MIME = /^application\/pdf$/i
const DOCX_MIME = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i
const PPTX_MIME = /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/i
const TEXT_MIME = /^text\/(plain|csv|markdown)$/i

function extractorKindForMimeType(mimeType: string): ExtractorKind | null {
  const base = mimeType.split(';', 1)[0]?.trim() ?? ''
  if (PDF_MIME.test(base)) return 'PDF'
  if (DOCX_MIME.test(base)) return 'DOCX'
  if (PPTX_MIME.test(base)) return 'PPTX'
  if (TEXT_MIME.test(base)) return 'TXT'
  return null
}

export const extractorForMimeTypeEffect = Effect.fn('VdrExtract.extractorForMimeType')(
  (mimeType: string) => Effect.sync(() => extractorKindForMimeType(mimeType))
)

/** Legacy synchronous API. New Effect callers should use `extractorForMimeTypeEffect`. */
export function extractorForMimeType(mimeType: string): ExtractorKind | null {
  return Effect.runSync(extractorForMimeTypeEffect(mimeType))
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

function clampPages(pages: ExtractedPage[]): { pages: ExtractedPage[]; truncated: boolean } {
  const kept: ExtractedPage[] = []
  let total = 0
  let truncated = pages.length > EXTRACT_MAX_PAGES
  for (const page of pages.slice(0, EXTRACT_MAX_PAGES)) {
    const remaining = EXTRACT_MAX_TOTAL_CHARS - total
    if (remaining <= 0) {
      truncated = true
      break
    }
    const text = page.text.length > remaining ? page.text.slice(0, remaining) : page.text
    if (text.length < page.text.length) truncated = true
    total += text.length
    kept.push({ n: page.n, text })
  }
  return { pages: kept, truncated }
}

// ===== XML text harvesting =====

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Concatenate the text of every occurrence of one element, in document order. */
function harvestElementText(xml: string, localName: string, joiner: string): string {
  const pattern = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*?(/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>)`,
    'g'
  )
  const chunks: string[] = []
  for (const match of xml.matchAll(pattern)) {
    if (match[1] === '/>') continue
    chunks.push(decodeXmlEntities(match[2] ?? ''))
  }
  return chunks.join(joiner)
}

function docxParagraphs(xml: string): string[] {
  const pattern = /<(?:[A-Za-z0-9_.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?p>/g
  const paragraphs: string[] = []
  for (const match of xml.matchAll(pattern)) {
    const text = normalizeWhitespace(harvestElementText(match[1] ?? '', 't', ''))
    if (text.length > 0) paragraphs.push(text)
  }
  return paragraphs
}

function chunkParagraphs(paragraphs: string[]): ExtractedPage[] {
  const pages: ExtractedPage[] = []
  let buffer: string[] = []
  let size = 0
  for (const paragraph of paragraphs) {
    if (size > 0 && size + paragraph.length > DOCX_CHARS_PER_PAGE) {
      pages.push({ n: pages.length + 1, text: buffer.join('\n') })
      buffer = []
      size = 0
    }
    buffer.push(paragraph)
    size += paragraph.length + 1
  }
  if (buffer.length > 0) pages.push({ n: pages.length + 1, text: buffer.join('\n') })
  return pages
}

// ===== extractors =====

const extractDocxEffect = Effect.fn('VdrExtract.docx')(function* (
  bytes: Uint8Array
): Effect.fn.Return<ExtractedPage[], ExtractionError> {
  const parts = yield* readOoxmlPartsEffect(bytes, (name) => name === 'word/document.xml').pipe(
    Effect.catch(() => Effect.succeed([]))
  )
  const xml = parts[0]?.xml
  if (!xml) return []
  return yield* Effect.try({
    try: () => chunkParagraphs(docxParagraphs(xml)),
    catch: (cause) => extractionError('docx.parse', cause),
  })
})

function slideOrdinal(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

const extractPptxEffect = Effect.fn('VdrExtract.pptx')(function* (
  bytes: Uint8Array
): Effect.fn.Return<ExtractedPage[], ExtractionError> {
  const parts = yield* readOoxmlPartsEffect(bytes, (name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name)
  ).pipe(Effect.catch(() => Effect.succeed([])))
  return yield* Effect.try({
    try: () =>
      parts
        .sort((left, right) => slideOrdinal(left.name) - slideOrdinal(right.name))
        .map((part, index) => ({
          n: index + 1,
          text: normalizeWhitespace(harvestElementText(part.xml, 't', '\n')),
        })),
    catch: (cause) => extractionError('pptx.parse', cause),
  })
})

const extractPdfScoped = Effect.fn('VdrExtract.pdfScoped')(function* (
  bytes: Uint8Array
): Effect.fn.Return<ExtractedPage[], ExtractionError, Scope.Scope> {
  // Dynamic import: pdfjs is a heavy Node-only dependency and must never be
  // pulled into a module graph that a client bundle can reach.
  const pdfjs = yield* Effect.tryPromise({
    try: () => loadPdfjs(),
    catch: (cause) => extractionError('pdf.import', cause),
  })
  const fail = (operation: string, cause: unknown) =>
    extractionErrorFromPdf(pdfjs, operation, cause)
  const task = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        pdfjs.getDocument({
          data: bytes,
          // No font machinery and no worker fetch: text extraction only, in-process.
          useSystemFonts: false,
          disableFontFace: true,
          useWorkerFetch: false,
        }),
      catch: (cause) => fail('pdf.open', cause),
    }),
    (acquiredTask) =>
      Effect.tryPromise({
        try: () => acquiredTask.destroy(),
        catch: (cause) => fail('pdf.destroy', cause),
      }).pipe(Effect.orDie)
  )
  const document = yield* Effect.tryPromise({
    try: () => task.promise,
    catch: (cause) => fail('pdf.load', cause),
  })
  const pages: ExtractedPage[] = []
  const count = Math.min(document.numPages, EXTRACT_MAX_PAGES)
  for (let index = 1; index <= count; index += 1) {
    const text = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => document.getPage(index),
        catch: (cause) => fail('pdf.page.open', cause),
      }),
      (page) =>
        Effect.tryPromise({
          try: () => page.getTextContent(),
          catch: (cause) => fail('pdf.page.text', cause),
        }).pipe(
          Effect.flatMap((content) =>
            Effect.try({
              try: () =>
                normalizeWhitespace(
                  content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
                ),
              catch: (cause) => fail('pdf.page.normalize', cause),
            })
          )
        ),
      (page) =>
        Effect.try({
          try: () => page.cleanup(),
          catch: (cause) => fail('pdf.page.cleanup', cause),
        }).pipe(Effect.asVoid)
    )
    pages.push({ n: index, text })
  }
  return pages
})

const extractPdfEffect = Effect.fn('VdrExtract.pdf')(function* (bytes: Uint8Array) {
  return yield* Effect.scoped(extractPdfScoped(bytes))
})

const extractTextEffect = Effect.fn('VdrExtract.text')(function* (
  bytes: Uint8Array
): Effect.fn.Return<ExtractedPage[], ExtractionError> {
  return yield* Effect.try({
    try: () => {
      const text = normalizeWhitespace(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
      return text.length === 0 ? [] : chunkParagraphs(text.split(/\r?\n/).filter(Boolean))
    },
    catch: (cause) => extractionError('text.decode', cause),
  })
})

/**
 * Extract page-addressable text from an authorized blob. Correctable failures
 * use `VdrToolError`; parser and engine failures stay explicit in the error
 * channel.
 */
export const extractDocumentTextEffect = Effect.fn('VdrExtract.documentText')(function* (
  bytes: Uint8Array,
  mimeType: string
): Effect.fn.Return<Extraction, VdrToolError | ExtractionError> {
  if (bytes.byteLength > EXTRACT_MAX_BYTES) {
    return yield* new VdrToolError(
      'ARCHIVO_DEMASIADO_GRANDE',
      'El documento excede el tamaño máximo que esta sala indexa.',
      'Pide un documento más pequeño o consulta el modelo financiero con las tools modelo_*.'
    )
  }
  const extractor = yield* extractorForMimeTypeEffect(mimeType)
  if (!extractor) {
    return yield* new VdrToolError(
      'FORMATO_NO_SOPORTADO',
      `No puedo extraer texto de un archivo ${mimeType}.`,
      'Los formatos con texto indexable son PDF, DOCX, PPTX y texto plano. Para XLSX usa las tools modelo_*.'
    )
  }

  const raw =
    extractor === 'PDF'
      ? yield* extractPdfEffect(bytes)
      : extractor === 'DOCX'
        ? yield* extractDocxEffect(bytes)
        : extractor === 'PPTX'
          ? yield* extractPptxEffect(bytes)
          : yield* extractTextEffect(bytes)

  const clamped = yield* Effect.try({
    try: () => clampPages(raw.filter((page) => page.text.length > 0)),
    catch: (cause) => extractionError('document.clamp', cause),
  })
  return { extractor, pages: clamped.pages, truncated: clamped.truncated }
})

async function runExtractionEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const outcome = await runServerEffect(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )
  )
  if (!outcome.ok) throwEffectError(outcome.error)
  return outcome.value
}

/** Legacy Promise API. New Effect callers should use `extractDocumentTextEffect`. */
export function extractDocumentText(bytes: Uint8Array, mimeType: string): Promise<Extraction> {
  return runExtractionEffect(extractDocumentTextEffect(bytes, mimeType))
}
