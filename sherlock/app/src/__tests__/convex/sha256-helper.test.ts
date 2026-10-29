import { describe, expect, it } from 'vitest'

import { normalizeSha256Hex } from '../../../convex/_helpers/sha256'

// Par real del incidente 2026-08-26: INA_SAMPLE_ENERGY_2025_FY_v01.pdf en brainy-emu-822.
const HEX = 'c60c38b9d3cdd5082c298f5ef7c35029b7bf7834c16c49bd370f36d7abbf4d86'
const BASE64 = 'xgw4udPN1QgsKY9e98NQKbe/eDTBbEm9Nw8216u/TYY='

describe('normalizeSha256Hex', () => {
  it('passes lowercase hex through and lowercases uppercase hex', () => {
    expect(normalizeSha256Hex(HEX)).toBe(HEX)
    expect(normalizeSha256Hex(HEX.toUpperCase())).toBe(HEX)
  })

  it('converts the Convex Storage base64 digest to canonical hex', () => {
    expect(normalizeSha256Hex(BASE64)).toBe(HEX)
  })

  it('accepts base64url and unpadded variants', () => {
    expect(
      normalizeSha256Hex(BASE64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    ).toBe(HEX)
  })

  it('returns null for garbage and wrong-length digests', () => {
    expect(normalizeSha256Hex('not-a-digest')).toBeNull()
    expect(normalizeSha256Hex('abcd')).toBeNull()
    expect(normalizeSha256Hex('')).toBeNull()
  })

  it('trims surrounding whitespace on both hex and base64 encodings', () => {
    expect(normalizeSha256Hex(`  ${HEX}  `)).toBe(HEX)
    expect(normalizeSha256Hex(`\n${BASE64}\t`)).toBe(HEX)
  })

  it('rejects decoded payloads that are not exactly 32 bytes', () => {
    expect(normalizeSha256Hex(Buffer.alloc(31, 0xaa).toString('base64'))).toBeNull()
    expect(normalizeSha256Hex(Buffer.alloc(33, 0xaa).toString('base64'))).toBeNull()
  })
})
