// ============================================================================
// ESTADO DE LOS COMANDOS DEL ÁRBOL DE LA SALA
// ============================================================================
// Decidir si una selección se puede mover y si un drop de archivos ajenos se
// encola es lógica pura: la sala la corre en el mismo gesto del cliente.
//
// El único catálogo que se estrecha en runtime es el ciclo de vida del
// documento, porque llega como string de una fila de Convex. El desenlace de un
// movimiento y los ocho motivos de rechazo solo describen: se escriben como
// uniones directas.
// ============================================================================

import { Schema } from 'effect'

import { VDR_SHELL_FOLDER_VALUES, getVdrShellFolderValue } from '@/lib/vdr/document-taxonomy'

const DocumentLifecycleStatusSchema = Schema.Literals(['ACTIVE', 'QUARANTINED', 'ARCHIVED'])

/** Ni un documento en cuarentena ni uno archivado se mueven de carpeta. */
const isMovableLifecycleStatus = Schema.is(
  Schema.NullOr(Schema.UndefinedOr(DocumentLifecycleStatusSchema.pick(['ACTIVE'])))
)

type MovableRoomDocument = {
  _id: string
  folder?: string | null
  lifecycleStatus?: typeof DocumentLifecycleStatusSchema.Type | null
}

export function roomUploadScopeKey(
  companyId: string,
  room: { kind: 'COMPANY'; id: string }
) {
  return [companyId, room.kind, room.id].join('\u0000')
}

/**
 * Un grupo que ya vive completo en la carpeta destino NO es un fallo: no hay
 * nada que mover. Se representa aparte para que la confirmación se cierre con
 * su aviso en vez de quedarse abierta en silencio.
 */
export type ResolvedRoomDocumentMove =
  | { status: 'MOVE'; documentIds: string[]; targetFolderId: string }
  | { status: 'NOOP' }
  | { status: 'INVALID' }

export type RoomDocumentMoveOutcome = 'MOVED' | 'NOOP' | 'FAILED'

export function resolveRoomDocumentMove({
  documents,
  documentIds,
  targetFolderId,
}: {
  documents: readonly MovableRoomDocument[]
  documentIds: readonly string[]
  targetFolderId: string
}): ResolvedRoomDocumentMove {
  if (!VDR_SHELL_FOLDER_VALUES.includes(targetFolderId)) return { status: 'INVALID' }

  const documentsById = new Map(documents.map((document) => [document._id, document]))
  const seen = new Set<string>()
  const eligibleIds: string[] = []
  let alreadyInTarget = 0

  for (const documentId of documentIds) {
    if (seen.has(documentId)) continue
    seen.add(documentId)

    const document = documentsById.get(documentId)
    if (!document) continue
    if (!isMovableLifecycleStatus(document.lifecycleStatus)) continue
    if (getVdrShellFolderValue(document.folder) === targetFolderId) {
      alreadyInTarget += 1
      continue
    }
    eligibleIds.push(documentId)
  }

  if (eligibleIds.length > 0) return { status: 'MOVE', documentIds: eligibleIds, targetFolderId }
  return alreadyInTarget > 0 ? { status: 'NOOP' } : { status: 'INVALID' }
}

type ForeignDropRejectionReason =
  | 'EMPTY_FILES'
  | 'INVALID_TARGET'
  | 'READ_ONLY'
  | 'UPLOADING'
  | 'VERSION_REPLACEMENT'
  | 'PENDING_CONFIRMATION'
  | 'NO_PENDING_CONFIRMATION'
  | 'ROOM_SCOPE_CHANGED'

export type ForeignDropPlan =
  | { status: 'QUEUE'; targetFolderId: string }
  | {
      status: 'CONFIRMATION_REQUIRED'
      currentFolderId: string
      targetFolderId: string
      fileCount: number
    }
  | { status: 'REJECTED'; reason: ForeignDropRejectionReason }

export type ForeignDropQueueResult =
  | {
      status: 'QUEUED'
      targetFolderId: string
      queuedCount: number
      droppedOverLimit: number
    }
  | Extract<ForeignDropPlan, { status: 'CONFIRMATION_REQUIRED' | 'REJECTED' }>

export function planForeignFileDrop({
  files,
  targetFolderId,
  queueLength,
  currentFolderId,
  isReadOnly = false,
  isUploading = false,
  isReplacingVersion = false,
  hasPendingConfirmation = false,
}: {
  files: readonly File[]
  targetFolderId: string
  queueLength: number
  currentFolderId: string
  isReadOnly?: boolean
  isUploading?: boolean
  isReplacingVersion?: boolean
  hasPendingConfirmation?: boolean
}): ForeignDropPlan {
  if (files.length === 0) return { status: 'REJECTED', reason: 'EMPTY_FILES' }
  if (!VDR_SHELL_FOLDER_VALUES.includes(targetFolderId)) {
    return { status: 'REJECTED', reason: 'INVALID_TARGET' }
  }
  if (isReadOnly) return { status: 'REJECTED', reason: 'READ_ONLY' }
  if (isUploading) return { status: 'REJECTED', reason: 'UPLOADING' }
  if (isReplacingVersion) return { status: 'REJECTED', reason: 'VERSION_REPLACEMENT' }
  if (hasPendingConfirmation) {
    return { status: 'REJECTED', reason: 'PENDING_CONFIRMATION' }
  }
  if (queueLength === 0 || currentFolderId === targetFolderId) {
    return { status: 'QUEUE', targetFolderId }
  }
  return {
    status: 'CONFIRMATION_REQUIRED',
    currentFolderId,
    targetFolderId,
    fileCount: files.length,
  }
}
