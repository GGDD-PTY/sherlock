import { describe, expect, it } from 'vitest'

import {
  detectFileSignature,
  inspectCsvFile,
  inspectOfficeFile,
  inspectZipSafety,
  matchesDeclaredMimeType,
} from '../../../convex/_documents/fileInspection'

function zipFixture({
  compressedSize = 100,
  uncompressedSize = 1_000,
  encrypted = false,
}: {
  compressedSize?: number
  uncompressedSize?: number
  encrypted?: boolean
} = {}): Blob {
  const localHeaderBytes = 30
  const centralDirectoryBytes = 46
  const eocdBytes = 22
  const bytes = new Uint8Array(localHeaderBytes + centralDirectoryBytes + eocdBytes)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint32(localHeaderBytes, 0x02014b50, true)
  view.setUint16(localHeaderBytes + 8, encrypted ? 1 : 0, true)
  view.setUint32(localHeaderBytes + 20, compressedSize, true)
  view.setUint32(localHeaderBytes + 24, uncompressedSize, true)
  const eocd = localHeaderBytes + centralDirectoryBytes
  view.setUint32(eocd, 0x06054b50, true)
  view.setUint16(eocd + 8, 1, true)
  view.setUint16(eocd + 10, 1, true)
  view.setUint32(eocd + 12, centralDirectoryBytes, true)
  view.setUint32(eocd + 16, localHeaderBytes, true)
  return new Blob([bytes])
}

describe('VDR file signature inspection', () => {
  it.each([
    [new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'PDF'],
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'ZIP'],
    [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'OLE'],
    [new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'UNKNOWN'],
  ] as const)('detects %s as %s', (bytes, expected) => {
    expect(detectFileSignature(bytes)).toBe(expected)
  })

  it('accepts only signatures compatible with the declared allowlisted MIME', () => {
    expect(matchesDeclaredMimeType('application/pdf', 'PDF')).toBe(true)
    expect(matchesDeclaredMimeType('application/pdf', 'ZIP')).toBe(false)
    expect(
      matchesDeclaredMimeType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ZIP'
      )
    ).toBe(true)
    expect(matchesDeclaredMimeType('application/msword', 'OLE')).toBe(true)
    expect(matchesDeclaredMimeType('text/html', 'UNKNOWN')).toBe(false)
  })

  it('accepts a bounded unencrypted OOXML-style ZIP without decompressing it', async () => {
    await expect(inspectZipSafety(zipFixture())).resolves.toEqual({
      safe: true,
      entries: 1,
      compressedBytes: 100,
      uncompressedBytes: 1_000,
    })
  })

  it('rejects a generic ZIP renamed as an Office document', async () => {
    await expect(
      inspectOfficeFile(
        zipFixture(),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).resolves.toBe(false)
  })

  it('fails closed for high-ratio decompression bombs', async () => {
    await expect(
      inspectZipSafety(zipFixture({ compressedSize: 1, uncompressedSize: 10_000 }))
    ).resolves.toEqual({ safe: false, code: 'ZIP_BOMB' })
  })

  it('fails closed for encrypted Office containers that downstream scanners cannot inspect', async () => {
    await expect(inspectZipSafety(zipFixture({ encrypted: true }))).resolves.toEqual({
      safe: false,
      code: 'ENCRYPTED_ARCHIVE',
    })
  })

  it('fails closed when the central directory is missing', async () => {
    await expect(
      inspectZipSafety(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]))
    ).resolves.toEqual({ safe: false, code: 'INVALID_ARCHIVE' })
  })
})

describe('CSV sources (trial balance) inspection', () => {
  const header = 'Codigo,Cuenta,Debito,Credito\n1000,Caja y bancos,1650000.00,0.00\n'
  const csvBytes = () => new TextEncoder().encode(header)

  it('detects printable text as TEXT and keeps binary as UNKNOWN', () => {
    expect(detectFileSignature(csvBytes().slice(0, 16))).toBe('TEXT')
    expect(detectFileSignature(new Uint8Array([0xef, 0xbb, 0xbf, 0x43, 0x6f]))).toBe('TEXT')
    expect(detectFileSignature(new Uint8Array([0x43, 0x00, 0x6f]))).toBe('UNKNOWN')
  })

  it('accepts text/csv only with a TEXT signature', () => {
    expect(matchesDeclaredMimeType('text/csv', 'TEXT')).toBe(true)
    expect(matchesDeclaredMimeType('text/csv', 'ZIP')).toBe(false)
    expect(matchesDeclaredMimeType('text/csv', 'PDF')).toBe(false)
    expect(matchesDeclaredMimeType('text/csv', 'UNKNOWN')).toBe(false)
    expect(matchesDeclaredMimeType('application/pdf', 'TEXT')).toBe(false)
    expect(
      matchesDeclaredMimeType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'TEXT'
      )
    ).toBe(false)
  })

  it('accepts a delimited UTF-8 table with a header and at least one row', async () => {
    await expect(inspectCsvFile(new Blob([csvBytes()]))).resolves.toEqual({ safe: true })
    const semicolon = new TextEncoder().encode('Codigo;Cuenta;Debito;Credito\n1000;Caja;1;0\n')
    await expect(inspectCsvFile(new Blob([semicolon]))).resolves.toEqual({ safe: true })
    const tab = new TextEncoder().encode('Codigo\tCuenta\tDebito\n1000\tCaja\t1\n')
    await expect(inspectCsvFile(new Blob([tab]))).resolves.toEqual({ safe: true })
  })

  it('strips a UTF-8 BOM before requiring a delimiter on the header', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...csvBytes()])
    await expect(inspectCsvFile(new Blob([bom]))).resolves.toEqual({ safe: true })
  })

  it('rejects NUL bytes, invalid UTF-8, a header without delimiter and a header-only file', async () => {
    const nul = new Uint8Array([...csvBytes(), 0x00, 0x41])
    await expect(inspectCsvFile(new Blob([nul]))).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
    const badUtf8 = new Uint8Array([
      0x43, 0x6f, 0x64, 0x2c, 0x41, 0xff, 0xfe, 0x0a, 0x31, 0x2c, 0x32, 0x0a,
    ])
    await expect(inspectCsvFile(new Blob([badUtf8]))).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
    const noDelimiter = new TextEncoder().encode('Codigo Cuenta Debito\n1000 Caja 1\n')
    await expect(inspectCsvFile(new Blob([noDelimiter]))).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
    const headerOnly = new TextEncoder().encode('Codigo,Cuenta,Debito,Credito\n')
    await expect(inspectCsvFile(new Blob([headerOnly]))).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
  })

  it('rejects a CSV above its own byte ceiling and a zip container renamed as csv', async () => {
    await expect(inspectCsvFile(new Blob([csvBytes()]), { maxBytes: 10 })).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
    await expect(inspectCsvFile(zipFixture())).resolves.toEqual({
      safe: false,
      code: 'INVALID_CSV',
    })
  })
})
