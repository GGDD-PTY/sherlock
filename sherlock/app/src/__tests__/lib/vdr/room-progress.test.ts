import { describe, expect, it } from 'vitest'

import { VDR_SHELL_FOLDERS } from '@/lib/vdr/document-taxonomy'
import {
  CHECKLIST_TOTAL,
  CLIENT_ITEM_KEYS,
  computeRoomProgress,
  partitionEmptyRoomFolders,
  ROOM_OPTIONAL_FOLDERS,
  roomProgressInputFromSala,
  STAGE_ORDER,
  type RoomProgressInput,
} from '@/lib/vdr/room-progress'

describe('ROOM_OPTIONAL_FOLDERS', () => {
  it('marks operations and marketing as the only optional shell folders', () => {
    expect([...ROOM_OPTIONAL_FOLDERS].sort()).toEqual(['room_marketing', 'room_operations'])
  })
})

describe('partitionEmptyRoomFolders', () => {
  it('splits empty shell folders the same way the room cover does', () => {
    const filled = new Set(['room_financial'])
    const { emptyFolders, optionalEmptyFolders } = partitionEmptyRoomFolders(
      VDR_SHELL_FOLDERS,
      filled
    )

    expect(emptyFolders.map((folder) => folder.value)).toEqual(['room_legal', 'room_corporate'])
    expect(optionalEmptyFolders.map((folder) => folder.value)).toEqual([
      'room_operations',
      'room_marketing',
    ])
  })
})

describe('computeRoomProgress', () => {
  it('counts five client items and skips optional empty folders from the percent', () => {
    const input: RoomProgressInput = {
      folders: [
        { folder: '3. Financieros', count: 2 },
        { folder: 'room_corporate', count: 1 },
      ],
      nameConfirmed: true,
      phonePresent: false,
      deliverables: [],
      lastMovement: { nombre: 'EEFF.pdf', at: 1_700_000_000_000 },
    }
    const progress = computeRoomProgress(input)

    expect(CHECKLIST_TOTAL).toBe(5)
    expect(progress.percent).toBe(60)
    expect(progress.foldersWithDocuments).toEqual(['room_corporate', 'room_financial'])
    expect(progress.emptyRequiredFolders).toEqual(['room_legal'])
    expect(progress.emptyOptionalFolders).toEqual(['room_operations', 'room_marketing'])
    expect(progress.siguientePaso).toBe('items.phone')
    expect(progress.checklist.map((item) => item.key)).toEqual([...CLIENT_ITEM_KEYS])
    expect(progress.deliverables.map((row) => row.key)).toEqual([...STAGE_ORDER])
    expect(progress.deliverables.every((row) => row.status === 'PENDING')).toBe(true)
  })

  it('uses the first open deliverable once the client items are done', () => {
    const progress = computeRoomProgress({
      folders: [
        { folder: 'room_legal', count: 1 },
        { folder: 'room_corporate', count: 1 },
        { folder: 'room_financial', count: 1 },
      ],
      nameConfirmed: true,
      phonePresent: true,
      deliverables: [{ key: 'MODEL_V1', status: 'DELIVERED' }],
      lastMovement: null,
    })

    expect(progress.percent).toBe(100)
    expect(progress.siguientePaso).toBe('stages.MODEL_V2')
  })

  it('falls back to the kickoff copy when every stage is delivered', () => {
    const progress = computeRoomProgress({
      folders: [
        { folder: 'room_legal', count: 1 },
        { folder: 'room_corporate', count: 1 },
        { folder: 'room_financial', count: 1 },
      ],
      nameConfirmed: true,
      phonePresent: true,
      deliverables: STAGE_ORDER.map((key) => ({ key, status: 'DELIVERED' })),
      lastMovement: null,
    })

    expect(progress.siguientePaso).toBe('kickoffQuestion')
  })
})

describe('roomProgressInputFromSala', () => {
  it('keeps the latest document as last movement on a timestamp tie', () => {
    const input = roomProgressInputFromSala({
      documentos: [
        { carpeta: '3. Financieros', nombre: 'EEFF.pdf', actualizadoEn: 1_700_000_000_000 },
        {
          carpeta: '5. Materiales de mercadeo',
          nombre: 'Management presentation.pptx',
          actualizadoEn: 1_700_000_000_000,
        },
      ],
    })

    expect(input.nameConfirmed).toBe(false)
    expect(input.phonePresent).toBe(false)
    expect(input.lastMovement).toEqual({
      nombre: 'Management presentation.pptx',
      at: 1_700_000_000_000,
    })
  })

  it('does not treat a company name as nameConfirmed', () => {
    const progress = computeRoomProgress(
      roomProgressInputFromSala({
        nameConfirmed: false,
        phonePresent: false,
        conteosPorCarpeta: { room_financial: 1, room_corporate: 1 },
      })
    )

    expect(progress.percent).toBe(40)
    expect(progress.siguientePaso).toBe('items.nameConfirmed')
    expect(progress.checklist.find((item) => item.key === 'nameConfirmed')?.done).toBe(false)
  })
})
