'use client'

// ============================================================================
// ROOM FOLDER TREE
// ============================================================================
// Árbol izquierdo del shell: cinco carpetas fijas de primer nivel, sin
// subcarpetas. Seleccionar un archivo NO lo abre — solo lo lleva al centro.
// ============================================================================

import { Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { HierarchyTree } from '@/components/hierarchy/HierarchyTree'
import { formatRoomFileSize, type RoomShellDocument } from '@/lib/documents/room-shell'
import type { RoomBulkSelection } from '@/lib/documents/room-bulk-selection'
import type {
  HierarchyNode,
  HierarchyRevealRequest,
  HierarchyRowViewModel,
  HierarchyRowVisual,
} from '@/lib/hierarchy/types'
import { VDR_SHELL_FOLDERS } from '@/lib/vdr/document-taxonomy'
import type { RoomDocumentMoveOutcome } from '@/lib/documents/room-tree-command-state'
import type { RoomLocale, RoomShellCopy } from './copy'
import { roomAccessLabel, roomStatusLabel } from './RoomDocumentInfoDialog'

/**
 * Los dos estados que sacan a un documento de las acciones del árbol: no se
 * arrastra, no se mueve y no se puede marcar en un lote.
 *
 * La regla estaba escrita tres veces en este archivo —al decidir si se puede
 * mover, al deshabilitar la fila y al etiquetar la casilla— y las tres tenían
 * que decir lo mismo por disciplina. Ahora es una lista y un predicado.
 */
const LockedDocumentStatus = Schema.Literals(['QUARANTINED', 'ARCHIVED'])

const isLockedStatus = Schema.is(LockedDocumentStatus)

function isLockedDocument(document: RoomShellDocument): boolean {
  return isLockedStatus(document.status)
}

const KIND_VISUALS: Record<RoomShellDocument['kind'], HierarchyRowVisual> = {
  spreadsheet: 'spreadsheet',
  pdf: 'pdf',
  document: 'document',
  presentation: 'presentation',
  image: 'image',
  other: 'file',
}

export type RoomTreeActions = {
  onSelect: (document: RoomShellDocument) => void
  onOpen: (document: RoomShellDocument) => void
  onMoveDocuments: (
    documentIds: readonly string[],
    targetFolderId: string
  ) => Promise<RoomDocumentMoveOutcome>
  onRenameDocument: (documentId: string, nextName: string) => Promise<boolean>
  onQueueForeignFiles: (files: readonly File[], targetFolderId: string) => void
}

type Props = {
  copy: RoomShellCopy
  locale: RoomLocale
  documents: readonly RoomShellDocument[]
  totals: Readonly<Record<string, number>>
  loadedTotals?: Readonly<Record<string, number>>
  unfilteredTotals?: Readonly<Record<string, number>>
  searchTerm?: string
  onClearSearch?: () => void
  expandedFolders: ReadonlySet<string>
  onToggleFolder: (folder: string) => void
  selectedDocumentId: string | null
  actions: RoomTreeActions
  revealRequest?: HierarchyRevealRequest
  bulkSelection?: RoomBulkSelection
}

function folderEmptyContent(
  copy: RoomShellCopy,
  folder: string,
  matchCount: number,
  loadedCount: number,
  raw: number,
  searchTerm: string,
  onClearSearch: (() => void) | undefined
) {
  if (matchCount > 0 && loadedCount === 0) return copy.folderMoreBelow(matchCount)
  if (searchTerm.length > 0 && raw > 0 && matchCount === 0) {
    return (
      <span className="flex flex-col items-start gap-2">
        <span className="text-foreground font-medium">{copy.folderNoMatchesTitle}</span>
        <span>{copy.folderNoMatches(raw, searchTerm)}</span>
        {onClearSearch ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1 h-9"
            onClick={onClearSearch}
          >
            {copy.clearSearch}
          </Button>
        ) : null}
      </span>
    )
  }
  return copy.emptyFolder(folder)
}

