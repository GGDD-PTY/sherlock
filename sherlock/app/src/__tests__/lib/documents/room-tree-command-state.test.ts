import { describe, expect, it } from 'vitest'

import {
  planForeignFileDrop,
  resolveRoomDocumentMove,
  roomUploadScopeKey,
} from '@/lib/documents/room-tree-command-state'

describe('room tree command state', () => {
  // La sala es una por empresa ([F] 2026-09-17): lo que separa dos scopes de
  // subida es la empresa, no la sala.
  it('pins upload state to a stable per-company room key', () => {
    expect(roomUploadScopeKey('company-1', { kind: 'COMPANY', id: 'company' })).toBe(
      'company-1\u0000COMPANY\u0000company'
    )
    expect(roomUploadScopeKey('company-2', { kind: 'COMPANY', id: 'company' })).not.toBe(
      roomUploadScopeKey('company-1', { kind: 'COMPANY', id: 'company' })
    )
  })

  it('keeps explicit move IDs unique and ordered while filtering foreign, disabled, and no-op rows', () => {
    const move = resolveRoomDocumentMove({
      documents: [
        { _id: 'document-a', folder: 'legal', lifecycleStatus: 'ACTIVE' },
        { _id: 'document-b', folder: 'operations', lifecycleStatus: null },
        { _id: 'document-noop', folder: 'model', lifecycleStatus: 'ACTIVE' },
        { _id: 'document-quarantined', folder: 'legal', lifecycleStatus: 'QUARANTINED' },
        { _id: 'document-archived', folder: 'legal', lifecycleStatus: 'ARCHIVED' },
      ],
      documentIds: [
        'document-b',
        'foreign-room-document',
        'document-a',
        'document-b',
        'document-noop',
        'document-quarantined',
        'document-archived',
      ],
      targetFolderId: 'room_financial',
    })

    expect(move).toEqual({
      status: 'MOVE',
      documentIds: ['document-b', 'document-a'],
      targetFolderId: 'room_financial',
    })
  })

  it('separates an all-no-op group from an unresolvable one', () => {
    const documents = [{ _id: 'document-a', folder: 'legal', lifecycleStatus: 'ACTIVE' as const }]

    expect(
      resolveRoomDocumentMove({ documents, documentIds: ['document-a'], targetFolderId: 'unknown' })
    ).toEqual({ status: 'INVALID' })
    expect(
      resolveRoomDocumentMove({ documents, documentIds: ['document-a'], targetFolderId: 'legal' })
    ).toEqual({ status: 'INVALID' })
    expect(
      resolveRoomDocumentMove({
        documents,
        documentIds: ['document-a'],
        targetFolderId: 'room_legal',
      })
    ).toEqual({ status: 'NOOP' })
    expect(
      resolveRoomDocumentMove({
        documents,
        documentIds: ['ghost', 'document-a'],
        targetFolderId: 'room_legal',
      })
    ).toEqual({ status: 'NOOP' })
    expect(
      resolveRoomDocumentMove({
        documents,
        documentIds: ['ghost'],
        targetFolderId: 'room_legal',
      })
    ).toEqual({ status: 'INVALID' })
  })

  it('queues an empty or same-target batch and asks before retargeting a populated batch', () => {
    const files = [new File(['a'], 'a.pdf')]

    expect(
      planForeignFileDrop({
        files,
        targetFolderId: 'room_operations',
        queueLength: 0,
        currentFolderId: 'other',
      })
    ).toEqual({ status: 'QUEUE', targetFolderId: 'room_operations' })
    expect(
      planForeignFileDrop({
        files,
        targetFolderId: 'room_operations',
        queueLength: 2,
        currentFolderId: 'room_operations',
      })
    ).toEqual({ status: 'QUEUE', targetFolderId: 'room_operations' })
    expect(
      planForeignFileDrop({
        files,
        targetFolderId: 'room_legal',
        queueLength: 2,
        currentFolderId: 'room_operations',
      })
    ).toEqual({
      status: 'CONFIRMATION_REQUIRED',
      currentFolderId: 'room_operations',
      targetFolderId: 'room_legal',
      fileCount: 1,
    })
  })

  it.each([
    [{ files: [] }, 'EMPTY_FILES'],
    [{ targetFolderId: 'unknown' }, 'INVALID_TARGET'],
    [{ isReadOnly: true }, 'READ_ONLY'],
    [{ isUploading: true }, 'UPLOADING'],
    [{ isReplacingVersion: true }, 'VERSION_REPLACEMENT'],
    [{ hasPendingConfirmation: true }, 'PENDING_CONFIRMATION'],
  ] as const)('rejects guarded foreign drops: %s', (override, reason) => {
    expect(
      planForeignFileDrop({
        files: [new File(['a'], 'a.pdf')],
        targetFolderId: 'room_operations',
        queueLength: 0,
        currentFolderId: 'other',
        ...override,
      })
    ).toEqual({ status: 'REJECTED', reason })
  })
})
