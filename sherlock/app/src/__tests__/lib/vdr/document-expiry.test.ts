import { describe, expect, it } from 'vitest'

import { endOfLocalDayTimestamp, toDateInputValue } from '../../../components/company/vdr/helpers'

describe('VDR document expiry', () => {
  it('keeps the selected calendar day through the end of the user local day', () => {
    const timestamp = endOfLocalDayTimestamp('2026-08-15')
    const expiry = new Date(timestamp)

    expect(expiry.getFullYear()).toBe(2026)
    expect(expiry.getMonth()).toBe(7)
    expect(expiry.getDate()).toBe(15)
    expect(expiry.getHours()).toBe(23)
    expect(expiry.getMinutes()).toBe(59)
    expect(expiry.getSeconds()).toBe(59)
    expect(expiry.getMilliseconds()).toBe(999)
    expect(toDateInputValue(timestamp)).toBe('2026-08-15')
  })

  it.each(['', '2026-02-30', '15-08-2026'])('rejects invalid calendar input %j', (value) => {
    expect(() => endOfLocalDayTimestamp(value)).toThrow(/fecha/i)
  })
})
