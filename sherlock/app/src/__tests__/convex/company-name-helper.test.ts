import { describe, expect, it } from 'vitest'

import { COMPANY_NAME_MAX_LENGTH, normalizeCompanyName } from '../../../convex/_helpers/companyName'

describe('normalizeCompanyName', () => {
  it('collapses whitespace and normalizes to NFKC', () => {
    expect(normalizeCompanyName('  Sample   Hydro  ')).toBe('Sample Hydro')
    expect(normalizeCompanyName('Ｓａｍｐｌｅ')).toBe('Sample')
  })

  it('is idempotent over an already normalized name', () => {
    const once = normalizeCompanyName(' Grupo  SAMPLE ')
    expect(once).toBe('Grupo SAMPLE')
    expect(normalizeCompanyName(once)).toBe(once)
  })

  it('accepts a name exactly at the bound and rejects one past it', () => {
    expect(normalizeCompanyName('a'.repeat(COMPANY_NAME_MAX_LENGTH))).toHaveLength(
      COMPANY_NAME_MAX_LENGTH
    )
    expect(normalizeCompanyName('a'.repeat(COMPANY_NAME_MAX_LENGTH + 1))).toBeUndefined()
  })

  it('rejects empty, missing, and control-character names', () => {
    expect(normalizeCompanyName('')).toBeUndefined()
    expect(normalizeCompanyName('   ')).toBeUndefined()
    expect(normalizeCompanyName(undefined)).toBeUndefined()
    expect(normalizeCompanyName(null)).toBeUndefined()
    expect(normalizeCompanyName('Sam\u0007ple')).toBeUndefined()
  })
})
