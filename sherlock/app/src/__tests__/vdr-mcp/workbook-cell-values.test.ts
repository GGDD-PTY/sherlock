// @vitest-environment node
// ============================================================================
// VDR READ MCP — QUÉ LEE EL AGENTE EN UNA CELDA
// ============================================================================
// `sheet.getValue` del puerto de MOG devuelve `unknown`, y el único valor no
// primitivo que llega por ahí es su celda de error:
// `{ type: 'error', value: ErrorVariant }`. Antes caía en `String(value)` y el
// agente del cliente leía `[object Object]` en toda celda con `#REF!` o
// `#DIV/0!` — un modelo roto se veía sano. Estas pruebas fijan el contrato:
// una celda de error se lee como en Excel, y ninguna otra forma no primitiva
// filtra la representación interna de un objeto de JavaScript.
// ============================================================================

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  loadWorkbookScoped,
  readRangeCellsEffect,
  type ParsedRange,
  type WorkbookSheetPort,
} from '@/lib/vdr-mcp/workbook'

/** Una celda: A1:A1. */
const ONE_CELL: ParsedRange = {
  normalized: 'A1:A1',
  startColumn: 1,
  startRow: 1,
  endColumn: 1,
  endRow: 1,
  cells: 1,
}

function sheetReturning(value: unknown): WorkbookSheetPort {
  return {
    summarize: () => Promise.resolve(''),
    describeRange: () => Promise.resolve(''),
    getValue: () => Promise.resolve(value),
    getFormula: () => Promise.resolve(null),
  }
}

/** Sin argumento: la hoja no devolvió nada para esa celda. */
async function readOne(...value: [unknown] | []) {
  const cells = await Effect.runPromise(readRangeCellsEffect(sheetReturning(value[0]), ONE_CELL))
  return cells[0]?.valor
}

describe('lo que el agente lee en una celda', () => {
  it('traduce cada error de MOG al texto que un humano ve en Excel', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Null', '#NULL!'],
      ['Div0', '#DIV/0!'],
      ['Value', '#VALUE!'],
      ['Ref', '#REF!'],
      ['Name', '#NAME?'],
      ['Num', '#NUM!'],
      ['Na', '#N/A'],
      ['GettingData', '#GETTING_DATA'],
      ['Spill', '#SPILL!'],
      ['Calc', '#CALC!'],
      ['Circ', '#REF!'],
    ]
    for (const [variant, display] of cases) {
      expect(await readOne({ type: 'error', value: variant })).toBe(display)
    }
  })

  it('nunca devuelve [object Object]', async () => {
    expect(await readOne({ type: 'error', value: 'Ref' })).not.toContain('[object')
    expect(await readOne({ type: 'error', value: 'Ref', message: 'circular' })).toBe('#REF!')
  })

  it('una variante que el SDK todavía no publica cae en #CALC!, no en el objeto', async () => {
    expect(await readOne({ type: 'error', value: 'VarianteFutura' })).toBe('#CALC!')
    expect(await readOne({ type: 'error' })).toBe('#CALC!')
  })

  it('cualquier otra forma no primitiva se reporta como celda vacía', async () => {
    expect(await readOne({ hoja: 'Supuestos', fila: 4 })).toBeNull()
    expect(await readOne([1, 2, 3])).toBeNull()
    expect(await readOne(new Date('2026-09-08'))).toBeNull()
  })

  it('los primitivos siguen intactos, y una cadena larga se corta en 512', async () => {
    expect(await readOne(6740)).toBe(6740)
    expect(await readOne(false)).toBe(false)
    expect(await readOne(null)).toBeNull()
    expect(await readOne()).toBeNull()
    expect(await readOne('Ingresos')).toBe('Ingresos')

    const long = await readOne('x'.repeat(600))
    expect(long).toHaveLength(512)
    expect(String(long).endsWith('...')).toBe(true)
  })
})

describe('WorkbookError.engineCode', () => {
  it('copies code and message from a duck-typed motor error', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        loadWorkbookScoped(new Uint8Array([1]), async () => {
          // El motor Mog lanza objetos planos, no Error; el test fija que engineCode los copie.
          // oxlint-disable-next-line no-throw-literal, only-throw-error
          throw { code: 'IMPORT_ERROR', message: 'wasm failed' }
        })
      ).pipe(
        Effect.match({
          onSuccess: () => null,
          onFailure: (error) => error,
        })
      )
    )
    expect(failure).toMatchObject({
      _tag: 'WorkbookError',
      reason: 'open',
      operation: 'workbook.loader',
      engineCode: 'IMPORT_ERROR',
      message: 'wasm failed',
    })
  })

  it('omits engineCode when the cause has no motor shape', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        loadWorkbookScoped(new Uint8Array([1]), async () => {
          throw new Error('not mog')
        })
      ).pipe(
        Effect.match({
          onSuccess: () => null,
          onFailure: (error) => error,
        })
      )
    )
    expect(failure).toMatchObject({
      _tag: 'WorkbookError',
      reason: 'open',
      operation: 'workbook.loader',
      message: 'not mog',
    })
    expect(failure).not.toHaveProperty('engineCode')
  })
})
