'use client'

import {
  checkboxesFeature,
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react/react-compiler'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Presentation,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { Effect, Exit, Schema } from 'effect'

import { Checkbox } from '@/components/ui/checkbox'
import { runClientFork } from '@/lib/effect/client-runtime'
import { resolveHierarchyPreset } from '@/lib/hierarchy/presets'
import type {
  HierarchyNode,
  HierarchyForeignFileDropRequest,
  HierarchyNodeDropRequest,
  HierarchyProps,
  HierarchyRowViewModel,
  HierarchyRowVisual,
} from '@/lib/hierarchy/types'

const ROOT_ID = '__sherlock_hierarchy_root__'
const ROOT_NODE: HierarchyNode = {
  id: ROOT_ID,
  parentId: null,
  kind: 'branch',
  label: '',
}
const TREE_FEATURES = [
  syncDataLoaderFeature,
  selectionFeature,
  checkboxesFeature,
  hotkeysCoreFeature,
  dragAndDropFeature,
  renamingFeature,
]
const TREE_FEATURES_WITHOUT_DND = [
  syncDataLoaderFeature,
  selectionFeature,
  checkboxesFeature,
  hotkeysCoreFeature,
  renamingFeature,
]
const TYPEAHEAD_TIMEOUT_MS = 700
// Las teclas que la guía APG le reserva al árbol: el navegador no debe hacer lo
// suyo con ellas. Era un `Set<string>` que aceptaba cualquier cadena; ahora la
// lista tiene tipo y la pertenencia se pregunta con él.
const ApgNavigationKeySchema = Schema.Literals([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  '*',
])
const isApgNavigationKey = Schema.is(ApgNavigationKeySchema)
const ROW_VISUALS: Record<Exclude<HierarchyRowVisual, 'folder'>, typeof File> = {
  file: File,
  spreadsheet: FileSpreadsheet,
  pdf: FileText,
  document: FileText,
  presentation: Presentation,
  image: FileImage,
}

// ===== LA COSTURA CON EFFECT =====
// Guardar un nombre nuevo es la única llamada que sale de este árbol, y para la
// fila solo hay dos finales: quedó guardado o no. Antes eran dos ramas de una
// promesa con el MISMO bloque de comprobaciones y la MISMA limpieza escritos
// dos veces, una para el rechazo y otra para el `false`. Un rechazo es un no,
// así que es un solo final.
const renameLeafNode = Effect.fn('Hierarchy.renameLeaf')(function* (
  rename: () => Promise<boolean> | boolean
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise({
    try: async () => rename(),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => false))
})

type LabelOverride = {
  label: string
  sourceLabel: string
}

// Solo «Documento activo» describe un estado actual y guarda su nodo: cuando ese
// nodo sale de la proyección, el anuncio se vacía y no vuelve aunque el id
// regrese. Los demás anuncios cuentan el resultado de una acción (renombre,
// revelado, conteo, límite) y conservan su texto; no guardan nodo.
// El discriminante `kind` separa el conteo de selección del resto: la selección
// es una prop controlada que el llamador puede vaciar desde afuera (botón
// «Limpiar», o filas que desaparecen tras un borrado), y solo ese anuncio se
// retira cuando eso pasa.
type Announcement = {
  text: string
  nodeId: string | null
  kind: 'selection' | 'other'
}

const NO_ANNOUNCEMENT: Announcement = { text: '', nodeId: null, kind: 'other' }

type RenameSession = {
  token: number
  id: string
  originalLabel: string
  draft: string
  status: 'idle' | 'pending'
  focusOrder: readonly string[]
  focusIndex: number
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function resolveUpdater(
  current: readonly string[],
  update: string[] | ((previous: string[]) => string[])
): string[] {
  return typeof update === 'function' ? update([...current]) : update
}

function hasFileTransfer(
  dataTransfer: DataTransfer | null | undefined
): dataTransfer is DataTransfer {
  return Boolean(dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files'))
}

function foreignFileRequest(
  dataTransfer: DataTransfer,
  targetBranchId: string
): HierarchyForeignFileDropRequest | null {
  if (!hasFileTransfer(dataTransfer)) return null
  const files = Array.from(dataTransfer.files ?? [])
  return files.length > 0 ? { files, targetBranchId } : null
}

function normalizeTypeahead(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function rowClassName(row: HierarchyRowViewModel | undefined, selected: boolean) {
  if (row?.variant === 'folder') {
    return 'hover:bg-primary/8 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 lg:min-h-9'
  }
  if (row?.variant === 'file') {
    return `focus-visible:ring-ring flex min-h-11 w-full min-w-0 items-center gap-2 rounded-sm border-l-2 py-1.5 pr-2 pl-2 text-left text-sm outline-none focus-visible:ring-2 lg:min-h-9 ${
      selected
        ? 'border-primary bg-primary/12 text-foreground font-medium'
        : 'hover:bg-primary/8 border-transparent'
    }`
  }
  return 'focus-visible:ring-ring flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2'
}

export function HierarchyTree({
  ariaLabel,
  containerAttributes,
  containerClassName,
  nodes,
  preset,
  selectedIds,
  checkedIds = [],
  expandedIds,
  selectionPolicy,
  revealRequest,
  rowViewModels = [],
  announcements,
  onSelectionChange,
  onCheckedChange,
  onExpandedChange,
  onActivateLeaf,
  nodeDrop,
  foreignFileDrop,
  onRenameLeaf,
}: HierarchyProps) {
  const behavior = resolveHierarchyPreset(preset)
  const [announcement, setAnnouncement] = useState<Announcement>(NO_ANNOUNCEMENT)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [renameSession, setRenameSessionState] = useState<RenameSession | null>(null)
  // El override optimista guarda la etiqueta que la fuente traía al aplicarlo:
  // cualquier transición autoritativa posterior (normalizada por el servidor o
  // por otra sesión) lo retira, no solo la que coincide con el nuevo nombre.
  const [labelOverrides, setLabelOverrides] = useState<Readonly<Record<string, LabelOverride>>>({})
  const [previousNodes, setPreviousNodes] = useState(nodes)
  const [announcedCheckedCount, setAnnouncedCheckedCount] = useState(checkedIds.length)
  const renameSessionRef = useRef<RenameSession | null>(null)
  const focusedIdRef = useRef<string | null>(null)
  const lastDomFocusedIdRef = useRef<string | null>(null)
  const dragGroupRef = useRef<readonly string[] | null>(null)
  const renameCommitRef = useRef(new Set<number>())
  const renameTokenRef = useRef(0)
  const activeRenameTokenRef = useRef<number | null>(null)
  const renameSelectionTokenRef = useRef<number | null>(null)
  const focusRequestTokenRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const typeaheadRef = useRef({ buffer: '', lastTypedAt: 0 })
  const projection = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const children = new Map<string, string[]>()
    children.set(ROOT_ID, [])

    for (const node of nodes) {
      const parentId = node.parentId ?? ROOT_ID
      const siblings = children.get(parentId) ?? []
      siblings.push(node.id)
      children.set(parentId, siblings)
      if (node.kind === 'branch' && !children.has(node.id)) children.set(node.id, [])
    }

    return { byId, children }
  }, [nodes])
  const projectionRef = useRef(projection)
  useEffect(() => {
    projectionRef.current = projection
  }, [projection])
  if (previousNodes !== nodes) {
    setPreviousNodes(nodes)
    setLabelOverrides((current) => {
      const next = { ...current }
      let changed = false
      for (const [id, override] of Object.entries(current)) {
        const sourceNode = projection.byId.get(id)
        if (!sourceNode || sourceNode.label !== override.sourceLabel) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
    setAnnouncement((current) =>
      current.nodeId !== null && !projection.byId.has(current.nodeId) ? NO_ANNOUNCEMENT : current
    )
  }
  // `checkedIds` es controlada: el llamador la vacía desde afuera (botón
  // «Limpiar», o filas que ya no están tras un borrado masivo) sin pasar por
  // `requestCheckedChange`. Cuando eso deja la selección en cero, el conteo que
  // quedó en el live region deja de ser cierto y se retira.
  if (announcedCheckedCount !== checkedIds.length) {
    setAnnouncedCheckedCount(checkedIds.length)
    if (checkedIds.length === 0) {
      setAnnouncement((current) => (current.kind === 'selection' ? NO_ANNOUNCEMENT : current))
    }
  }
  const setControlledRenameSession = (next: RenameSession | null) => {
    renameSessionRef.current = next
    setRenameSessionState(next)
  }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeRenameTokenRef.current = null
      focusRequestTokenRef.current = null
    }
  }, [])
  const previousProjectionRef = useRef(projection)
  const projectionKey = JSON.stringify(
    nodes.map(({ id, parentId, kind }) => [id, parentId, kind] as const)
  )
  const rowViewModelsById = useMemo(
    () => new Map(rowViewModels.map((row) => [row.nodeId, row])),
    [rowViewModels]
  )
  const loadedEligibleIds = useMemo(
    () => nodes.filter((node) => node.kind === 'leaf' && !node.disabled).map((node) => node.id),
    [nodes]
  )
  const loadedEligibleSet = useMemo(() => new Set(loadedEligibleIds), [loadedEligibleIds])
  const visibleSelectedIds = selectedIds.filter((id) => projection.byId.has(id))
  const loadedCheckedIds = checkedIds.filter((id) => loadedEligibleSet.has(id))
  const controlledExpandedIds = useMemo(() => [...expandedIds], [expandedIds])
  const controlledFocusedId =
    focusedId && projection.byId.has(focusedId) ? focusedId : (visibleSelectedIds[0] ?? null)
  const maxSelected = behavior.maxSelected ?? selectionPolicy.maxSelected
  const rangeAnchorRef = useRef<string | null>(null)
  const tombstoneNodesRef = useRef(new Map<string, HierarchyNode>())

  const getTombstoneNode = (id: string) => {
    const existing = tombstoneNodesRef.current.get(id)
    if (existing) return existing
    const tombstone: HierarchyNode = {
      id,
      parentId: null,
      kind: 'leaf',
      label: '',
      disabled: true,
    }
    tombstoneNodesRef.current.set(id, tombstone)
    return tombstone
  }

  useEffect(() => {
    // Preserve a removed node until the projection rebuild can recover its
    // parent or nearest visible fallback. Clearing the ref here races that
    // recovery when filtering removes the focused row.
    if (controlledFocusedId !== null) focusedIdRef.current = controlledFocusedId
  }, [controlledFocusedId])

  const commitActiveSelection = (requestedIds: readonly string[]) => {
    const candidates = unique(requestedIds).filter((id) => projection.byId.has(id))
    const nextSelectedIds = behavior.selection === 'single' ? candidates.slice(-1) : candidates
    if (!sameIds(nextSelectedIds, selectedIds)) onSelectionChange(nextSelectedIds)
    const activeId = nextSelectedIds.at(-1)
    if (activeId) {
      const label = projection.byId.get(activeId)?.label ?? activeId
      setAnnouncement(
        announcements.activeChanged
          ? { text: announcements.activeChanged(label), nodeId: activeId, kind: 'other' }
          : {
              text: announcements.selectionChanged(nextSelectedIds.length),
              nodeId: null,
              kind: 'selection',
            }
      )
    }
  }

  const requestCheckedChange = (ids: readonly string[], checked: boolean) => {
    if (!onCheckedChange) return
    const eligibleIds = unique(ids).filter((id) => loadedEligibleSet.has(id))
    if (eligibleIds.length === 0) return

    if (checked && maxSelected !== undefined) {
      const next = new Set(checkedIds)
      for (const id of eligibleIds) next.add(id)
      if (next.size > maxSelected) {
        setAnnouncement({
          text: announcements.selectionLimitReached(maxSelected),
          nodeId: null,
          kind: 'other',
        })
        return
      }
    }

    onCheckedChange(eligibleIds, checked)
    const nextCount = checked
      ? new Set([...checkedIds, ...eligibleIds]).size
      : checkedIds.filter((id) => !eligibleIds.includes(id)).length
    setAnnouncement({
      text: announcements.selectionChanged(nextCount),
      nodeId: null,
      kind: 'selection',
    })
  }

  const renderedEligibleDragGroup = (leadId: string): readonly string[] => {
    const lead = projection.byId.get(leadId)
    if (!lead || lead.kind !== 'leaf' || lead.disabled) return []
    if (!checkedIds.includes(leadId)) return [leadId]
    return tree()
      .getItems()
      .map((item) => item.getItemData())
      .filter((node) => node.kind === 'leaf' && !node.disabled && checkedIds.includes(node.id))
      .map((node) => node.id)
  }

  const resolveBranchTarget = (targetId: string): string | null => {
    if (targetId === ROOT_ID) return null
    return projection.byId.get(targetId)?.kind === 'branch' ? targetId : null
  }

  const renderedItemIds = () =>
    tree()
      .getItems()
      .map((item) => item.getId())

  const tree = useTree<HierarchyNode>({
    rootItemId: ROOT_ID,
    state: {
      expandedItems: controlledExpandedIds,
      selectedItems: [...visibleSelectedIds],
      checkedItems: [...loadedCheckedIds],
      focusedItem: controlledFocusedId,
      renamingItem: renameSession?.id ?? null,
      renamingValue: renameSession?.draft ?? '',
    },
    setExpandedItems: (update) =>
      onExpandedChange(
        unique(resolveUpdater(expandedIds, update)).filter((id) => projection.byId.has(id))
      ),
    setSelectedItems: (update) => commitActiveSelection(resolveUpdater(visibleSelectedIds, update)),
    setCheckedItems: (update) => {
      const next = resolveUpdater(loadedCheckedIds, update)
      const added = next.filter((id) => !loadedCheckedIds.includes(id))
      const removed = loadedCheckedIds.filter((id) => !next.includes(id))
      if (added.length > 0) requestCheckedChange(added, true)
      if (removed.length > 0) requestCheckedChange(removed, false)
    },
    setFocusedItem: (update) =>
      setFocusedId((current) => {
        const next = typeof update === 'function' ? update(current) : update
        focusedIdRef.current = next
        return next
      }),
    setRenamingItem: (update) => {
      const current = renameSessionRef.current
      const currentId = current?.id ?? null
      const nextId = typeof update === 'function' ? update(currentId) : update
      if (current?.status === 'pending') return
      if (!nextId) {
        setControlledRenameSession(null)
        activeRenameTokenRef.current = null
        return
      }
      const node = projection.byId.get(nextId)
      if (
        !node ||
        node.kind !== 'leaf' ||
        node.disabled ||
        !onRenameLeaf ||
        !announcements.rename ||
        current?.id === nextId
      ) {
        return
      }
      const label = labelOverrides[nextId]?.label ?? node.label
      const focusOrder = renderedItemIds()
      const token = ++renameTokenRef.current
      const nextSession: RenameSession = {
        token,
        id: nextId,
        originalLabel: label,
        draft: label,
        status: 'idle',
        focusOrder,
        focusIndex: Math.max(0, focusOrder.indexOf(nextId)),
      }
      activeRenameTokenRef.current = token
      focusRequestTokenRef.current = token
      setControlledRenameSession(nextSession)
    },
    setRenamingValue: (update) => {
      const current = renameSessionRef.current
      if (!current || current.status === 'pending') return
      const resolvedDraft = typeof update === 'function' ? update(current.draft) : update
      const nextDraft: string = resolvedDraft ?? current.draft
      setControlledRenameSession({ ...current, draft: nextDraft })
    },
    getItemName: (item) => labelOverrides[item.getId()]?.label ?? item.getItemData().label,
    isItemFolder: (item) => item.getItemData().kind === 'branch',
    dataLoader: {
      getItem: (itemId) =>
        itemId === ROOT_ID ? ROOT_NODE : (projection.byId.get(itemId) ?? getTombstoneNode(itemId)),
      getChildren: (itemId) => projection.children.get(itemId) ?? [],
    },
    canCheckFolders: false,
    propagateCheckedState: selectionPolicy.parentPropagation === 'descendants',
    canReorder: false,
    canDrag: (items) => {
      if (!nodeDrop || items.length === 0) return false
      const group = renderedEligibleDragGroup(items[0]?.getId() ?? '')
      dragGroupRef.current = group
      return group.length > 0 && nodeDrop.canDrag(group)
    },
    canDrop: (items, target) => {
      if (!nodeDrop) return false
      const targetBranchId = resolveBranchTarget(target.item.getId())
      if (!targetBranchId) return false
      const group = dragGroupRef.current ?? renderedEligibleDragGroup(items[0]?.getId() ?? '')
      return (
        group.length > 0 &&
        nodeDrop.canDrop({ nodeIds: group, targetBranchId } satisfies HierarchyNodeDropRequest)
      )
    },
    onDrop: async (items, target) => {
      if (!nodeDrop) return
      const targetBranchId = resolveBranchTarget(target.item.getId())
      const group = dragGroupRef.current ?? renderedEligibleDragGroup(items[0]?.getId() ?? '')
      dragGroupRef.current = null
      if (!targetBranchId || group.length === 0) return
      const request = { nodeIds: group, targetBranchId } satisfies HierarchyNodeDropRequest
      if (!nodeDrop.canDrop(request)) return
      await nodeDrop.onDrop(request)
    },
    canDragForeignDragObjectOver: (dataTransfer, target) => {
      const targetBranchId = resolveBranchTarget(target.item.getId())
      return Boolean(
        foreignFileDrop &&
        targetBranchId &&
        hasFileTransfer(dataTransfer) &&
        foreignFileDrop.canDragOver(targetBranchId)
      )
    },
    canDropForeignDragObject: (dataTransfer, target) => {
      const targetBranchId = resolveBranchTarget(target.item.getId())
      if (!foreignFileDrop || !targetBranchId) return false
      const request = foreignFileRequest(dataTransfer, targetBranchId)
      return Boolean(request && foreignFileDrop.canDrop(request))
    },
    onDropForeignDragObject: async (dataTransfer, target) => {
      const targetBranchId = resolveBranchTarget(target.item.getId())
      if (!foreignFileDrop || !targetBranchId) return
      const request = foreignFileRequest(dataTransfer, targetBranchId)
      if (!request || !foreignFileDrop.canDrop(request)) return
      await foreignFileDrop.onDrop(request)
    },
    canRename: (item) => {
      const node = item.getItemData()
      return Boolean(
        onRenameLeaf &&
        announcements.rename &&
        renameSessionRef.current?.status !== 'pending' &&
        node.kind === 'leaf' &&
        !node.disabled
      )
    },
    hotkeys: {
      expandOrDown: {
        hotkey: 'ArrowRight',
        canRepeat: true,
        preventDefault: true,
        handler: () => {
          const item = tree().getFocusedItem()
          if (!item.isFolder()) return
          if (item.isExpanded()) {
            tree().focusNextItem()
            tree().updateDomFocus()
          } else {
            item.expand()
          }
        },
      },
    },
    features: nodeDrop || foreignFileDrop ? TREE_FEATURES : TREE_FEATURES_WITHOUT_DND,
  })

  const treeGetterRef = useRef(tree)
  useEffect(() => {
    treeGetterRef.current = tree
  })

  const didMountRef = useRef(false)
  // Headless Tree does not observe the caller's projection. Rebuild only when
  // ids, parentage, kind, or sibling order changes after the initial mount.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      previousProjectionRef.current = projectionRef.current
      return
    }

    const previousProjection = previousProjectionRef.current
    const previousFocusedId = focusedIdRef.current
    const activeElement = globalThis.document.activeElement
    const shouldRestoreDomFocus =
      activeElement?.getAttribute('role') === 'treeitem' ||
      (activeElement === globalThis.document.body &&
        lastDomFocusedIdRef.current === previousFocusedId)

    treeGetterRef.current().rebuildTree()

    const visibleIds = new Set(
      treeGetterRef
        .current()
        .getItems()
        .map((item) => item.getId())
    )
    const previousParentId = previousFocusedId
      ? previousProjection.byId.get(previousFocusedId)?.parentId
      : null
    const nextFocusedId =
      (previousFocusedId && visibleIds.has(previousFocusedId) ? previousFocusedId : null) ??
      (previousParentId && visibleIds.has(previousParentId) ? previousParentId : null) ??
      treeGetterRef.current().getItems()[0]?.getId() ??
      null

    if (nextFocusedId && (nextFocusedId !== previousFocusedId || shouldRestoreDomFocus)) {
      treeGetterRef.current().getItemInstance(nextFocusedId).setFocused()
    }
    if (nextFocusedId && shouldRestoreDomFocus) {
      treeGetterRef.current().updateDomFocus()
    }
    previousProjectionRef.current = projectionRef.current
  }, [projectionKey])

  const lastRevealNonceRef = useRef<string | number | undefined>(undefined)
  useEffect(() => {
    if (!revealRequest || lastRevealNonceRef.current === revealRequest.nonce) return

    const node = projection.byId.get(revealRequest.id)
    if (!node) return
    lastRevealNonceRef.current = revealRequest.nonce

    const ancestors: string[] = []
    let parentId = node.parentId
    while (parentId) {
      ancestors.unshift(parentId)
      parentId = projection.byId.get(parentId)?.parentId ?? null
    }
    for (const ancestorId of ancestors) {
      const ancestor = tree().getItemInstance(ancestorId)
      if (!ancestor.isExpanded()) ancestor.expand()
    }

    const revealedItem = tree().getItemInstance(revealRequest.id)
    revealedItem.setFocused()
    tree().updateDomFocus()
    void revealedItem
      .scrollTo({ block: 'nearest', inline: 'nearest' })
      .then(() =>
        setAnnouncement({ text: announcements.revealed(node.label), nodeId: null, kind: 'other' })
      )
  }, [announcements, projection, revealRequest, tree])

  const activateLeaf = (node: HierarchyNode) => {
    if (behavior.activation === 'explicit' && !node.disabled) onActivateLeaf?.(node.id)
  }

  const selectLeaf = (node: HierarchyNode) => {
    commitActiveSelection([node.id])
  }

  const eligibleDescendantIds = (nodeId: string): string[] => {
    const result: string[] = []
    const visit = (parentId: string) => {
      for (const childId of projection.children.get(parentId) ?? []) {
        const child = projection.byId.get(childId)
        if (!child) continue
        if (child.kind === 'branch') visit(child.id)
        else if (!child.disabled) result.push(child.id)
      }
    }
    visit(nodeId)
    return result
  }

  const visibleEligibleIds = () =>
    tree()
      .getItems()
      .map((item) => item.getItemData())
      .filter((node) => node.kind === 'leaf' && !node.disabled)
      .map((node) => node.id)

  const toggleCheckedNode = (node: HierarchyNode, shiftKey = false) => {
    if (node.kind === 'branch') {
      const descendants = eligibleDescendantIds(node.id)
      const allChecked =
        descendants.length > 0 && descendants.every((id) => checkedIds.includes(id))
      requestCheckedChange(descendants, !allChecked)
      return
    }
    if (node.disabled) return

    const nextChecked = !checkedIds.includes(node.id)
    if (shiftKey && rangeAnchorRef.current) {
      const orderedIds = visibleEligibleIds()
      const anchorIndex = orderedIds.indexOf(rangeAnchorRef.current)
      const currentIndex = orderedIds.indexOf(node.id)
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const [start, end] =
          anchorIndex <= currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex]
        requestCheckedChange(orderedIds.slice(start, end + 1), nextChecked)
        rangeAnchorRef.current = node.id
        return
      }
    }

    requestCheckedChange([node.id], nextChecked)
    rangeAnchorRef.current = node.id
  }

  const focusItem = (id: string) => {
    tree().getItemInstance(id).setFocused()
    if (focusedIdRef.current !== id) {
      focusedIdRef.current = id
      setFocusedId(id)
    }
    lastDomFocusedIdRef.current = id
  }

  const setLabelOverride = (id: string, label: string) => {
    const sourceLabel = projectionRef.current.byId.get(id)?.label ?? label
    setLabelOverrides((current) => ({ ...current, [id]: { label, sourceLabel } }))
  }

  const removeLabelOverride = (id: string) => {
    setLabelOverrides((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const nearestVisibleItem = (session: RenameSession) => {
    const items = tree().getItems()
    const preferred = items.find((item) => item.getId() === session.id)
    if (preferred) return preferred
    const visibleIds = new Set(items.map((item) => item.getId()))
    for (let distance = 1; distance < session.focusOrder.length; distance += 1) {
      const afterId = session.focusOrder[session.focusIndex + distance]
      if (afterId && visibleIds.has(afterId)) {
        return items.find((item) => item.getId() === afterId)
      }
      const beforeId = session.focusOrder[session.focusIndex - distance]
      if (beforeId && visibleIds.has(beforeId)) {
        return items.find((item) => item.getId() === beforeId)
      }
    }
    return items[Math.min(session.focusIndex, Math.max(0, items.length - 1))]
  }

  const restoreVisibleRowFocus = (session: RenameSession) => {
    focusRequestTokenRef.current = session.token
    globalThis.setTimeout(() => {
      if (
        !mountedRef.current ||
        focusRequestTokenRef.current !== session.token ||
        activeRenameTokenRef.current !== null
      ) {
        return
      }
      const target = nearestVisibleItem(session)
      if (!target) return
      focusItem(target.getId())
      target.getElement()?.focus()
    }, 0)
  }

  const cancelRename = (session: RenameSession, restoreFocus: boolean) => {
    if (session.status === 'pending') return
    renameCommitRef.current.delete(session.token)
    activeRenameTokenRef.current = null
    setControlledRenameSession(null)
    setAnnouncement({
      text: announcements.rename?.cancelled(session.originalLabel) ?? '',
      nodeId: null,
      kind: 'other',
    })
    if (restoreFocus) restoreVisibleRowFocus(session)
  }

  const commitRename = (session: RenameSession) => {
    if (!onRenameLeaf || !announcements.rename || renameCommitRef.current.has(session.token)) return
    const nextLabel = session.draft.trim()
    if (!nextLabel) {
      setAnnouncement({ text: announcements.rename.empty, nodeId: null, kind: 'other' })
      return
    }

    renameCommitRef.current.add(session.token)
    setLabelOverride(session.id, nextLabel)
    const pendingSession = { ...session, draft: nextLabel, status: 'pending' as const }
    setControlledRenameSession(pendingSession)
    setAnnouncement({ text: announcements.rename.pending(nextLabel), nodeId: null, kind: 'other' })

    const fiber = runClientFork(renameLeafNode(() => onRenameLeaf(session.id, nextLabel)))
    fiber.addObserver((exit) => {
      renameCommitRef.current.delete(session.token)
      if (
        !Exit.isSuccess(exit) ||
        !mountedRef.current ||
        activeRenameTokenRef.current !== session.token ||
        renameSessionRef.current?.token !== session.token
      ) {
        return
      }
      if (exit.value) {
        setAnnouncement({
          text: announcements.rename?.succeeded(nextLabel) ?? '',
          nodeId: null,
          kind: 'other',
        })
      } else {
        removeLabelOverride(session.id)
        setAnnouncement({
          text: announcements.rename?.failed(session.originalLabel) ?? '',
          nodeId: null,
          kind: 'other',
        })
      }
      activeRenameTokenRef.current = null
      setControlledRenameSession(null)
      restoreVisibleRowFocus(session)
    })
  }

  const handleRowClick = (event: ReactMouseEvent<HTMLDivElement>, node: HierarchyNode) => {
    event.currentTarget.focus()
    focusItem(node.id)
    if (node.disabled || renameSession?.id === node.id) return

    // Un click en la fila abre, nunca cierra: en la sala las carpetas nacen
    // expandidas, así que alternar convertía cada toque en un colapso. Cerrar
    // es el chevrón o ArrowLeft.
    if (node.kind === 'branch') {
      const branch = tree().getItemInstance(node.id)
      if (!branch.isExpanded()) branch.expand()
      return
    }

    selectLeaf(node)
  }

  const handleBranchToggleClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    node: HierarchyNode
  ) => {
    event.stopPropagation()
    event.currentTarget.closest<HTMLElement>('[role="treeitem"]')?.focus()
    focusItem(node.id)
    if (node.disabled || renameSession?.id === node.id) return

    const branch = tree().getItemInstance(node.id)
    if (branch.isExpanded()) branch.collapse()
    else branch.expand()
  }

  const expandSiblingBranches = (node: HierarchyNode) => {
    const parentId = node.parentId ?? ROOT_ID
    const siblingBranches = (projection.children.get(parentId) ?? []).filter(
      (id) => projection.byId.get(id)?.kind === 'branch'
    )
    onExpandedChange(unique([...expandedIds, ...siblingBranches]))
  }

  const runTypeahead = (event: ReactKeyboardEvent<HTMLDivElement>, node: HierarchyNode) => {
    if (
      event.key.length !== 1 ||
      event.key === ' ' ||
      event.key === '*' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return false
    }

    const now = event.timeStamp
    const previous = typeaheadRef.current
    const buffer =
      now - previous.lastTypedAt > TYPEAHEAD_TIMEOUT_MS ? event.key : previous.buffer + event.key
    typeaheadRef.current = { buffer, lastTypedAt: now }

    const items = tree().getItems()
    const focusedIndex = items.findIndex((item) => item.getId() === node.id)
    const ordered = [...items.slice(focusedIndex + 1), ...items.slice(0, focusedIndex + 1)]
    const normalizedBuffer = normalizeTypeahead(buffer)
    const repeatedCharacter = [...normalizedBuffer].every(
      (character) => character === normalizedBuffer[0]
    )
    const needle = repeatedCharacter ? (normalizedBuffer[0] ?? '') : normalizedBuffer
    const match = ordered.find((item) => normalizeTypeahead(item.getItemName()).startsWith(needle))
    if (!match) return false

    event.preventDefault()
    focusItem(match.getId())
    tree().updateDomFocus()
    return true
  }

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, node: HierarchyNode) => {
    if (renameSession?.id === node.id) return
    if (isApgNavigationKey(event.key)) event.preventDefault()

    if (event.key === '*') {
      expandSiblingBranches(node)
      return
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'a' &&
      behavior.checkboxes
    ) {
      event.preventDefault()
      requestCheckedChange(loadedEligibleIds, true)
      return
    }
    if (runTypeahead(event, node)) return

    if (event.key === 'Enter' && node.kind === 'leaf') {
      event.preventDefault()
      activateLeaf(node)
      return
    }
    if (event.key === ' ' && behavior.checkboxes) {
      event.preventDefault()
      event.currentTarget.focus()
      focusItem(node.id)
      toggleCheckedNode(node, event.shiftKey)
      return
    }
    if (event.key === ' ' && node.kind === 'leaf') {
      event.preventDefault()
      event.currentTarget.focus()
      focusItem(node.id)
      if (!node.disabled) selectLeaf(node)
    }
  }

  const containerProps = tree().getContainerProps(ariaLabel)

  return (
    // `relative` is the containing block for the live region. `sr-only` is
    // `position: absolute` at its static position; as a sibling of a 2 000 px
    // tree with no positioned ancestor it sat at the bottom of the viewport
    // and stretched `documentElement.scrollHeight` (O5-04-4).
    <div className="relative min-h-0">
      <div
        {...containerAttributes}
        {...containerProps}
        onDragEnter={(event) => {
          // Root padding is not a drop target, but the browser default still
          // opens the file and navigates away unless it is cancelled here.
          if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
          containerProps.onDragEnter?.(event)
        }}
        onDragOver={(event) => {
          if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
          containerProps.onDragOver?.(event)
        }}
        onDrop={(event) => {
          if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
          containerProps.onDrop?.(event)
        }}
        className={containerClassName ?? 'min-w-0'}
      >
        {tree()
          .getItems()
          .map((item) => {
            const node = item.getItemData()
            const override = labelOverrides[node.id]
            const displayNode = override ? { ...node, label: override.label } : node
            const row = rowViewModelsById.get(node.id)
            const itemProps = item.getProps()
            const isRenaming = renameSession?.id === node.id && item.isRenaming()
            const renameInputProps = isRenaming ? item.getRenameInputProps() : null
            const draggable = Boolean(
              nodeDrop && node.kind === 'leaf' && !node.disabled && !isRenaming
            )
            const labelContent =
              isRenaming && renameSession && announcements.rename ? (
                <input
                  ref={(element) => {
                    renameInputProps?.ref?.(element)
                    // The controlled draft rebuilds this callback on every
                    // keystroke; select only once per rename session so typing
                    // does not overwrite itself.
                    if (!element || renameSelectionTokenRef.current === renameSession.token) return
                    renameSelectionTokenRef.current = renameSession.token
                    element.select()
                  }}
                  aria-label={announcements.rename.inputLabel(renameSession.originalLabel)}
                  aria-busy={renameSession.status === 'pending' ? 'true' : undefined}
                  value={renameSession.draft}
                  disabled={renameSession.status === 'pending'}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onChange={(event) => renameInputProps?.onChange?.(event)}
                  onBlur={() => {
                    const current = renameSessionRef.current
                    if (current) cancelRename(current, false)
                  }}
                  onKeyDownCapture={(event) => {
                    event.stopPropagation()
                    const current = renameSessionRef.current
                    if (!current) return
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelRename(current, true)
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename(current)
                    }
                  }}
                  className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-sm border px-1.5 py-0.5 outline-none focus-visible:ring-2 disabled:cursor-wait disabled:opacity-70"
                />
              ) : undefined
            const selected = selectedIds.includes(node.id)
            const eligibleIds =
              node.kind === 'branch'
                ? eligibleDescendantIds(node.id)
                : node.disabled
                  ? []
                  : [node.id]
            const checkedCount = eligibleIds.filter((id) => checkedIds.includes(id)).length
            const checked =
              eligibleIds.length > 0 && checkedCount === eligibleIds.length
                ? true
                : checkedCount > 0
                  ? 'indeterminate'
                  : false
            return (
              <div
                key={node.id}
                role="none"
                className={row?.variant === 'folder' ? 'mt-1 first:mt-0' : undefined}
              >
                <div
                  {...itemProps}
                  {...row?.attributes}
                  aria-disabled={node.disabled ? 'true' : undefined}
                  draggable={draggable}
                  onClick={(event) => handleRowClick(event, node)}
                  onDoubleClick={() => node.kind === 'leaf' && !isRenaming && activateLeaf(node)}
                  onFocus={() => focusItem(node.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, node)}
                  onDragStart={(event) => {
                    if (!draggable) {
                      event.preventDefault()
                      return
                    }
                    itemProps.onDragStart?.(event)
                  }}
                  onDragEnd={(event) => {
                    if (draggable) itemProps.onDragEnd?.(event)
                    dragGroupRef.current = null
                  }}
                  onDragEnter={(event) => {
                    // A rejected target still has to swallow the browser
                    // default, or the drop navigates away from the room.
                    if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
                    if (
                      isRenaming ||
                      (node.kind === 'leaf' && hasFileTransfer(event.dataTransfer))
                    ) {
                      event.stopPropagation()
                      return
                    }
                    itemProps.onDragEnter?.(event)
                  }}
                  onDragOver={(event) => {
                    if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
                    if (
                      isRenaming ||
                      (node.kind === 'leaf' && hasFileTransfer(event.dataTransfer))
                    ) {
                      event.stopPropagation()
                      return
                    }
                    itemProps.onDragOver?.(event)
                  }}
                  onDrop={(event) => {
                    if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
                    if (
                      isRenaming ||
                      (node.kind === 'leaf' && hasFileTransfer(event.dataTransfer))
                    ) {
                      event.stopPropagation()
                      return
                    }
                    itemProps.onDrop?.(event)
                  }}
                  style={{ paddingInlineStart: `${item.getItemMeta().level * 16 + 8}px` }}
                  className={rowClassName(row, selected)}
                >
                  {behavior.checkboxes ? (
                    <Checkbox
                      checked={checked}
                      aria-label={row?.checkboxLabel ?? node.label}
                      tabIndex={-1}
                      disabled={node.disabled || eligibleIds.length === 0}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleCheckedNode(node, event.shiftKey)
                      }}
                      className="pointer-events-auto shrink-0"
                    />
                  ) : null}
                  <HierarchyRow
                    node={displayNode}
                    row={row}
                    expanded={item.isExpanded()}
                    selected={selected}
                    labelContent={labelContent}
                    onToggleExpanded={
                      node.kind === 'branch'
                        ? (event) => handleBranchToggleClick(event, node)
                        : undefined
                    }
                  />
                </div>
                {row?.variant === 'folder' &&
                item.isExpanded() &&
                item.getChildren().length === 0 &&
                row.emptyText ? (
                  <div
                    role="none"
                    className="text-muted-foreground px-2 py-1.5 pl-9 text-xs leading-5"
                  >
                    {row.emptyText}
                  </div>
                ) : null}
              </div>
            )
          })}
      </div>
      <span role="status" aria-live="polite" className="sr-only top-0">
        {announcement.text}
      </span>
    </div>
  )
}

