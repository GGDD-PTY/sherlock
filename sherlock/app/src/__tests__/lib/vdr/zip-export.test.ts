import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createRoomZipStream,
  buildZipEntryPath,
  isExportOverCap,
  sanitizeZipFileName,
  sumExportableBytes,
  VDR_EXPORT_MAX_BYTES,
} from '@/lib/vdr/zip-export'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
      controller.close()
    },
  })
}

describe('vdr zip export helpers', () => {
  it('sums byteSize and flags a room over 250 MB before any download', () => {
    const documents = [{ byteSize: 200 * 1024 * 1024 }, { byteSize: 51 * 1024 * 1024 }]
    const total = sumExportableBytes(documents)
    expect(total).toBeGreaterThan(VDR_EXPORT_MAX_BYTES)
    expect(isExportOverCap(total)).toBe(true)
    expect(isExportOverCap(VDR_EXPORT_MAX_BYTES)).toBe(false)
  })

  it('builds zip paths with the five shell folder labels', () => {
    const used = new Set<string>()
    expect(buildZipEntryPath('room_legal', 'Estatutos.pdf', 'es', used)).toBe(
      '1. Legales/Estatutos.pdf'
    )
    expect(buildZipEntryPath('room_financial', 'Modelo.xlsx', 'es', used)).toBe(
      '3. Financieros/Modelo.xlsx'
    )
    expect(buildZipEntryPath('room_legal', 'Bylaws.pdf', 'es', new Set())).toBe(
      '1. Legales/Bylaws.pdf'
    )
  })

  it('dedupes colliding names and strips path separators', () => {
    const used = new Set<string>()
    expect(buildZipEntryPath('room_legal', 'Contrato.pdf', 'es', used)).toBe(
      '1. Legales/Contrato.pdf'
    )
    expect(buildZipEntryPath('room_legal', 'Contrato.pdf', 'es', used)).toBe(
      '1. Legales/Contrato (2).pdf'
    )
    expect(sanitizeZipFileName('a/b\\c.pdf')).toBe('a-b-c.pdf')
  })

  it('replaces empty and control-character names with a safe zip entry', () => {
    expect(sanitizeZipFileName('')).toBe('documento')
    expect(sanitizeZipFileName('   ')).toBe('documento')
    expect(sanitizeZipFileName('contrato\u0000.pdf')).toBe('contrato_.pdf')
    expect(sanitizeZipFileName('\u0007')).toBe('_')

    const used = new Set<string>()
    expect(buildZipEntryPath('room_legal', '', 'es', used)).toBe('1. Legales/documento')
    expect(buildZipEntryPath('room_legal', '   ', 'es', used)).toBe('1. Legales/documento (2)')
  })

  it('packs files under those paths from chunked streams', async () => {
    const stream = createRoomZipStream([
      { path: '1. Legales/Estatutos.pdf', open: async () => streamOf([[1, 2], [3]]) },
      { path: '3. Financieros/Modelo.xlsx', open: async () => streamOf([[4], [5]]) },
    ])

    const archive = await new Response(stream).arrayBuffer()
    const zip = await JSZip.loadAsync(archive)
    expect(
      Object.keys(zip.files)
        .filter((name) => !zip.files[name]?.dir)
        .sort()
    ).toEqual(['1. Legales/Estatutos.pdf', '3. Financieros/Modelo.xlsx'])
    expect(await zip.file('1. Legales/Estatutos.pdf')?.async('uint8array')).toEqual(
      new Uint8Array([1, 2, 3])
    )
  })

  it('opens each blob only when its turn comes, never the whole room upfront', async () => {
    const opened: string[] = []
    const stream = createRoomZipStream([
      {
        path: '1. Legales/A.pdf',
        open: async () => {
          opened.push('a')
          return streamOf([[1]])
        },
      },
      {
        path: '1. Legales/B.pdf',
        open: async () => {
          opened.push('b')
          return streamOf([[2]])
        },
      },
    ])

    const reader = stream.getReader()
    await reader.read()
    expect(opened).toEqual(['a'])
    await reader.cancel()
  })

  it('aborts the stream when a blob fails instead of shipping a short zip', async () => {
    const aborts: unknown[] = []
    const stream = createRoomZipStream(
      [
        { path: '1. Legales/A.pdf', open: async () => streamOf([[1, 2, 3]]) },
        {
          path: '1. Legales/B.pdf',
          open: async () => {
            throw new Error('ROOM_EXPORT_BLOB_UNAVAILABLE')
          },
        },
      ],
      (error) => {
        aborts.push(error)
      }
    )

    await expect(new Response(stream).arrayBuffer()).rejects.toThrow()
    expect(aborts).toHaveLength(1)
  })

  it('does not abort when the zip consumer holds backpressure past 30 seconds', async () => {
    vi.useFakeTimers()
    const aborts: unknown[] = []
    const stream = createRoomZipStream(
      [
        {
          path: '1. Legales/Grande.pdf',
          open: async () =>
            streamOf([
              [1, 2, 3],
              [4, 5, 6],
              [7, 8, 9],
              [10, 11, 12],
            ]),
        },
      ],
      (error) => {
        aborts.push(error)
      }
    )

    await vi.advanceTimersByTimeAsync(30_001)
    expect(aborts).toHaveLength(0)

    vi.useRealTimers()
    const archive = await new Response(stream).arrayBuffer()
    const zip = await JSZip.loadAsync(archive)
    expect(await zip.file('1. Legales/Grande.pdf')?.async('uint8array')).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    )
  })

  it('aborts with a typed error when one entry stays pending for 30 seconds', async () => {
    vi.useFakeTimers()
    const aborts: unknown[] = []
    const stream = createRoomZipStream(
      [
        {
          path: '1. Legales/Pendiente.pdf',
          open: () => new Promise<ReadableStream<Uint8Array>>(() => {}),
        },
      ],
      (error) => {
        aborts.push(error)
      }
    )
    const result = new Response(stream).arrayBuffer().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )

    await vi.advanceTimersByTimeAsync(29_999)
    expect(aborts).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(aborts).toHaveLength(1)
    expect(aborts[0]).toMatchObject({ name: 'RoomZipError', operation: 'timeout' })
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { name: 'RoomZipError', operation: 'timeout' },
    })
  })

  // El lector de cada documento vive en su propio scope
  // (`Effect.acquireRelease`): el candado del stream se suelta con el Exit en la
  // mano, así que también cuando el blob revienta a mitad del camino. Un lector
  // que se queda con el candado deja el stream del proveedor sin liberar.
  it('suelta el candado del lector cuando un blob revienta a mitad del stream', async () => {
    let body: ReadableStream<Uint8Array> | null = null
    const stream = createRoomZipStream(
      [
        {
          path: '1. Legales/Truncado.pdf',
          open: async () => {
            // Un chunk sale bien; el segundo `pull` revienta el blob a mitad
            // del stream, con el lector ya con el candado tomado.
            body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]))
              },
              pull(controller) {
                controller.error(new Error('ROOM_EXPORT_BLOB_TRUNCATED'))
              },
            })
            return body
          },
        },
      ],
      () => {}
    )

    await expect(new Response(stream).arrayBuffer()).rejects.toThrow('ROOM_EXPORT_BLOB_TRUNCATED')
    expect(body).not.toBeNull()
    expect((body as unknown as ReadableStream<Uint8Array>).locked).toBe(false)
  })
})
