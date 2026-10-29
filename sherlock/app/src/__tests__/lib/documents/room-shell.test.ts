import { describe, expect, it } from 'vitest'

import {
  filterRoomDocuments,
  formatRoomFileSize,
  getRoomFileKind,
  latestRoomUpdate,
  sortRoomDocuments,
  toRoomShellDocument,
  type RoomShellDocument,
} from '@/lib/documents/room-shell'

function makeDocument(overrides: Partial<RoomShellDocument>): RoomShellDocument {
  return {
    id: overrides.id ?? 'doc',
    name: overrides.name ?? 'Documento',
    folder: overrides.folder ?? 'room_corporate',
    rawFolder: overrides.rawFolder ?? null,
    mimeType: overrides.mimeType ?? 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 1024,
    versionNumber: overrides.versionNumber ?? 1,
    versionId: overrides.versionId ?? null,
    updatedAt: overrides.updatedAt ?? 0,
    accessLevel: overrides.accessLevel ?? 'NDA_REQUIRED',
    status: overrides.status ?? 'READY',
    kind: overrides.kind ?? 'pdf',
    sourceType: overrides.sourceType ?? null,
    sourceName: overrides.sourceName ?? null,
  }
}

describe('room shell file kinds', () => {
  it('resolves an icon kind per MIME type', () => {
    expect(
      getRoomFileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    ).toBe('spreadsheet')
    expect(getRoomFileKind('application/pdf')).toBe('pdf')
    expect(
      getRoomFileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe('document')
    expect(
      getRoomFileKind('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    ).toBe('presentation')
    expect(getRoomFileKind('image/png')).toBe('image')
    expect(getRoomFileKind('text/csv')).toBe('spreadsheet')
    expect(getRoomFileKind('application/zip')).toBe('other')
  })

  it('falls back to the file extension when the MIME type is missing', () => {
    expect(getRoomFileKind(null, 'Modelo financiero.xlsx')).toBe('spreadsheet')
    expect(getRoomFileKind(null, 'balance.csv')).toBe('spreadsheet')
    expect(getRoomFileKind(null, 'Teaser.pdf')).toBe('pdf')
    expect(getRoomFileKind(null, 'sin-extension')).toBe('other')
  })
})

describe('room shell projection', () => {
  it('maps a Convex document into a shell row with its fixed folder', () => {
    const row = toRoomShellDocument({
      _id: 'doc_1',
      _creationTime: 10,
      name: 'Estados financieros auditados',
      folder: 'Financieros',
      fileType: 'application/pdf',
      fileSize: 2048,
      accessLevel: 'PRIVATE',
      updatedAt: 99,
      currentVersionNumber: 3,
      currentVersionId: 'ver_1',
      publishedVersionId: 'ver_1',
      lifecycleStatus: 'ACTIVE',
    })

    expect(row).toMatchObject({
      id: 'doc_1',
      folder: 'room_financial',
      rawFolder: 'Financieros',
      versionNumber: 3,
      versionId: 'ver_1',
      updatedAt: 99,
      accessLevel: 'PRIVATE',
      status: 'READY',
      kind: 'pdf',
    })
  })

  it('sends unknown folders to the corporate folder and never drops the raw value', () => {
    const row = toRoomShellDocument({ _id: 'doc_2', name: 'Nota', folder: 'General' })

    expect(row.folder).toBe('room_corporate')
    expect(row.rawFolder).toBe('General')
  })

  // La procedencia es un campo cerrado: los cuatro valores del schema pasan y
  // cualquier otro cae a null (= subido por la empresa).
  it('keeps the team deliverable provenance and drops unknown values', () => {
    const team = toRoomShellDocument({ _id: 'a', name: 'a', sourceType: 'TEAM_DELIVERABLE' })
    expect(team.sourceType).toBe('TEAM_DELIVERABLE')
    expect(
      toRoomShellDocument({ _id: 'b', name: 'b', sourceType: 'MYCROFT' }).sourceType
    ).toBeNull()
    expect(toRoomShellDocument({ _id: 'c', name: 'c' }).sourceType).toBeNull()
  })

  it('reports a discrete state when the version is not published yet', () => {
    expect(toRoomShellDocument({ _id: 'a', name: 'a', currentVersionId: 'v1' }).status).toBe(
      'SCANNING'
    )
    expect(toRoomShellDocument({ _id: 'b', name: 'b' }).status).toBe('PENDING')
    expect(
      toRoomShellDocument({ _id: 'c', name: 'c', lifecycleStatus: 'QUARANTINED' }).status
    ).toBe('QUARANTINED')
  })

  it('uses a valid ISO createdAt only after numeric timestamp fields', () => {
    const createdAt = '2026-08-03T12:00:00.000Z'

    expect(toRoomShellDocument({ _id: 'iso', name: 'ISO', createdAt }).updatedAt).toBe(
      Date.parse(createdAt)
    )
    expect(
      toRoomShellDocument({
        _id: 'creation',
        name: 'Creation',
        createdAt,
        _creationTime: 123,
      }).updatedAt
    ).toBe(123)
    expect(
      toRoomShellDocument({
        _id: 'updated',
        name: 'Updated',
        createdAt,
        _creationTime: 123,
        updatedAt: 456,
      }).updatedAt
    ).toBe(456)
  })

  it('ignores invalid ISO createdAt and includes valid demo dates in the latest room update', () => {
    const rows = [
      toRoomShellDocument({ _id: 'invalid', name: 'Invalid', createdAt: 'not-a-date' }),
      toRoomShellDocument({
        _id: 'older',
        name: 'Older',
        createdAt: '2026-08-01T12:00:00.000Z',
      }),
      toRoomShellDocument({
        _id: 'latest',
        name: 'Latest',
        createdAt: '2026-08-05T12:00:00.000Z',
      }),
    ]

    expect(rows[0].updatedAt).toBe(0)
    expect(latestRoomUpdate(rows)).toBe(Date.parse('2026-08-05T12:00:00.000Z'))
  })
})

describe('room shell sorting', () => {
  const documents = [
    makeDocument({ id: 'b', name: 'Zeta operativa', folder: 'room_operations', updatedAt: 300 }),
    makeDocument({ id: 'a', name: 'Alfa legal', folder: 'room_legal', updatedAt: 100 }),
    makeDocument({ id: 'c', name: 'Beta teaser', folder: 'room_marketing', updatedAt: 200 }),
  ]

  it('orders by process (folder 1..5) and then by name', () => {
    expect(sortRoomDocuments(documents, 'process').map((document) => document.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('orders by name across folders', () => {
    expect(sortRoomDocuments(documents, 'name').map((document) => document.id)).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('orders by last modified, newest first', () => {
    expect(sortRoomDocuments(documents, 'modified').map((document) => document.id)).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('never mutates the input array', () => {
    const input = [...documents]
    sortRoomDocuments(input, 'name')
    expect(input.map((document) => document.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('room shell search and size formatting', () => {
  it('filters by name ignoring case and accents', () => {
    const documents = [
      makeDocument({ id: 'a', name: 'Modelo financiero' }),
      makeDocument({ id: 'b', name: 'Índice del data room' }),
    ]

    expect(filterRoomDocuments(documents, 'indice').map((document) => document.id)).toEqual(['b'])
    expect(filterRoomDocuments(documents, '   ')).toHaveLength(2)
  })

  it('formats byte sizes and degrades to a dash when unknown', () => {
    expect(formatRoomFileSize(512, 'es')).toBe('512 B')
    expect(formatRoomFileSize(2048, 'es')).toBe('2.0 KB')
    expect(formatRoomFileSize(null, 'es')).toBe('—')
    expect(formatRoomFileSize(-1, 'es')).toBe('—')
  })
})
