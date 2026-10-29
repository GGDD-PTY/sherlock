// ============================================================================
// CURRENCIES CONSTANTS UNIT TESTS
// ============================================================================
// Tests for currency constants and helper functions
// Covers: CURRENCIES, isValidCurrency
// ============================================================================

import { describe, it, expect } from 'vitest'
import { CURRENCIES, isValidCurrency } from '@/lib/constants/currencies'

describe('lib/constants/currencies.ts', () => {
  // ============================================================================
  // CURRENCIES TESTS
  // ============================================================================
  describe('CURRENCIES', () => {
    // ===== TEST: CONTAINS EXPECTED CURRENCIES =====
    it('contains expected Latin American currencies', () => {
      const values = CURRENCIES.map((c) => c.value)

      expect(values).toContain('USD')
      expect(values).toContain('MXN')
      expect(values).toContain('COP')
      expect(values).toContain('PEN')
      expect(values).toContain('CLP')
      expect(values).toContain('ARS')
      expect(values).toContain('BRL')
    })

    // ===== TEST: ALL CURRENCIES HAVE REQUIRED FIELDS =====
    it('all currencies have value, label, and symbol', () => {
      for (const currency of CURRENCIES) {
        expect(currency.value).toBeDefined()
        expect(typeof currency.value).toBe('string')
        expect(currency.value.length).toBe(3) // ISO 4217 format
        expect(currency.label).toBeDefined()
        expect(currency.symbol).toBeDefined()
      }
    })

    // ===== TEST: CORRECT SYMBOLS =====
    it('has correct symbols for currencies', () => {
      const usd = CURRENCIES.find((c) => c.value === 'USD')
      const pen = CURRENCIES.find((c) => c.value === 'PEN')
      const brl = CURRENCIES.find((c) => c.value === 'BRL')

      expect(usd?.symbol).toBe('$')
      expect(pen?.symbol).toBe('S/')
      expect(brl?.symbol).toBe('R$')
    })
  })

  // ============================================================================
  // isValidCurrency TESTS
  // ============================================================================
  describe('isValidCurrency', () => {
    // ===== TEST: RETURNS TRUE FOR VALID CURRENCIES =====
    it('returns true for valid currency codes', () => {
      expect(isValidCurrency('USD')).toBe(true)
      expect(isValidCurrency('MXN')).toBe(true)
      expect(isValidCurrency('BRL')).toBe(true)
    })

    // ===== TEST: RETURNS FALSE FOR INVALID CURRENCIES =====
    it('returns false for invalid currency codes', () => {
      expect(isValidCurrency('XXX')).toBe(false)
      expect(isValidCurrency('')).toBe(false)
      expect(isValidCurrency('usd')).toBe(false) // Case sensitive
    })
  })
})
