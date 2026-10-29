// @vitest-environment node
import { Effect, Fiber } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  extractDocumentText,
  extractDocumentTextEffect,
  extractorForMimeType,
  extractorForMimeTypeEffect,
} from '@/lib/vdr-mcp/extract'

const pdfLifecycle = vi.hoisted(() => {
  let signalPageStarted: () => void = () => {}
  const pageStarted = new Promise<void>((resolve) => {
    signalPageStarted = resolve
  })

  class PasswordException extends Error {
    constructor(
      message: string,
      readonly code: number
    ) {
      super(message)
      this.name = 'PasswordException'
    }
  }
  class InvalidPDFException extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'InvalidPDFException'
    }
  }
  class AbortException extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AbortException'
    }
  }
  class ResponseException extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly missing: boolean
    ) {
      super(message)
      this.name = 'ResponseException'
    }
  }
  class RenderingCancelledException extends Error {
    constructor(
      message: string,
      readonly extraDelay = 0
    ) {
      super(message)
      this.name = 'RenderingCancelledException'
    }
  }

  return {
    cleanup: vi.fn(),
    destroy: vi.fn(() => Promise.resolve()),
    pageStarted,
    signalPageStarted,
    openError: null as Error | null,
    PasswordException,
    InvalidPDFException,
    AbortException,
    ResponseException,
    RenderingCancelledException,
  }
})

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise:
      pdfLifecycle.openError === null
        ? Promise.resolve({
            numPages: 1,
            getPage: () =>
              Promise.resolve({
                cleanup: pdfLifecycle.cleanup,
                getTextContent: () => {
                  pdfLifecycle.signalPageStarted()
                  return new Promise<never>(() => {
                    // The fiber interruption, not a Promise resolution, ends this read.
                  })
                },
              }),
          })
        : Promise.reject(pdfLifecycle.openError),
    destroy: pdfLifecycle.destroy,
  }),
  PasswordException: pdfLifecycle.PasswordException,
  InvalidPDFException: pdfLifecycle.InvalidPDFException,
  AbortException: pdfLifecycle.AbortException,
  ResponseException: pdfLifecycle.ResponseException,
  RenderingCancelledException: pdfLifecycle.RenderingCancelledException,
}))

describe('extractorForMimeType', () => {
  it('routes PDF, OOXML and text even when a charset parameter is present', () => {
    expect(extractorForMimeType('application/pdf')).toBe('PDF')
    expect(extractorForMimeType('Application/PDF; charset=binary')).toBe('PDF')
    expect(
      extractorForMimeType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=utf-8'
      )
    ).toBe('DOCX')
    expect(
      extractorForMimeType(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ).toBe('PPTX')
    expect(extractorForMimeType('text/plain')).toBe('TXT')
    expect(extractorForMimeType('text/csv; charset=utf-8')).toBe('TXT')
    expect(extractorForMimeType('text/markdown')).toBe('TXT')
  })

  it('leaves workbooks and unknown media to other tools instead of a text extractor', () => {
    expect(
      extractorForMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    ).toBeNull()
    expect(extractorForMimeType('application/zip')).toBeNull()
    expect(extractorForMimeType('image/png')).toBeNull()
    expect(extractorForMimeType('')).toBeNull()
  })

  it('exposes Effect-native MIME routing and extraction without changing the Promise result', async () => {
    await expect(
      Effect.runPromise(extractorForMimeTypeEffect('text/plain; charset=utf-8'))
    ).resolves.toBe('TXT')

    const bytes = new TextEncoder().encode('Ingresos recurrentes')
    const native = await Effect.runPromise(extractDocumentTextEffect(bytes, 'text/plain'))
    const legacy = await extractDocumentText(bytes, 'text/plain')
    expect(native).toEqual(legacy)
    expect(native).toMatchObject({
      extractor: 'TXT',
      pages: [{ n: 1, text: 'Ingresos recurrentes' }],
      truncated: false,
    })

    const failure = await Effect.runPromise(
      extractDocumentTextEffect(bytes, 'image/png').pipe(
        Effect.match({
          onSuccess: () => null,
          onFailure: (error) => error,
        })
      )
    )
    expect(failure).toMatchObject({ _tag: 'VdrToolError', code: 'FORMATO_NO_SOPORTADO' })
    await expect(extractDocumentText(bytes, 'image/png')).rejects.toMatchObject({
      _tag: 'VdrToolError',
      code: 'FORMATO_NO_SOPORTADO',
    })
  })

  it('keeps PDF page cleanup and task destruction on interruption', async () => {
    const fiber = Effect.runFork(extractDocumentTextEffect(new Uint8Array([1]), 'application/pdf'))
    await pdfLifecycle.pageStarted
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(pdfLifecycle.cleanup).toHaveBeenCalledOnce()
    expect(pdfLifecycle.destroy).toHaveBeenCalledOnce()
  })

  describe('ExtractionError.reason', () => {
    afterEach(() => {
      pdfLifecycle.openError = null
    })

    it.each([
      ['password', () => new pdfLifecycle.PasswordException('Need password', 1)],
      ['invalid', () => new pdfLifecycle.InvalidPDFException('Invalid PDF structure.')],
      ['aborted', () => new pdfLifecycle.AbortException('Loading aborted.')],
      ['response', () => new pdfLifecycle.ResponseException('Unexpected server response', 404, false)],
      ['cancelled', () => new pdfLifecycle.RenderingCancelledException('Rendering cancelled')],
    ] as const)('tags %s from the matching pdfjs exception', async (reason, makeError) => {
      pdfLifecycle.openError = makeError()
      const failure = await Effect.runPromise(
        extractDocumentTextEffect(new Uint8Array([1]), 'application/pdf').pipe(
          Effect.match({
            onSuccess: () => null,
            onFailure: (error) => error,
          })
        )
      )
      expect(failure).toMatchObject({
        _tag: 'ExtractionError',
        operation: 'pdf.load',
        reason,
      })
    })

    it('omits reason when the failure is not a pdfjs exception', async () => {
      pdfLifecycle.openError = new Error('boom')
      const failure = await Effect.runPromise(
        extractDocumentTextEffect(new Uint8Array([1]), 'application/pdf').pipe(
          Effect.match({
            onSuccess: () => null,
            onFailure: (error) => error,
          })
        )
      )
      expect(failure).toMatchObject({ _tag: 'ExtractionError', operation: 'pdf.load' })
      expect(failure).not.toHaveProperty('reason')
    })
  })
})
