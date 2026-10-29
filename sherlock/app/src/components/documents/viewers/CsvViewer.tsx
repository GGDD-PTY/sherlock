'use client'

// ============================================================================
// VISOR DE CSV
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// Acá entra lo único que este visor no controla: los bytes del archivo del
// cliente. Se decodificaban con `new TextDecoder('utf-8')` a secas, que NUNCA
// falla: los bytes que no son UTF-8 los reemplaza por U+FFFD y la tabla pinta
// galimatías sin que nada en el código diga que hubo un problema. Ahora la
// lectura estricta y la de reemplazo son dos ramas con nombre
// (`CsvEncodingError`), y el programa corre en el borde —dentro del
// `useEffect`, no en el camino de render— con su fibra interrumpida cuando
// llega otro documento.
//
// Lo que se VE no cambió: un CSV en Latin-1 (lo que exporta Excel en la región)
// sigue mostrándose con reemplazos. Qué hacer con él —avisar en la franja de
// `notice`, ofrecer otra codificación, rechazarlo— es decisión de producto y no
// se toma acá.
// ============================================================================

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Schema } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'

import { ViewerError, ViewerFrame, ViewerLoading, type ViewerChromeProps } from './ViewerChrome'
import { useDocumentBytes } from './useDocumentBytes'

const MAX_ROWS = 500
const NUMERIC = /^-?[\d.,]+%?$/
// Codigo de cuenta, no importe: entero corto y sin separador ni decimales. Se
// deja como identificador (mono, a la izquierda) y nunca se formatea.
const CODE = /^\d{1,5}$/

/**
 * Lo que una columna resulta ser, en una sola palabra.
 *
 * Antes eran dos arreglos de booleanos en paralelo (`numeric[]` y `code[]`)
 * indexados por posicion, con la regla implicita de que `code` solo vale si
 * `numeric` tambien: tres estados escondidos en dos banderas que habia que
 * leer juntas y en orden. Un solo arreglo de esta union dice lo mismo sin que
 * el que lo lee tenga que reconstruir la regla.
 */
type ColumnKind = 'text' | 'numeric' | 'code'

/**
 * Una columna es `code` si toda celda con contenido es un entero corto,
 * `numeric` si toda celda con contenido parece una cifra, y `text` si alguna no
 * lo es. Una columna sin ninguna celda con contenido cae en `code`, que es
 * donde caia con las dos banderas.
 */
function columnKindOf(sample: readonly string[][], column: number): ColumnKind {
  const filled = sample.map((row) => row[column]?.trim() ?? '').filter((cell) => cell !== '')
  if (!filled.every((cell) => NUMERIC.test(cell))) return 'text'
  return filled.every((cell) => CODE.test(cell)) ? 'code' : 'numeric'
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Los bytes del archivo no son UTF-8 válido. */
class CsvEncodingError extends Schema.TaggedError<CsvEncodingError>()('CsvEncodingError', {
  cause: Schema.Defect(),
}) {}

/**
 * El texto del archivo. La lectura estricta separa «esto es UTF-8» de «esto no
 * lo es»; el `catchTag` deja escrito que lo segundo se sigue pintando con
 * reemplazos, que es exactamente lo que hacía la única lectura de antes.
 */
const readCsvText = Effect.fn('CsvViewer.readText')(function* (
  bytes: ArrayBuffer
): Effect.fn.Return<string> {
  return yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: (cause) => new CsvEncodingError({ cause }),
  }).pipe(
    Effect.catchTag('CsvEncodingError', () =>
      Effect.sync(() => new TextDecoder('utf-8').decode(bytes))
    )
  )
})

type CsvTable = {
  readonly header: readonly string[]
  readonly body: readonly (readonly string[])[]
  readonly total: number
  readonly columns: number
  readonly kinds: readonly ColumnKind[]
}

/**
 * El ancho de la tabla es el de la fila más ancha, no el del encabezado. Con el
 * encabezado como medida, un CSV cuya primera fila es un título de una sola
 * celda —lo normal en un balance exportado de Excel— perdía todas las columnas
 * siguientes: se pintaban una, sin decir que las demás existían.
 */
