import type { ReactNode } from 'react'
import { Schema } from 'effect'

// Los cuatro presets declarados. `presets.ts` saca de acá, con `pick`, los dos
// que tienen comportamiento: escritos a mano allá eran una segunda lista, y
// renombrar un preset dejaba `resolveHierarchyPreset` tirando para todos.
export const HierarchyPresetSchema = Schema.Literals(['browse', 'pick-one', 'pick-many', 'review'])
export type HierarchyPreset = typeof HierarchyPresetSchema.Type

export type HierarchyNode = {
  id: string
  parentId: string | null
  kind: 'branch' | 'leaf'
  label: string
  disabled?: boolean
}

type HierarchySelectionPolicy = {
  maxSelected?: number
  parentPropagation: 'none' | 'descendants'
  preserveHiddenSelection: boolean
}

export type HierarchyRevealRequest = {
  id: string
  nonce: string | number
}

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
export type HierarchyRowVisual =
  'folder' | 'file' | 'spreadsheet' | 'pdf' | 'document' | 'presentation' | 'image'

export type HierarchyRowViewModel = {
  nodeId: string
  variant?: 'default' | 'folder' | 'file'
  leadingVisual?: HierarchyRowVisual
  attributes?: Readonly<Record<string, string>>
  trailingAttributes?: Readonly<Record<string, string>>
  primaryTitle?: string
  secondaryText?: string
  trailingText?: string
  statusText?: string
  versionText?: string
  badgeText?: string
  attentionText?: string
  emptyText?: ReactNode
  checkboxLabel?: string
}

export type HierarchyAnnouncements = {
  selectionChanged: (selectedCount: number) => string
  activeChanged?: (label: string) => string
  selectionLimitReached: (maxSelected: number) => string
  revealed: (label: string) => string
  rename?: HierarchyRenameAnnouncements
}

type HierarchyRenameAnnouncements = {
  inputLabel: (currentLabel: string) => string
  pending: (nextLabel: string) => string
  succeeded: (nextLabel: string) => string
  failed: (originalLabel: string) => string
  cancelled: (originalLabel: string) => string
  empty: string
}

export type HierarchyNodeDropRequest = {
  nodeIds: readonly string[]
  targetBranchId: string
}

type HierarchyNodeDropInteraction = {
  canDrag: (nodeIds: readonly string[]) => boolean
  canDrop: (request: HierarchyNodeDropRequest) => boolean
  onDrop: (request: HierarchyNodeDropRequest) => void | Promise<void>
}

export type HierarchyForeignFileDropRequest = {
  files: readonly File[]
  targetBranchId: string
}

/**
 * The three foreign-drop callbacks are intentionally one atomic contract.
 * Browser-native transfer objects never cross the hierarchy adapter boundary.
 */
type HierarchyForeignFileDropInteraction = {
  canDragOver: (targetBranchId: string) => boolean
  canDrop: (request: HierarchyForeignFileDropRequest) => boolean
  onDrop: (request: HierarchyForeignFileDropRequest) => void | Promise<void>
}

export type HierarchyProps = {
  ariaLabel: string
  containerAttributes?: Readonly<Record<string, string>>
  containerClassName?: string
  nodes: readonly HierarchyNode[]
  preset: HierarchyPreset
  /** Fila activa del árbol. No representa el conjunto marcado para bulk. */
  selectedIds: readonly string[]
  /** Conjunto marcado para operaciones múltiples; puede contener nodos ocultos. */
  checkedIds?: readonly string[]
  expandedIds: readonly string[]
  selectionPolicy: HierarchySelectionPolicy
  revealRequest?: HierarchyRevealRequest
  rowViewModels?: readonly HierarchyRowViewModel[]
  announcements: HierarchyAnnouncements
  onSelectionChange: (selectedIds: readonly string[]) => void
  onCheckedChange?: (ids: readonly string[], checked: boolean) => void
  onExpandedChange: (expandedIds: readonly string[]) => void
  onActivateLeaf?: (id: string) => void
  nodeDrop?: HierarchyNodeDropInteraction
  foreignFileDrop?: HierarchyForeignFileDropInteraction
  onRenameLeaf?: (id: string, nextLabel: string) => Promise<boolean>
}
