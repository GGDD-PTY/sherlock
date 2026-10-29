// ============================================================================
// VDR READ MCP — los motores cargan con lo que llega al lambda
// ============================================================================
// `documento_buscar` y `modelo_hojas` respondían NO_DISPONIBLE solo en Vercel.
// La traza del lambda no llevaba ni el worker de pdfjs, ni `@napi-rs/canvas`
// (el polyfill de DOMMatrix sin el cual `pdf.mjs` no evalúa), ni el addon
// nativo de MOG. Aquí se pinnea que los assets resuelven en la instalación,
// que `extract.ts` conserva los literales que los meten en la traza, que la
// extracción de PDF no depende de encontrar el worker en disco (la condición
// exacta del lambda), y que un motor que no carga no se disfraza de archivo
// dañado.
// ============================================================================

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runServerEffect } from '@/lib/effect/runtime'
import { toToolErrorPayload } from '@/lib/vdr-mcp/errors'
import { extractDocumentText } from '@/lib/vdr-mcp/extract'
import { loadWorkbookScoped, WorkbookError } from '@/lib/vdr-mcp/workbook'

const require = createRequire(resolve(process.cwd(), 'package.json'))
const FIXTURES = resolve(process.cwd(), 'src/__tests__/fixtures/vdr-mcp')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)))
}

describe('pdfjs with the files the lambda receives', () => {
  it('resolves the two files the tracer could not see on its own', () => {
    expect(() => require.resolve('@napi-rs/canvas')).not.toThrow()
    expect(() => require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).not.toThrow()
  })

  it('keeps the literal imports that put those files in the trace', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/vdr-mcp/extract.ts'), 'utf8')
    expect(source).toMatch(/import\(\s*\/\* webpackIgnore: true \*\/\s*'@napi-rs\/canvas'\s*\)/)
    expect(source).toContain("import('pdfjs-dist/legacy/build/pdf.worker.mjs')")
  })

  it('extracts text with the worker file unreachable on disk', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc =
      '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'

    const extraction = await extractDocumentText(
      fixture('andina-solar-eeff-fy24.pdf'),
      'application/pdf'
    )

    expect(extraction.extractor).toBe('PDF')
    expect(extraction.pages.length).toBeGreaterThan(0)
    expect(extraction.pages[0]?.text.length).toBeGreaterThan(0)
  })
})

describe('MOG with the files the lambda receives', () => {
  it('opens the model through the engine this install provides', async () => {
    const sheetNames = await runServerEffect(
      Effect.scoped(
        Effect.map(loadWorkbookScoped(fixture('andina-solar-modelo.xlsx')), (workbook) => [
          ...workbook.sheetNames,
        ])
      )
    )
    expect(sheetNames).toEqual(['Supuestos', 'Estado de Resultados', 'Deuda', 'Resumen'])
  })

  it('reports an engine that cannot load as ours, never as a damaged file', async () => {
    const missingAddon = Object.assign(new Error("Cannot find module '@mog-sdk/linux-x64-gnu'"), {
      code: 'INTERNAL_ERROR',
    })
    const failure = await runServerEffect(
      Effect.scoped(
        loadWorkbookScoped(fixture('andina-solar-modelo.xlsx'), async () => {
          throw missingAddon
        })
      ).pipe(Effect.flip)
    )

    expect(failure).toBeInstanceOf(WorkbookError)
    expect(failure).toMatchObject({ reason: 'internal', engineCode: 'INTERNAL_ERROR' })
    expect(toToolErrorPayload(failure as WorkbookError).code).toBe('NO_DISPONIBLE')
  })
})
