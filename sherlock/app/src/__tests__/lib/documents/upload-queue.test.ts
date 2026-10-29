import { describe, expect, it, vi } from 'vitest'

import {
  buildUploadQueueEntries,
  isRetryableQueuedUploadFailure,
  MAX_CONCURRENT_VDR_UPLOADS,
  MAX_VDR_FILES_PER_BATCH,
  settleWithConcurrency,
  stripUploadExtension,
  uploadableQueueEntries,
  validateQueuedUpload,
  type VdrQueuedUpload,
} from '@/lib/documents/upload-queue'
import {
  MAX_CSV_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_BYTES,
} from '../../../../convex/_documents/uploadLimits'

const copy = { fileTypeError: 'TYPE', fileSizeError: 'SIZE' }

function file(name: string, options: { type?: string; size?: number } = {}) {
  const result = new File(['x'], name, { type: options.type ?? '' })
  if (options.size !== undefined) Object.defineProperty(result, 'size', { value: options.size })
  return result
}

describe('VDR multi-upload queue', () => {
  it('keeps the hardened PDF, Office and CSV allowlist and rejects text, images and archives', () => {
    expect(validateQueuedUpload(file('deck.pdf', { type: 'application/pdf' }), copy)).toBeNull()
    expect(validateQueuedUpload(file('model.XLSX'), copy)).toBeNull()
    expect(validateQueuedUpload(file('balance.csv', { type: 'text/csv' }), copy)).toBeNull()
    expect(validateQueuedUpload(file('balance.csv', { type: 'text/plain' }), copy)).toBeNull()
    expect(validateQueuedUpload(file('balance.csv'), copy)).toBeNull()
    expect(validateQueuedUpload(file('notes.txt', { type: 'text/plain' }), copy)).toBe('TYPE')
    expect(validateQueuedUpload(file('photo.png', { type: 'image/png' }), copy)).toBe('TYPE')
    expect(validateQueuedUpload(file('room.zip', { type: 'application/zip' }), copy)).toBe('TYPE')
  })

  it('validates the size per file and preserves invalid rows as visible errors', () => {
    const tooLarge = file('large.pdf', {
      type: 'application/pdf',
      size: MAX_DIRECT_UPLOAD_BYTES + 1,
    })
    expect(validateQueuedUpload(tooLarge, copy)).toBe('SIZE')

    const result = buildUploadQueueEntries({
      files: [
        file('valid.pdf', { type: 'application/pdf' }),
        file('unsafe.zip', { type: 'application/zip' }),
      ],
      alreadyQueued: 0,
      startKey: 0,
      copy,
    })

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ name: 'valid', status: 'PENDING' })
    expect(result.entries[1]).toMatchObject({ name: 'unsafe', status: 'ERROR', error: 'TYPE' })
  })

  it('applies the 20 MB CSV cap without lowering the PDF and Office cap', () => {
    expect(
      validateQueuedUpload(
        file('balance.csv', { type: 'text/csv', size: MAX_CSV_UPLOAD_BYTES }),
        copy
      )
    ).toBeNull()
    expect(
      validateQueuedUpload(
        file('balance.csv', { type: 'text/csv', size: MAX_CSV_UPLOAD_BYTES + 1 }),
        copy
      )
    ).toBe('SIZE')
    expect(
      validateQueuedUpload(
        file('financials.pdf', { type: 'application/pdf', size: MAX_CSV_UPLOAD_BYTES + 1 }),
        copy
      )
    ).toBeNull()
  })

  it('rejects empty files and generic binary declarations before queueing', () => {
    expect(
      validateQueuedUpload(file('empty.pdf', { type: 'application/pdf', size: 0 }), copy)
    ).toBe('SIZE')
    expect(
      validateQueuedUpload(file('generic.pdf', { type: 'application/octet-stream' }), copy)
    ).toBe('TYPE')
  })

  it('reports files beyond the bounded batch instead of silently dropping them', () => {
    const files = Array.from({ length: MAX_VDR_FILES_PER_BATCH + 3 }, (_, index) =>
      file(`document-${index}.pdf`, { type: 'application/pdf' })
    )
    const result = buildUploadQueueEntries({
      files,
      alreadyQueued: 0,
      startKey: 0,
      copy,
    })

    expect(result.entries).toHaveLength(MAX_VDR_FILES_PER_BATCH)
    expect(result.droppedOverLimit).toBe(3)
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(MAX_VDR_FILES_PER_BATCH)
  })

  it('retries only failures known not to have committed storage', () => {
    const queue: VdrQueuedUpload[] = [
      { id: '1', file: file('a.pdf'), name: 'a', status: 'PENDING' },
      { id: '2', file: file('b.pdf'), name: 'b', status: 'DONE' },
      { id: '3', file: file('c.pdf'), name: 'c', status: 'ERROR', retryable: true },
      {
        id: '4',
        file: file('d.pdf'),
        name: 'd',
        status: 'ERROR',
        retryable: false,
        reconciliationRequired: true,
      },
    ]

    expect(uploadableQueueEntries(queue).map((entry) => entry.id)).toEqual(['1', '3'])

    expect(isRetryableQueuedUploadFailure({ code: 'FILE_HASH_FAILED' })).toBe(true)
    expect(isRetryableQueuedUploadFailure({ code: 'STORAGE_UPLOAD_FAILED' })).toBe(true)
    expect(
      isRetryableQueuedUploadFailure({
        code: 'STORAGE_UPLOAD_FAILED',
        reconciliationRequired: true,
      })
    ).toBe(false)
    expect(isRetryableQueuedUploadFailure({ code: 'INVALID_FILE_TYPE' })).toBe(false)
  })

  it('bounds concurrency, preserves result order and continues after one failure', async () => {
    let active = 0
    let maximumActive = 0
    const releases: Array<() => void> = []
    const items = [1, 2, 3, 4]

    const resultPromise = settleWithConcurrency(items, async (item) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      if (item === 2) throw new Error('expected failure')
      return item * 10
    })

    // La tanda vive en `upload-queue-concurrency` y llega por `import()`, así
    // que el arranque ya no cabe en un tick: se espera al estado, no al reloj.
    await vi.waitFor(() => expect(active).toBe(MAX_CONCURRENT_VDR_UPLOADS))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(releases).toHaveLength(MAX_CONCURRENT_VDR_UPLOADS))
    releases.splice(0).forEach((release) => release())

    const results = await resultPromise
    expect(maximumActive).toBe(MAX_CONCURRENT_VDR_UPLOADS)
    expect(results).toEqual([
      { status: 'fulfilled', value: 10 },
      expect.objectContaining({ status: 'rejected' }),
      { status: 'fulfilled', value: 30 },
      { status: 'fulfilled', value: 40 },
    ])
  })

  it('does not start queued uploads after the batch is stopped', async () => {
    const controller = new AbortController()
    const started: number[] = []
    const releases: Array<() => void> = []

    const resultPromise = settleWithConcurrency(
      [1, 2, 3, 4],
      async (item) => {
        started.push(item)
        await new Promise<void>((resolve) => releases.push(resolve))
        return item
      },
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(started).toHaveLength(MAX_CONCURRENT_VDR_UPLOADS))
    controller.abort()
    releases.splice(0).forEach((release) => release())

    await expect(resultPromise).resolves.toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ])
    expect(started).toEqual([1, 2])
  })

  it('removes only the final extension from the default document name', () => {
    expect(stripUploadExtension('Financial Model v3.final.xlsx')).toBe('Financial Model v3.final')
    expect(stripUploadExtension('.gitignore')).toBe('.gitignore')
  })

  // Lo que el cliente soltó en la landing tiene que aterrizar igual por los dos
  // caminos: el claim del intake temporal guarda el nombre completo y rutea por
  // el nombre (`convex/_intake/claim.ts`). El sobre de IndexedDB no puede dejar
  // los mismos documentos sin extensión y en "other" (prod 2026-09-03 03:25).
  it('keeps the file name and routes the folder for files parked by the landing', () => {
    const result = buildUploadQueueEntries({
      files: [
        file('INA_GRMELO_2024_FY_v01.pdf', { type: 'application/pdf' }),
        file('Pacto social.pdf', { type: 'application/pdf' }),
        file('Teaser final.pdf', { type: 'application/pdf' }),
      ],
      alreadyQueued: 0,
      startKey: 0,
      copy,
      origin: 'INTAKE_HANDOFF',
    })

    expect(result.entries[0]).toMatchObject({
      name: 'INA_GRMELO_2024_FY_v01.pdf',
      folder: 'room_financial',
      status: 'PENDING',
    })
    expect(result.entries[1]).toMatchObject({ name: 'Pacto social.pdf', folder: 'room_corporate' })
    expect(result.entries[2]).toMatchObject({ name: 'Teaser final.pdf', folder: 'room_marketing' })
  })

  it('leaves a room upload on the basename and on the folder the dialog picked', () => {
    const result = buildUploadQueueEntries({
      files: [file('INA_GRMELO_2024_FY_v01.pdf', { type: 'application/pdf' })],
      alreadyQueued: 0,
      startKey: 0,
      copy,
    })

    expect(result.entries[0]).toMatchObject({ name: 'INA_GRMELO_2024_FY_v01' })
    expect(result.entries[0].folder).toBeUndefined()
  })
})
