// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  readOoxmlPartsEffect,
  readZipEntriesEffect,
  readZipEntryTextEffect,
  type ZipEntry,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_TOTAL_BYTES,
} from '@/lib/vdr-mcp/zip'

const DOCX = new Uint8Array(
  readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/vdr-mcp/andina-solar-negocio.docx'))
)

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function storeZip(options: {
  name: string
  data: Uint8Array
  method?: number
  uncompressedSize?: number
}): Uint8Array {
  const name = new TextEncoder().encode(options.name)
  const method = options.method ?? 0
  const compressedSize = options.data.byteLength
  const uncompressedSize = options.uncompressedSize ?? options.data.byteLength

  const local = concat([
    u32(SIG_LOCAL),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(name.byteLength),
    u16(0),
    name,
    options.data,
  ])

  const central = concat([
    u32(SIG_CENTRAL),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(name.byteLength),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ])

  const eocd = concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.byteLength),
    u32(local.byteLength),
    u16(0),
  ])

  return concat([local, central, eocd])
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  return Effect.runSync(
    readZipEntriesEffect(bytes).pipe(Effect.catch(() => Effect.succeed<ZipEntry[] | null>(null)))
  )
}

function readZipEntryText(bytes: Uint8Array, entry: ZipEntry): string | null {
  return Effect.runSync(
    readZipEntryTextEffect(bytes, entry).pipe(
      Effect.catch(() => Effect.succeed<string | null>(null))
    )
  )
}

function emptyNameDirectory(count: number): Uint8Array {
  const entry = concat([
    u32(SIG_CENTRAL),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
  ])
  const directory = new Uint8Array(entry.byteLength * count)
  for (let index = 0; index < count; index += 1) {
    directory.set(entry, index * entry.byteLength)
  }
  const eocd = concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(count),
    u16(count),
    u32(directory.byteLength),
    u32(0),
    u16(0),
  ])
  return concat([directory, eocd])
}

describe('vdr-mcp zip bounds', () => {
  it('pins the zip-bomb ceilings so a silent raise cannot land unreviewed', () => {
    expect(ZIP_MAX_ENTRIES).toBe(2_048)
    expect(ZIP_MAX_ENTRY_BYTES).toBe(32 * 1024 * 1024)
    expect(ZIP_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024)
  })

  it('returns null for a truncated buffer and for an EOCD that claims too many entries', () => {
    expect(readZipEntries(new Uint8Array(10))).toBeNull()
    expect(readZipEntries(emptyNameDirectory(ZIP_MAX_ENTRIES))).toHaveLength(ZIP_MAX_ENTRIES)
    expect(readZipEntries(emptyNameDirectory(ZIP_MAX_ENTRIES + 1))).toBeNull()
  })

  it('reads a store-method entry and refuses an advertised uncompressed size above the cap', () => {
    const xml = new TextEncoder().encode('<w:t>Andina</w:t>')
    const ok = storeZip({ name: 'word/document.xml', data: xml })
    const entries = readZipEntries(ok)
    expect(entries).toHaveLength(1)
    expect(entries?.[0].name).toBe('word/document.xml')
    expect(readZipEntryText(ok, entries![0])).toBe('<w:t>Andina</w:t>')

    const bomb = storeZip({
      name: 'word/document.xml',
      data: xml,
      uncompressedSize: ZIP_MAX_ENTRY_BYTES + 1,
    })
    const bombEntries = readZipEntries(bomb)
    expect(bombEntries).toHaveLength(1)
    expect(readZipEntryText(bomb, bombEntries![0])).toBeNull()
  })

  it('refuses an unsupported compression method without inflating', () => {
    const packed = storeZip({
      name: 'word/document.xml',
      data: new TextEncoder().encode('no'),
      method: 9,
    })
    const entries = readZipEntries(packed)
    expect(entries).toHaveLength(1)
    expect(readZipEntryText(packed, entries![0])).toBeNull()
  })

  it('extracts the named OOXML parts from a real fixture and ignores unmatched names', () => {
    const parts = Effect.runSync(readOoxmlPartsEffect(DOCX, (name) => name === 'word/document.xml'))
    expect(parts).toHaveLength(1)
    expect(parts[0].name).toBe('word/document.xml')
    expect(parts[0].xml).toContain('Andina Solar')
    expect(
      Effect.runSync(readOoxmlPartsEffect(DOCX, (name) => name === 'ppt/slides/slide1.xml'))
    ).toEqual([])
  })

  it('exposes Effect-native directory, entry, and OOXML readers with typed failures', () => {
    const packed = storeZip({
      name: 'word/document.xml',
      data: new TextEncoder().encode('<w:t>Andina</w:t>'),
    })
    const entries = Effect.runSync(readZipEntriesEffect(packed))
    expect(entries).toHaveLength(1)
    expect(Effect.runSync(readZipEntryTextEffect(packed, entries[0]))).toBe('<w:t>Andina</w:t>')

    const parts = Effect.runSync(readOoxmlPartsEffect(DOCX, (name) => name === 'word/document.xml'))
    expect(parts[0].xml).toContain('Andina Solar')

    const failure = Effect.runSync(
      readZipEntriesEffect(new Uint8Array(10)).pipe(
        Effect.match({
          onSuccess: () => null,
          onFailure: (error) => error,
        })
      )
    )
    expect(failure).toMatchObject({ _tag: 'ZipReadError', operation: 'directory' })
  })
})
