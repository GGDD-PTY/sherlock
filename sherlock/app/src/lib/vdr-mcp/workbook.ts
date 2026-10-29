// ============================================================================
// VDR READ MCP — XLSX reading (Node runtime only)
// ============================================================================
// Every `modelo_*` answer comes from the real workbook: sheet names, ranges,
// formulas and defined names are resolved against the loaded blob, never
// guessed. A range the workbook does not contain is a correctable error, not
// an empty answer, so the agent can fix its own call.
//
// The engine is loaded through a dynamic import behind a port so tests can
// inject a fake and the heavy native/WASM dependency never enters a module
// graph a client bundle can reach.
// ============================================================================

import { Effect, Predicate, Schema, type Scope } from 'effect'

import { VdrToolError } from '@/lib/vdr-mcp/errors'

export const MODEL_MAX_CELLS_PER_CALL = 200
const MODEL_MAX_ROWS_PER_PAGE = 50
const MODEL_MAX_SHEETS = 200
const MODEL_MAX_BYTES = 32 * 1024 * 1024

const A1_CELL = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/
const A1_RANGE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}):\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/

export type WorkbookCell = Readonly<{
  celda: string
  valor: string | number | boolean | null
  formula: string | null
}>

export type WorkbookSheetPort = Readonly<{
  summarize: () => Promise<string>
  describeRange: (range: string) => Promise<string>
  getValue: (address: string) => Promise<unknown>
  getFormula: (address: string) => Promise<string | null>
}>

export type WorkbookPort = Readonly<{
  sheetNames: string[]
  sheet: (name: string) => Promise<WorkbookSheetPort>
  definedNames: () => Promise<Array<{ name: string; reference: string }>>
  dispose: () => void
}>

export type WorkbookLoader = (bytes: Uint8Array) => Promise<WorkbookPort>

/**
 * Why the workbook failed, from the client agent's point of view. `open` means
 * the engine could not open this book — the agent can act on that by trying
 * another document. `internal` is ours: a normalization, a disposal or an
 * engine call that broke on our side and tells the agent nothing it can use.
 * `errors.ts` reads this field to pick the tool error code.
 */
export type WorkbookErrorReason = 'open' | 'internal'