function HierarchyRow({
  node,
  row,
  expanded,
  selected,
  labelContent,
  onToggleExpanded,
}: {
  node: HierarchyNode
  row: HierarchyRowViewModel | undefined
  expanded: boolean
  selected: boolean
  labelContent?: ReactNode
  onToggleExpanded?: (event: ReactMouseEvent<HTMLButtonElement>) => void
}) {
  if (row?.variant === 'folder') {
    const FolderIcon = expanded ? FolderOpen : Folder
    const ChevronIcon = expanded ? ChevronDown : ChevronRight
    return (
      <>
        {onToggleExpanded ? (
          // Afordancia redundante de puntero: el árbol expone `aria-expanded`
          // en la fila y colapsa con ArrowLeft, así que este botón se oculta a
          // la tecnología asistiva y queda fuera del orden de tabulación en vez
          // de duplicar el control dentro del `treeitem`.
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="hierarchy-branch-toggle"
            onClick={onToggleExpanded}
            className="text-muted-foreground -ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm"
          >
            <ChevronIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <ChevronIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <FolderIcon className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
        {labelContent ?? <span className="min-w-0 flex-1 truncate">{node.label}</span>}
        {row.trailingText ? (
          <span
            {...row.trailingAttributes}
            className="text-muted-foreground font-mono text-xs tabular-nums"
          >
            {row.trailingText}
          </span>
        ) : null}
      </>
    )
  }

  if (row?.variant === 'file') {
    const visual = row.leadingVisual === 'folder' ? 'file' : (row.leadingVisual ?? 'file')
    const LeadingIcon = ROW_VISUALS[visual]
    const extension = node.label.match(/^(.*)(\.[A-Za-z0-9]{1,5})$/)
    return (
      <>
        <LeadingIcon
          className={`h-4 w-4 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-x-2 gap-y-0.5 @[18rem]:flex-row @[18rem]:items-center">
          {labelContent ?? (
            <span
              title={row.primaryTitle ?? node.label}
              className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] @[18rem]:flex-1"
            >
              {extension ? (
                <>
                  {extension[1]}
                  <wbr />
                  <span className="whitespace-nowrap">{extension[2]}</span>
                </>
              ) : (
                node.label
              )}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1.5">
            {row.versionText ? (
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {row.versionText}
              </span>
            ) : null}
            {row.badgeText ? (
              <span className="border-border text-muted-foreground rounded-sm border px-1.5 py-0.5 text-xs">
                {row.badgeText}
              </span>
            ) : null}
            {row.attentionText ? (
              <span className="flex items-center" title={row.attentionText}>
                <span aria-hidden="true" className="bg-warning h-1.5 w-1.5 rounded-full" />
                <span className="sr-only">{row.attentionText}</span>
              </span>
            ) : row.trailingText ? (
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {row.trailingText}
              </span>
            ) : null}
          </span>
        </span>
      </>
    )
  }

  return (
    <>
      <span className="min-w-0 flex-1">
        {labelContent ?? <span className="block truncate">{node.label}</span>}
        {row?.secondaryText ? (
          <span className="text-muted-foreground block truncate text-xs">{row.secondaryText}</span>
        ) : null}
      </span>
      {row?.statusText ? (
        <span className="text-muted-foreground shrink-0 text-xs">{row.statusText}</span>
      ) : null}
      {row?.trailingText ? (
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {row.trailingText}
        </span>
      ) : null}
    </>
  )
}
