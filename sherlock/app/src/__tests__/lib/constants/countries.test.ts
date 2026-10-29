// ============================================================================
// COUNTRIES CONSTANTS UNIT TESTS
// ============================================================================
// Tests for country constants and helper functions
// Covers: COUNTRIES, helper functions
// ============================================================================

import { describe, it, expect } from 'vitest'
import { COUNTRIES, getCountryLabel, isValidCountry } from '@/lib/constants/countries'

describe('lib/constants/countries.ts', () => {
  // ============================================================================
  // COUNTRIES TESTS
  // ============================================================================
  describe('COUNTRIES', () => {
    // ===== TEST: CONTAINS EXPECTED COUNTRIES =====
    it('contains Latin American countries', () => {
      const values = COUNTRIES.map((c) => c.value)

      expect(values).toContain('MX') // México
      expect(values).toContain('CO') // Colombia
      expect(values).toContain('PE') // Perú
      expect(values).toContain('CL') // Chile
      expect(values).toContain('AR') // Argentina
      expect(values).toContain('PA') // Panamá
      expect(values).not.toContain('BR') // Brasil is outside the initial launch perimeter
    })

    // ===== TEST: INCLUDES OTHER OPTION =====
    it("includes 'OTHER' option", () => {
      const other = COUNTRIES.find((c) => c.value === 'OTHER')

      expect(other).toBeDefined()
      expect(other?.label).toBe('Otro')
    })

    // ===== TEST: ALL COUNTRIES HAVE REQUIRED FIELDS =====
    it('all countries have value, localized labels, and currency', () => {
      for (const country of COUNTRIES) {
        expect(country.value).toBeDefined()
        expect(typeof country.value).toBe('string')
        expect(country.label).toBeDefined()
        expect(typeof country.label).toBe('string')
        expect(country.labelEn).toBeDefined()
        expect(typeof country.labelEn).toBe('string')
        expect(country.currency).toBeDefined()
        expect(typeof country.currency).toBe('string')
      }
    })

    // ===== TEST: CORRECT CURRENCIES =====
    it('has correct default currencies for countries', () => {
      const mexico = COUNTRIES.find((c) => c.value === 'MX')
      const colombia = COUNTRIES.find((c) => c.value === 'CO')
      const panama = COUNTRIES.find((c) => c.value === 'PA')
      const chile = COUNTRIES.find((c) => c.value === 'CL')

      expect(mexico?.currency).toBe('MXN')
      expect(colombia?.currency).toBe('COP')
      expect(panama?.currency).toBe('USD') // Uses USD
      expect(chile?.currency).toBe('CLP')
    })
  })

  // ============================================================================
  // getCountryLabel TESTS
  // ============================================================================
  describe('getCountryLabel', () => {
    // ===== TEST: RETURNS LABEL FOR VALID COUNTRY =====
    it('returns label for valid country code', () => {
      expect(getCountryLabel('MX')).toBe('México')
      expect(getCountryLabel('CO')).toBe('Colombia')
      expect(getCountryLabel('PA')).toBe('Panamá')
    })

    // ===== CANDADO: EL CÓDIGO SIEMPRE RINDE ESPAÑOL =====
    // [F] 2026-09-03: no hay segundo locale. La fila todavía guarda `labelEn`,
    // así que lo que se pinnea es que `getCountryLabel` nunca lo devuelve.
    it('never returns the English name of a country code', () => {
      expect(getCountryLabel('MX')).toBe('México')
      expect(getCountryLabel('PE')).toBe('Perú')
      expect(getCountryLabel('PA')).toBe('Panamá')
      expect(getCountryLabel('OTHER')).toBe('Otro')
    })

    // ===== CANDADO: LOS ALIAS EN INGLÉS SALEN EN ESPAÑOL =====
    it('normalizes English display aliases back to the Spanish label', () => {
      expect(getCountryLabel('Mexico')).toBe('México')
      expect(getCountryLabel('Peru')).toBe('Perú')
      expect(getCountryLabel('Panama')).toBe('Panamá')
    })

    it('translates Brazil display aliases without adding BR to launch countries', () => {
      expect(getCountryLabel('Brazil')).toBe('Brasil')
      expect(getCountryLabel('Brasil')).toBe('Brasil')
      expect(isValidCountry('BR')).toBe(false)
    })

    // ===== TEST: RETURNS CODE FOR UNKNOWN COUNTRY =====
    it('returns code itself for unknown country', () => {
      expect(getCountryLabel('XX')).toBe('XX')
      expect(getCountryLabel('UNKNOWN')).toBe('UNKNOWN')
    })

    // ===== TEST: HANDLES OTHER =====
    it('returns label for OTHER option', () => {
      expect(getCountryLabel('OTHER')).toBe('Otro')
    })
  })

  // ============================================================================
  // isValidCountry TESTS
  // ============================================================================
  describe('isValidCountry', () => {
    // ===== TEST: RETURNS TRUE FOR VALID COUNTRIES =====
    it('returns true for valid country codes', () => {
      expect(isValidCountry('MX')).toBe(true)
      expect(isValidCountry('CO')).toBe(true)
      expect(isValidCountry('OTHER')).toBe(true)
      expect(isValidCountry('BR')).toBe(false)
    })

    // ===== TEST: RETURNS FALSE FOR INVALID COUNTRIES =====
    it('returns false for invalid country codes', () => {
      expect(isValidCountry('XX')).toBe(false)
      expect(isValidCountry('')).toBe(false)
      expect(isValidCountry('mx')).toBe(false) // Case sensitive
    })
  })
})