export class WorkbookError extends Schema.TaggedError<WorkbookError>()('WorkbookError', {
  operation: Schema.String,
  reason: Schema.Literals(['open', 'internal']),
  message: Schema.String,
  engineCode: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// Duck-type de `isMogSdkError` (`code` y `message` string) sin importar el
// SDK: `@mog-sdk/sdk` es la ruta del WASM y no entra en este grafo.
function mogEngineFields(cause: unknown): { message: string; engineCode?: string } {
  if (
    Predicate.isObject(cause) &&
    Predicate.isString(cause.code) &&
    Predicate.isString(cause.message)
  ) {
    return { message: cause.message, engineCode: cause.code }
  }
  return {
    message: Predicate.isError(cause) ? cause.message : String(cause),
  }
}

// Códigos del SDK que hablan del motor, no del archivo: un addon nativo que no
// carga, un transporte roto o un proveedor caído. Salían como «el archivo está
// dañado» y mandaban al agente a probar otro documento; son nuestros.
const ENGINE_RUNTIME_CODES: ReadonlySet<string> = new Set([
  'INTERNAL_ERROR',
  'TRANSPORT_ERROR',
  'BRIDGE_NOT_AVAILABLE',
  'PROVIDER_ERROR',
])

function workbookError(
  operation: string,
  cause: unknown,
  reason: WorkbookErrorReason = 'internal'
): WorkbookError {
  const fields = mogEngineFields(cause)
  return new WorkbookError({
    operation,
    reason:
      fields.engineCode !== undefined && ENGINE_RUNTIME_CODES.has(fields.engineCode)
        ? 'internal'
        : reason,
    message: fields.message,
    ...(fields.engineCode === undefined ? {} : { engineCode: fields.engineCode }),
    ...(cause === undefined ? {} : { cause }),
  })
}

const workbookPromise = Effect.fn('VdrWorkbook.promise')(
  <A>(operation: string, run: () => PromiseLike<A>, reason: WorkbookErrorReason = 'internal') =>
    Effect.tryPromise({
      try: () => run(),
      catch: (cause) =>
        cause instanceof VdrToolError ? cause : workbookError(operation, cause, reason),
    })
)

function columnIndex(letters: string): number {
  return [...letters.toUpperCase()].reduce(
    (total, letter) => total * 26 + (letter.charCodeAt(0) - 64),
    0
  )
}

export type ParsedRange = Readonly<{
  normalized: string
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
  cells: number
}>

/** Parse and normalize an A1 range (or a single cell treated as a 1x1 range). */
function parseA1Range(value: string): ParsedRange | null {
  const trimmed = value.trim().replace(/\$/g, '').toUpperCase()
  const range = A1_RANGE.exec(trimmed)
  if (range) {
    const startColumn = Math.min(columnIndex(range[1]), columnIndex(range[3]))
    const endColumn = Math.max(columnIndex(range[1]), columnIndex(range[3]))
    const startRow = Math.min(Number(range[2]), Number(range[4]))
    const endRow = Math.max(Number(range[2]), Number(range[4]))
    return {
      normalized: `${range[1]}${range[2]}:${range[3]}${range[4]}`,
      startColumn,
      startRow,
      endColumn,
      endRow,
      cells: (endColumn - startColumn + 1) * (endRow - startRow + 1),
    }
  }
  const cell = A1_CELL.exec(trimmed)
  if (!cell) return null
  const column = columnIndex(cell[1])
  const row = Number(cell[2])
  return {
    normalized: `${cell[1]}${cell[2]}`,
    startColumn: column,
    startRow: row,
    endColumn: column,
    endRow: row,
    cells: 1,
  }
}

function columnLetter(index: number): string {
  let remaining = index
  let letters = ''
  while (remaining > 0) {
    const rest = (remaining - 1) % 26
    letters = String.fromCharCode(65 + rest) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

/** Resolve a sheet by exact name, then case-insensitively; else a listing error. */
export const requireSheetEffect = Effect.fn('VdrWorkbook.requireSheet')(function* (
  workbook: WorkbookPort,
  name: string
): Effect.fn.Return<{ sheet: WorkbookSheetPort; name: string }, VdrToolError | WorkbookError> {
  const exact = workbook.sheetNames.find((candidate) => candidate === name)
  const insensitive = workbook.sheetNames.find(
    (candidate) => candidate.toLowerCase() === name.trim().toLowerCase()
  )
  const resolved = exact ?? insensitive
  if (!resolved) {
    return yield* new VdrToolError(
      'HOJA_DESCONOCIDA',
      `La hoja «${name}» no existe en este modelo.`,
      'Llama modelo_hojas para ver los nombres exactos de las hojas.',
      workbook.sheetNames
    )
  }
  const sheet = yield* workbookPromise('workbook.sheet', () => workbook.sheet(resolved))
  return { sheet, name: resolved }
})

export const requireRangeEffect = Effect.fn('VdrWorkbook.requireRange')(function* (
  range: string
): Effect.fn.Return<ParsedRange, VdrToolError> {
  const parsed = parseA1Range(range)
  if (!parsed) {
    return yield* new VdrToolError(
      'RANGO_INVALIDO',
      `«${range}» no es un rango A1 válido.`,
      'Usa notación A1, por ejemplo C5 o A4:F15.'
    )
  }
  if (parsed.cells > MODEL_MAX_CELLS_PER_CALL) {
    return yield* new VdrToolError(
      'RANGO_DEMASIADO_GRANDE',
      `El rango ${parsed.normalized} pide ${parsed.cells} celdas y el máximo por llamada es ${MODEL_MAX_CELLS_PER_CALL}.`,
      `Divide la consulta en bloques de hasta ${MODEL_MAX_ROWS_PER_PAGE} filas y vuelve a llamar modelo_rango.`
    )
  }
  return parsed
})

// Cómo se ve en la celda cada error de Excel. Es la misma tabla de
// `errorDisplayString()` del SDK de MOG, escrita aquí porque el SDK entra por
// `import()` dinámico — es la ruta del WASM — y `toCellValue` es síncrona.
// `Circ` comparte display con `Ref`, igual que en el SDK.
const CELL_ERROR_DISPLAY: Readonly<Record<string, string>> = {
  Null: '#NULL!',
  Div0: '#DIV/0!',
  Value: '#VALUE!',
  Ref: '#REF!',
  Name: '#NAME?',
  Num: '#NUM!',
  Na: '#N/A',
  GettingData: '#GETTING_DATA',
  Spill: '#SPILL!',
  Calc: '#CALC!',
  Circ: '#REF!',
}

/**
 * El único valor no primitivo que MOG devuelve por `getValue` es su celda de
 * error: `{ type: 'error', value: ErrorVariant }`. Sin esta rama, el agente del
 * cliente leía `[object Object]` en toda celda con `#REF!` o `#DIV/0!` — el
 * modelo se veía sano y no lo estaba. Ahora lee lo mismo que un humano ve en
 * Excel. Cualquier otra forma no primitiva se reporta como celda vacía en vez
 * de filtrar la representación interna de un objeto de JavaScript.
 */
function toCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return value
  if (Predicate.isString(value)) return value.length > 512 ? `${value.slice(0, 509)}...` : value
  if (Predicate.isObject(value) && value.type === 'error') {
    const variant = value.value
    return Predicate.isString(variant) ? (CELL_ERROR_DISPLAY[variant] ?? '#CALC!') : '#CALC!'
  }
  return null
}

/** Read every cell of a bounded range, with its formula when it has one. */
export const readRangeCellsEffect = Effect.fn('VdrWorkbook.readRangeCells')(function* (
  sheet: WorkbookSheetPort,
  range: ParsedRange
): Effect.fn.Return<WorkbookCell[], WorkbookError | VdrToolError> {
  const cells: WorkbookCell[] = []
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      const address = `${columnLetter(column)}${row}`
      const [valor, formula] = yield* Effect.all(
        [
          workbookPromise('sheet.getValue', () => sheet.getValue(address)),
          workbookPromise('sheet.getFormula', () => sheet.getFormula(address)),
        ] as const,
        { concurrency: 'unbounded' }
      )
      const cell = yield* Effect.try({
        try: () => ({
          celda: address,
          valor: toCellValue(valor),
          formula: formula ?? null,
        }),
        catch: (cause) => workbookError('cell.normalize', cause),
      })
      cells.push(cell)
    }
  }
  return cells
})

function splitReferenceValue(reference: string): { sheet: string; range: string } | null {
  const withoutEquals = reference.trim().replace(/^=/, '')
  const separator = withoutEquals.lastIndexOf('!')
  if (separator <= 0) return null
  const sheet = withoutEquals.slice(0, separator).replace(/^'/, '').replace(/'$/, '')
  const range = withoutEquals.slice(separator + 1).replace(/\$/g, '')
  if (sheet.length === 0 || !parseA1Range(range)) return null
  return { sheet, range }
}

/** Split a `Sheet!$A$1:$B$2` reference into its parts. */
// Sin `yield`: el cuerpo es puro y oxlint (require-yield) rechaza un generador
// que no cede. La flecha con `Effect.sync` es la forma que AGENTS.md admite
// para envolver un cálculo síncrono.
export const splitReferenceEffect = Effect.fn('VdrWorkbook.splitReference')((reference: string) =>
  Effect.sync(() => splitReferenceValue(reference))
)

// ===== the real engine, behind the port =====

const openWorkbookWithMogEffect = Effect.fn('VdrWorkbook.openWithMog')(function* (
  bytes: Uint8Array
): Effect.fn.Return<WorkbookPort, WorkbookError | VdrToolError> {
  if (bytes.byteLength > MODEL_MAX_BYTES) {
    return yield* new VdrToolError(
      'ARCHIVO_DEMASIADO_GRANDE',
      'El modelo excede el tamaño máximo que esta sala puede abrir.',
      'Pide un modelo más pequeño o consulta el resumen del documento.'
    )
  }
  const { createWorkbook } = yield* workbookPromise('mog.import', () => import('@mog-sdk/sdk'))
  const workbook = yield* workbookPromise('mog.createWorkbook', () => createWorkbook(bytes), 'open')
  return yield* Effect.try({
    try: (): WorkbookPort => {
      const sheetNames = workbook.sheetNames.slice(0, MODEL_MAX_SHEETS)
      return {
        sheetNames,
        sheet: async (name) => {
          const { sheet } = await workbook.getOrCreateSheet(name)
          return {
            summarize: async () => String(await sheet.summarize()),
            describeRange: async (range) => String(await sheet.describeRange(range)),
            getValue: async (address) => (await sheet.getValue(address)) as unknown,
            getFormula: async (address) => sheet.getFormula(address),
          }
        },
        definedNames: async () =>
          (await workbook.names.list()).map((entry) => ({
            name: entry.name,
            reference: entry.reference,
          })),
        dispose: () => workbook.dispose(),
      }
    },
    catch: (cause) => workbookError('mog.port', cause, 'open'),
  }).pipe(
    Effect.tapError(() =>
      Effect.try({
        try: () => workbook.dispose(),
        catch: (cause) => workbookError('mog.disposeAfterOpenFailure', cause),
      }).pipe(Effect.ignore)
    )
  )
})

const releaseWorkbook = Effect.fn('VdrWorkbook.release')(function* (workbook: WorkbookPort) {
  return yield* Effect.try({
    try: () => workbook.dispose(),
    catch: (cause) => workbookError('workbook.dispose', cause),
  })
}, Effect.orDie)

/**
 * Acquire either the injected loader or MOG in the current Scope. Closing the
 * scope disposes the workbook on success, failure, or interruption.
 */
export const loadWorkbookScoped = Effect.fn('VdrWorkbook.loadScoped')(function* (
  bytes: Uint8Array,
  loader?: WorkbookLoader
): Effect.fn.Return<WorkbookPort, WorkbookError | VdrToolError, Scope.Scope> {
  const acquire = loader
    ? workbookPromise('workbook.loader', () => loader(bytes), 'open')
    : openWorkbookWithMogEffect(bytes)
  return yield* Effect.acquireRelease(acquire, releaseWorkbook)
})

export const requireWorkbookDocumentEffect = Effect.fn('VdrWorkbook.requireDocument')(function* (
  mimeType: string
): Effect.fn.Return<void, VdrToolError> {
  const base = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const supported =
    base === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    base === 'application/vnd.ms-excel'
  if (!supported) {
    yield* new VdrToolError(
      'FORMATO_NO_SOPORTADO',
      `El documento indicado es ${mimeType}, no una hoja de cálculo.`,
      'Usa documento_buscar o documento_fragmento para documentos de texto, y modelo_* solo para archivos XLSX.'
    )
  }
})