export function RoomFolderTree({
  copy,
  locale,
  documents,
  totals,
  loadedTotals,
  unfilteredTotals,
  searchTerm = '',
  onClearSearch,
  expandedFolders,
  onToggleFolder,
  selectedDocumentId,
  actions,
  revealRequest,
  bulkSelection,
}: Props) {
  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const folderIds = new Set(VDR_SHELL_FOLDERS.map((folder) => folder.value))
  const isMovableDocument = (documentId: string) => {
    const document = documentsById.get(documentId)
    return document !== undefined && !isLockedDocument(document)
  }
  const nodes: HierarchyNode[] = [
    ...VDR_SHELL_FOLDERS.map((folder) => ({
      id: folder.value,
      parentId: null,
      kind: 'branch' as const,
      label: folder.label[locale],
    })),
    ...documents.map((document) => ({
      id: document.id,
      parentId: document.folder,
      kind: 'leaf' as const,
      label: document.name,
      disabled: bulkSelection !== undefined && isLockedDocument(document),
    })),
  ]
  const rowViewModels: HierarchyRowViewModel[] = [
    ...VDR_SHELL_FOLDERS.map((folder) => ({
      nodeId: folder.value,
      variant: 'folder' as const,
      leadingVisual: 'folder' as const,
      attributes: {
        'data-testid': 'room-folder',
        'data-folder': folder.value,
      },
      trailingAttributes: {
        'data-testid': 'room-folder-count',
        'data-folder': folder.value,
      },
      trailingText: String(totals[folder.value] ?? 0),
      emptyText: folderEmptyContent(
        copy,
        folder.value,
        totals[folder.value] ?? 0,
        (loadedTotals ?? totals)[folder.value] ?? 0,
        (unfilteredTotals ?? totals)[folder.value] ?? 0,
        searchTerm,
        onClearSearch
      ),
      checkboxLabel: copy.bulkSelectLoadedFolder(folder.label[locale]),
    })),
    ...documents.map((document) => ({
      nodeId: document.id,
      variant: 'file' as const,
      leadingVisual: KIND_VISUALS[document.kind],
      attributes: {
        'data-testid': 'room-file',
        'data-document-id': document.id,
        'data-hierarchy-node-id': document.id,
      },
      primaryTitle: document.name,
      versionText:
        document.versionNumber && document.versionNumber > 1
          ? copy.versionShort(document.versionNumber)
          : undefined,
      badgeText:
        document.accessLevel === 'NDA_REQUIRED'
          ? undefined
          : roomAccessLabel(document.accessLevel, copy),
      attentionText:
        document.status === 'READY' ? undefined : roomStatusLabel(document.status, copy),
      trailingText:
        document.status === 'READY' ? formatRoomFileSize(document.sizeBytes, locale) : undefined,
      checkboxLabel: isLockedDocument(document)
        ? copy.bulkDocumentDisabled(document.name, roomStatusLabel(document.status, copy))
        : copy.bulkSelectDocument(document.name),
    })),
  ]

  return (
    <HierarchyTree
      ariaLabel={copy.tree}
      containerAttributes={{ 'data-testid': 'room-tree' }}
      containerClassName="p-2"
      nodes={nodes}
      preset={bulkSelection ? 'pick-many' : 'browse'}
      selectedIds={selectedDocumentId ? [selectedDocumentId] : []}
      checkedIds={bulkSelection ? [...bulkSelection.selectedIds] : []}
      expandedIds={[...expandedFolders]}
      selectionPolicy={{
        parentPropagation: bulkSelection ? 'descendants' : 'none',
        preserveHiddenSelection: bulkSelection !== undefined,
      }}
      revealRequest={revealRequest}
      rowViewModels={rowViewModels}
      announcements={{
        selectionChanged: copy.treeSelectionChanged,
        activeChanged: bulkSelection ? copy.treeActiveChanged : undefined,
        selectionLimitReached: copy.treeSelectionLimitReached,
        revealed: copy.treeRevealed,
        rename: {
          inputLabel: copy.renameInput,
          pending: copy.renamePending,
          succeeded: copy.renameSucceeded,
          failed: copy.renameFailed,
          cancelled: copy.renameCancelled,
          empty: copy.renameEmpty,
        },
      }}
      onSelectionChange={(selectedIds) => {
        const selected = selectedIds[0] ? documentsById.get(selectedIds[0]) : undefined
        if (selected) actions.onSelect(selected)
      }}
      onCheckedChange={(ids, checked) => {
        if (!bulkSelection) return
        if (ids.length === 1) bulkSelection.onToggle(ids[0], checked)
        else bulkSelection.onSelectMany(ids, checked)
      }}
      onExpandedChange={(nextExpandedIds) => {
        const next = new Set(nextExpandedIds)
        for (const folder of VDR_SHELL_FOLDERS) {
          if (next.has(folder.value) !== expandedFolders.has(folder.value)) {
            onToggleFolder(folder.value)
          }
        }
      }}
      onActivateLeaf={(id) => {
        const document = documentsById.get(id)
        if (document) actions.onOpen(document)
      }}
      nodeDrop={{
        canDrag: (nodeIds) =>
          nodeIds.length > 0 && nodeIds.every((documentId) => isMovableDocument(documentId)),
        canDrop: ({ nodeIds, targetBranchId }) =>
          folderIds.has(targetBranchId) &&
          nodeIds.some(
            (documentId) =>
              isMovableDocument(documentId) &&
              documentsById.get(documentId)?.folder !== targetBranchId
          ),
        onDrop: async ({ nodeIds, targetBranchId }) => {
          await actions.onMoveDocuments(nodeIds, targetBranchId)
        },
      }}
      foreignFileDrop={{
        canDragOver: (targetBranchId) => folderIds.has(targetBranchId),
        canDrop: ({ files, targetBranchId }) => files.length > 0 && folderIds.has(targetBranchId),
        onDrop: ({ files, targetBranchId }) => {
          actions.onQueueForeignFiles(files, targetBranchId)
        },
      }}
      onRenameLeaf={actions.onRenameDocument}
    />
  )
}