const buildCsvTable = Effect.fn('CsvViewer.buildTable')(function* (
  bytes: ArrayBuffer
): Effect.fn.Return<CsvTable> {
  const rows = parseCsv(yield* readCsvText(bytes))
  const [header = [], ...body] = rows
  const columns = body.reduce((widest, row) => Math.max(widest, row.length), header.length)
  const sample = body.slice(0, 50)
  const kinds = Array.from({ length: columns }, (_, col) => columnKindOf(sample, col))
  return { header, body: body.slice(0, MAX_ROWS), total: body.length, columns, kinds }
})

export interface CsvViewerProps {
  viewUrl: string
  chrome?: ViewerChromeProps
}

/**
 * Tabla inerte para CSV: el texto se parsea en cliente y cada celda se pinta
 * como texto, nunca como HTML. El visor no interpreta convenciones numéricas:
 * `1.234,56` y `1,234.56` se preservan byte a byte en pantalla hasta que el
 * archivo declare una convención. El mono queda para códigos de cuenta.
 */
export function CsvViewer({ viewUrl, chrome }: CsvViewerProps) {
  const t = useTranslations('vdr.viewer')
  const bytes = useDocumentBytes(viewUrl)
  const source = bytes.status === 'ready' ? bytes.bytes : null

  // La tabla queda ATADA a los bytes que la produjeron, como el desenlace de
  // `ImageViewer` a su URL: unos bytes nuevos (un reintento emite un grant
  // nuevo) no pueden seguir pintando la tabla del documento anterior.
  const [built, setBuilt] = useState<{ source: ArrayBuffer; table: CsvTable } | null>(null)
  const table = source !== null && built?.source === source ? built.table : null

  const onReady = chrome?.onReady
  useEffect(() => {
    if (source === null) return
    const fiber = runClientFork(buildCsvTable(source))
    fiber.addObserver((exit) => {
      // Interrumpida por un documento nuevo o por el unmount: no hay tabla que
      // pintar y tampoco se avisa que el visor está listo.
      if (!Exit.isSuccess(exit)) return
      setBuilt({ source, table: exit.value })
      onReady?.()
    })
    return () => fiber.interruptUnsafe()
  }, [source, onReady])

  if (bytes.status === 'error')
    return <ViewerError testId="document-viewer-error" chrome={chrome} />

  return (
    <ViewerFrame
      testId="document-viewer-csv"
      chrome={chrome}
      indicator={table ? t('rows', { count: table.total }) : undefined}
    >
      {!table ? (
        <ViewerLoading testId="document-viewer-frame-loading" label={t('loading')} />
      ) : (
        // Region etiquetada y alcanzable por teclado: es una tabla de dos
        // dimensiones y el scroll no puede depender del de la pagina.
        <div
          role="region"
          tabIndex={0}
          aria-label={t('tableRegion', { name: chrome?.fileName ?? '' })}
          className="focus-visible:ring-ring/50 border-border h-full overflow-auto overscroll-contain border-b outline-none focus-visible:ring-2"
        >
          <table className="w-full border-collapse text-sm">
            <thead className="bg-card sticky top-0 z-10">
              <tr>
                {table.kinds.map((kind, i) => (
                  <th
                    key={i}
                    scope="col"
                    className={`border-border text-muted-foreground border-b px-3 py-2 text-xs font-medium ${kind === 'numeric' ? 'text-right' : 'text-left'}`}
                  >
                    {table.header[i] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.body.map((r, ri) => (
                <tr key={ri} className="hover:bg-muted/40">
                  {table.kinds.map((kind, ci) => (
                    <td
                      key={ci}
                      className={`border-border border-b px-3 py-1.5 ${
                        kind === 'code'
                          ? 'font-mono whitespace-nowrap tabular-nums'
                          : kind === 'numeric'
                            ? 'text-right whitespace-nowrap lining-nums tabular-nums'
                            : ''
                      }`}
                    >
                      {r[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.total > MAX_ROWS ? (
            <p className="text-muted-foreground px-3 py-3 text-xs">
              {t('rowsTruncated', { shown: MAX_ROWS, count: table.total })}
            </p>
          ) : null}
        </div>
      )}
    </ViewerFrame>
  )
}
