import { describe, expect, it } from 'vitest'

import { resolveTemporaryIntakeContentType } from '@/lib/intake/upload-policy'

describe('resolveTemporaryIntakeContentType', () => {
  it.each(['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'])(
    'normalizes CSV alias %s to text/csv',
    (type) => {
      expect(resolveTemporaryIntakeContentType({ name: 'balance.csv', type })).toBe('text/csv')
      expect(resolveTemporaryIntakeContentType({ name: 'BALANCE.CSV', type })).toBe('text/csv')
    }
  )

  it('does not let a .csv inherit a MIME that is not a CSV alias', () => {
    expect(resolveTemporaryIntakeContentType({ name: 'balance.csv', type: 'image/png' })).toBeNull()
    expect(
      resolveTemporaryIntakeContentType({
        name: 'balance.csv',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    ).toBeNull()
  })

  it('keeps real Excel declarations on .xls and rejects them on .xlsx', () => {
    expect(
      resolveTemporaryIntakeContentType({
        name: 'modelo.xls',
        type: 'application/vnd.ms-excel',
      })
    ).toBe('application/vnd.ms-excel')
    expect(
      resolveTemporaryIntakeContentType({
        name: 'modelo.xlsx',
        type: 'application/vnd.ms-excel',
      })
    ).toBeNull()
    expect(
      resolveTemporaryIntakeContentType({
        name: 'modelo.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('fills an empty type from the extension and rejects unknown names', () => {
    expect(resolveTemporaryIntakeContentType({ name: 'memo.pdf', type: '' })).toBe(
      'application/pdf'
    )
    expect(
      resolveTemporaryIntakeContentType({ name: 'memo.pdf', type: 'application/zip' })
    ).toBeNull()
    expect(resolveTemporaryIntakeContentType({ name: 'archivo', type: 'text/csv' })).toBeNull()
    expect(resolveTemporaryIntakeContentType({ name: 'sala.zip', type: '' })).toBeNull()
  })
})
