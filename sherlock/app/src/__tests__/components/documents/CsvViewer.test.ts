import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

const mockBytes = vi.hoisted(() => ({
  value: { status: 'ready', bytes: new Uint8Array() } as
    { status: 'ready'; bytes: Uint8Array } | { status: 'error' },
}))

vi.mock('@/components/documents/viewers/useDocumentBytes', () => ({
  useDocumentBytes: () => mockBytes.value,
}))

import { CsvViewer, parseCsv } from '@/components/documents/viewers/CsvViewer'
import { resolveDocumentViewerKind } from '@/components/documents/viewers/mime'

describe('CsvViewer', () => {
  it('parses quoted commas, escaped quotes and CRLF rows', () => {
    const rows = parseCsv(
      'codigo,cuenta,debito\r\n1100,"Caja, bancos",1000\n1200,"Dice ""hola""",\n'
    )
    expect(rows).toEqual([
      ['codigo', 'cuenta', 'debito'],
      ['1100', 'Caja, bancos', '1000'],
      ['1200', 'Dice "hola"', ''],
    ])
  })

  it('keeps a quoted newline inside a cell and drops blank rows', () => {
    expect(parseCsv('cuenta,nota\n"Caja\nbancos",ok\n\n,\n')).toEqual([
      ['cuenta', 'nota'],
      ['Caja\nbancos', 'ok'],
    ])
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\r\n')).toEqual([])
  })

  it('routes text/csv and .csv to the table renderer', () => {
    expect(resolveDocumentViewerKind('text/csv', 'balance.csv')).toBe('csv')
    expect(resolveDocumentViewerKind('application/octet-stream', 'balance.csv')).toBe('csv')
    expect(resolveDocumentViewerKind('text/html', 'x.html')).toBe('download')
  })

  it('preserves locale-shaped financial source text verbatim', () => {
    mockBytes.value = {
      status: 'ready',
      bytes: new TextEncoder().encode('Cuenta,Importe\nIngresos,"1.234,56"\n'),
    }

    render(
      createElement(CsvViewer, {
        viewUrl: '/grant/csv',
        chrome: { fileName: 'modelo.csv', kind: 'csv' },
      })
    )

    expect(screen.getByRole('cell', { name: '1.234,56' })).toBeInTheDocument()
    expect(screen.getByRole('region')).toHaveAttribute('tabindex', '0')
  })

  // Un CSV en Latin-1 (lo que exporta Excel en la región) falla la lectura
  // estricta de UTF-8. `readCsvText` nombra ese fallo (`CsvEncodingError`) y
  // cae a la lectura de reemplazo en vez de dejar la fibra sin recuperar — si
  // ese `catchTag` se pierde, la tabla se queda en "cargando" para siempre
  // porque `Exit.isSuccess` nunca es true. Ver research/BUGS.md, visores.
  it('falls back to lossy decoding instead of hanging when bytes are not valid UTF-8', async () => {
    // 0xE1 solo (á en Latin-1) es una secuencia UTF-8 inválida por sí sola.
    mockBytes.value = {
      status: 'ready',
      bytes: new Uint8Array([...new TextEncoder().encode('Cuenta,Nota\nCaja,'), 0xe1, 0x0a]),
    }

    render(
      createElement(CsvViewer, {
        viewUrl: '/grant/csv-latin1',
        chrome: { fileName: 'balance.csv', kind: 'csv' },
      })
    )

    expect(await screen.findByRole('cell', { name: 'Caja' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/cargando/i)).not.toBeInTheDocument()
  })
})
