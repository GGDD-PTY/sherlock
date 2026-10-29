import { describe, expect, it } from 'vitest'

import {
  FOCUS_BAND_MAX_USD,
  FOCUS_BAND_MIN_USD,
  isOutsideUsdFocusBand,
} from '@/lib/constants/fundraising'

// La banda 250K-5MM es ENFOQUE DE MERCADO, no un límite (doctrina v3:
// "$250K-$5M es el sweet spot de marketing, no un cap"; decisión 2026-07-31).
// Este helper solo dice "esto queda fuera del enfoque" — nunca bloquea.
describe('banda de enfoque de mercado (USD 250K-5MM)', () => {
  it('marca montos USD por encima y por debajo de la banda', () => {
    expect(isOutsideUsdFocusBand(12_000_000, 'USD')).toBe(true)
    expect(isOutsideUsdFocusBand(100_000, 'USD')).toBe(true)
  })

  it('no marca montos dentro de la banda, bordes incluidos', () => {
    expect(isOutsideUsdFocusBand(FOCUS_BAND_MIN_USD, 'USD')).toBe(false)
    expect(isOutsideUsdFocusBand(FOCUS_BAND_MAX_USD, 'USD')).toBe(false)
    expect(isOutsideUsdFocusBand(1_500_000, 'USD')).toBe(false)
  })

  it('no marca monedas sin banda declarada: sin FX no hay comparación honesta', () => {
    expect(isOutsideUsdFocusBand(500_000_000, 'COP')).toBe(false)
    expect(isOutsideUsdFocusBand(1_000, 'MXN')).toBe(false)
  })

  it('trata la moneda ausente como USD (default documentado en el schema)', () => {
    expect(isOutsideUsdFocusBand(12_000_000, undefined)).toBe(true)
    expect(isOutsideUsdFocusBand(100_000, null)).toBe(true)
    expect(isOutsideUsdFocusBand(100_000, '')).toBe(true)
    expect(isOutsideUsdFocusBand(1_500_000, undefined)).toBe(false)
  })

  it('no marca montos ausentes o inválidos', () => {
    expect(isOutsideUsdFocusBand(Number.NaN, 'USD')).toBe(false)
    expect(isOutsideUsdFocusBand(null, 'USD')).toBe(false)
    expect(isOutsideUsdFocusBand(0, 'USD')).toBe(false)
  })

  it('expone la banda como constantes, no como números mágicos', () => {
    expect(FOCUS_BAND_MIN_USD).toBe(250_000)
    expect(FOCUS_BAND_MAX_USD).toBe(5_000_000)
  })
})
