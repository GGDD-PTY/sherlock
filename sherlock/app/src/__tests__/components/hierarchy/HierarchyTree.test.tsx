import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { HierarchyTree } from '@/components/hierarchy/HierarchyTree'
import type { HierarchyAnnouncements, HierarchyNode, HierarchyProps } from '@/lib/hierarchy/types'

const announcements: HierarchyAnnouncements = {
  selectionChanged: (selectedCount) => `seleccionados: ${selectedCount}`,
  selectionLimitReached: (maxSelected) => `límite: ${maxSelected}`,
  revealed: (label) => `revelado: ${label}`,
  rename: {
    inputLabel: (label) => `Renombrar ${label}`,
    pending: (label) => `Guardando ${label}`,
    succeeded: (label) => `Renombrado como ${label}`,
    failed: (label) => `No se pudo renombrar ${label}`,
    cancelled: (label) => `Renombrado cancelado para ${label}`,
    empty: 'Escribe un nombre',
  },
}

const expandedNodes: HierarchyNode[] = [
  { id: 'folder-a', parentId: null, kind: 'branch', label: 'Carpeta A' },
  { id: 'leaf-a', parentId: 'folder-a', kind: 'leaf', label: 'Documento A' },
  { id: 'leaf-b', parentId: 'folder-a', kind: 'leaf', label: 'Documento B' },
]

function dataTransfer({ files = [], types = [] }: { files?: File[]; types?: string[] } = {}) {
  return {
    files,
    types,
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: vi.fn(),
    setData: vi.fn(),
    setDragImage: vi.fn(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function controlledProps(overrides: Partial<HierarchyProps> = {}): HierarchyProps {
  return {
    ariaLabel: 'Documentos de la sala',
    nodes: expandedNodes,
    preset: 'browse',
    selectedIds: [],
    expandedIds: ['folder-a'],
    selectionPolicy: {
      parentPropagation: 'none',
      preserveHiddenSelection: false,
    },
    announcements,
    onSelectionChange: vi.fn(),
    onExpandedChange: vi.fn(),
    ...overrides,
  }
}

describe('HierarchyTree', () => {
  it('projects controlled expansion into the visible row list', () => {
    const props = controlledProps({ expandedIds: [] })
    const { rerender } = render(<HierarchyTree {...props} />)

    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    expect(screen.queryByRole('treeitem', { name: 'Documento A' })).not.toBeInTheDocument()

    rerender(<HierarchyTree {...props} expandedIds={['folder-a']} />)

    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByRole('treeitem', { name: 'Documento A' })).toBeInTheDocument()
  })

  it('keeps the live status outside the APG tree ownership structure', () => {
    render(<HierarchyTree {...controlledProps()} />)

    const tree = screen.getByRole('tree')
    const status = screen.getByRole('status')
    expect(status.parentElement).not.toBe(tree)
  })

  it('renders typed row metadata without handing callers an engine item', () => {
    render(
      <HierarchyTree
        {...controlledProps()}
        rowViewModels={[
          {
            nodeId: 'leaf-a',
            secondaryText: 'application/pdf',
            trailingText: '2.4 MB',
            statusText: 'Aprobado',
          },
        ]}
      />
    )

    expect(screen.getByText('application/pdf')).toBeInTheDocument()
    expect(screen.getByText('2.4 MB')).toBeInTheDocument()
    expect(screen.getByText('Aprobado')).toBeInTheDocument()
  })

  it('reveals and focuses only for a new nonce without activating the leaf', async () => {
    const onActivateLeaf = vi.fn()
    const onExpandedChange = vi.fn()
    const props = controlledProps({
      expandedIds: [],
      revealRequest: { id: 'leaf-a', nonce: 'citation-1' },
      onActivateLeaf,
      onExpandedChange,
    })
    const { rerender } = render(<HierarchyTree {...props} />)

    await waitFor(() => expect(onExpandedChange).toHaveBeenCalledWith(['folder-a']))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('revelado: Documento A')
    )
    expect(onActivateLeaf).not.toHaveBeenCalled()

    rerender(<HierarchyTree {...props} expandedIds={['folder-a']} revealRequest={undefined} />)
    const folder = screen.getByRole('treeitem', { name: 'Carpeta A' })
    fireEvent.click(folder)
    expect(folder).toHaveFocus()

    rerender(
      <HierarchyTree
        {...props}
        expandedIds={['folder-a']}
        revealRequest={{ id: 'leaf-a', nonce: 'citation-1' }}
      />
    )
    expect(folder).toHaveFocus()

    rerender(
      <HierarchyTree
        {...props}
        expandedIds={['folder-a']}
        revealRequest={{ id: 'leaf-a', nonce: 'citation-2' }}
      />
    )
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'Documento A' })).toHaveFocus())
    expect(onActivateLeaf).not.toHaveBeenCalled()
  })

  it('keeps hidden selections while enforcing the pick-many maximum', async () => {
    function Harness() {
      const [checkedIds, setCheckedIds] = useState<readonly string[]>(['hidden-leaf', 'leaf-a'])
      return (
        <>
          <output data-testid="selection">{checkedIds.join(',')}</output>
          <HierarchyTree
            {...controlledProps()}
            preset="pick-many"
            checkedIds={checkedIds}
            selectionPolicy={{
              maxSelected: 2,
              parentPropagation: 'descendants',
              preserveHiddenSelection: true,
            }}
            onCheckedChange={(ids, checked) =>
              setCheckedIds((current) => {
                const next = new Set(current)
                for (const id of ids) {
                  if (checked) next.add(id)
                  else next.delete(id)
                }
                return [...next]
              })
            }
          />
        </>
      )
    }

    render(<Harness />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento B' }))
    expect(screen.getByTestId('selection')).toHaveTextContent('hidden-leaf,leaf-a')
    expect(screen.getByText('límite: 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento A' }))
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('hidden-leaf'))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento B' }))
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('hidden-leaf,leaf-b')
    )
    expect(screen.getByText('seleccionados: 2')).toBeInTheDocument()
  })

  it('uses only caller-provided strings for assistive announcements', () => {
    render(
      <HierarchyTree {...controlledProps({ preset: 'pick-many' })} onCheckedChange={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento A' }))

    expect(screen.getByRole('status')).toHaveTextContent('seleccionados: 1')
  })

  it('clears the live status when the announced document leaves the tree', () => {
    const props = controlledProps({
      preset: 'pick-many',
      announcements: { ...announcements, activeChanged: (l) => `Documento activo: ${l}` },
      onCheckedChange: vi.fn<NonNullable<HierarchyProps['onCheckedChange']>>(),
    })
    const { rerender } = render(<HierarchyTree {...props} />)

    fireEvent.click(screen.getByRole('treeitem', { name: 'Documento A' }))
    expect(screen.getByRole('status')).toHaveTextContent('Documento activo: Documento A')

    rerender(
      <HierarchyTree {...props} nodes={expandedNodes.filter((node) => node.id !== 'leaf-a')} />
    )

    expect(screen.getByRole('status')).not.toHaveTextContent('Documento A')
  })

  it('keeps the live status empty when the announced document comes back to the tree', () => {
    const props = controlledProps({
      preset: 'pick-many',
      announcements: { ...announcements, activeChanged: (l) => `Documento activo: ${l}` },
      onCheckedChange: vi.fn<NonNullable<HierarchyProps['onCheckedChange']>>(),
    })
    const { rerender } = render(<HierarchyTree {...props} />)

    fireEvent.click(screen.getByRole('treeitem', { name: 'Documento A' }))
    expect(screen.getByRole('status')).toHaveTextContent('Documento activo: Documento A')

    rerender(
      <HierarchyTree {...props} nodes={expandedNodes.filter((node) => node.id !== 'leaf-a')} />
    )
    expect(screen.getByRole('status').textContent).toBe('')

    // Búsqueda limpiada, orden cambiado o «Cargar más»: el mismo id vuelve.
    rerender(<HierarchyTree {...props} nodes={expandedNodes} />)

    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps the rename success text when the renamed leaf leaves the tree before the save resolves', async () => {
    const result = deferred<boolean>()
    const props = controlledProps({
      announcements: { ...announcements, activeChanged: (l) => `Documento activo: ${l}` },
      onRenameLeaf: () => result.promise,
    })
    const { rerender } = render(<HierarchyTree {...props} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre nuevo' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())

    // Convex 1.42.0 entrega la consulta nueva antes de resolver la promesa de la
    // mutation: con una búsqueda activa, el nombre nuevo saca la fila primero.
    rerender(
      <HierarchyTree {...props} nodes={expandedNodes.filter((node) => node.id !== 'leaf-a')} />
    )
    await act(async () => result.resolve(true))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Renombrado como Nombre nuevo')
    )
  })

  it('keeps the selection count when a checked document leaves the tree', () => {
    const props = controlledProps({
      preset: 'pick-many',
      announcements: { ...announcements, activeChanged: (l) => `Documento activo: ${l}` },
      onCheckedChange: vi.fn<NonNullable<HierarchyProps['onCheckedChange']>>(),
    })
    const { rerender } = render(<HierarchyTree {...props} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento A' }))
    expect(screen.getByRole('status')).toHaveTextContent('seleccionados: 1')

    rerender(
      <HierarchyTree
        {...props}
        checkedIds={['leaf-a']}
        nodes={expandedNodes.filter((node) => node.id !== 'leaf-a')}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('seleccionados: 1')
  })

  it('clears the live selection count when the caller empties the selection', () => {
    const props = controlledProps({
      preset: 'pick-many',
      onCheckedChange: vi.fn<NonNullable<HierarchyProps['onCheckedChange']>>(),
    })
    const { rerender } = render(<HierarchyTree {...props} checkedIds={[]} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento A' }))
    rerender(<HierarchyTree {...props} checkedIds={['leaf-a']} />)
    expect(screen.getByRole('status')).toHaveTextContent('seleccionados: 1')

    // «Limpiar» en la barra masiva, o las filas que ya no están tras un borrado.
    rerender(<HierarchyTree {...props} checkedIds={[]} />)

    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps a rename announcement when the caller empties the selection', async () => {
    const props = controlledProps({
      preset: 'pick-many',
      onCheckedChange: vi.fn<NonNullable<HierarchyProps['onCheckedChange']>>(),
      onRenameLeaf: () => Promise.resolve(true),
    })
    const { rerender } = render(<HierarchyTree {...props} checkedIds={['leaf-a']} />)

    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre nuevo' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Renombrado como Nombre nuevo')
    )

    rerender(<HierarchyTree {...props} checkedIds={[]} />)

    expect(screen.getByRole('status')).toHaveTextContent('Renombrado como Nombre nuevo')
  })

  it('keeps the active selected item independent from checked bulk items', () => {
    const onSelectionChange = vi.fn()
    const onCheckedChange = vi.fn()
    render(
      <HierarchyTree
        {...controlledProps({
          preset: 'pick-many',
          selectedIds: ['leaf-a'],
          onSelectionChange,
        })}
        checkedIds={['leaf-b']}
        onCheckedChange={onCheckedChange}
      />
    )

    fireEvent.click(screen.getByRole('treeitem', { name: 'Documento B' }))
    expect(onSelectionChange).toHaveBeenCalledWith(['leaf-b'])
    expect(onCheckedChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Documento A' }))
    expect(onCheckedChange).toHaveBeenCalledWith(['leaf-a'], true)
  })

  it('drags only the rendered eligible checked group onto an accepted branch', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const transfer = dataTransfer()
    const nodes: HierarchyNode[] = [
      ...expandedNodes,
      {
        id: 'leaf-disabled',
        parentId: 'folder-a',
        kind: 'leaf',
        label: 'Bloqueado',
        disabled: true,
      },
      { id: 'folder-b', parentId: null, kind: 'branch', label: 'Carpeta B' },
      { id: 'leaf-c', parentId: 'folder-b', kind: 'leaf', label: 'Documento C' },
    ]
    render(
      <HierarchyTree
        {...controlledProps({
          nodes,
          preset: 'pick-many',
          selectedIds: ['leaf-a'],
          checkedIds: ['leaf-a', 'leaf-b', 'leaf-disabled', 'hidden-leaf'],
          expandedIds: ['folder-a', 'folder-b'],
          onCheckedChange: vi.fn(),
          nodeDrop: {
            canDrag: () => true,
            canDrop: ({ targetBranchId }) => targetBranchId === 'folder-b',
            onDrop,
          },
        })}
      />
    )

    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Documento A' }), {
      dataTransfer: transfer,
    })
    fireEvent.dragOver(screen.getByRole('treeitem', { name: 'Carpeta B' }), {
      dataTransfer: transfer,
    })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Carpeta B' }), {
      dataTransfer: transfer,
    })

    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith({
        nodeIds: ['leaf-a', 'leaf-b'],
        targetBranchId: 'folder-b',
      })
    )
    expect(transfer.setData).not.toHaveBeenCalled()
  })

  it('drags an unchecked leaf alone and rejects branch, disabled, root, and caller-denied targets', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const canDrag = vi.fn((nodeIds: readonly string[]) => !nodeIds.includes('leaf-b'))
    const transfer = dataTransfer()
    const nodes: HierarchyNode[] = [
      ...expandedNodes,
      {
        id: 'leaf-disabled',
        parentId: 'folder-a',
        kind: 'leaf',
        label: 'Bloqueado',
        disabled: true,
      },
      { id: 'folder-b', parentId: null, kind: 'branch', label: 'Carpeta B' },
      { id: 'leaf-c', parentId: 'folder-b', kind: 'leaf', label: 'Documento C' },
    ]
    render(
      <HierarchyTree
        {...controlledProps({
          nodes,
          checkedIds: ['leaf-a'],
          expandedIds: ['folder-a', 'folder-b'],
          nodeDrop: {
            canDrag,
            canDrop: ({ targetBranchId }) => targetBranchId === 'folder-b',
            onDrop,
          },
        })}
      />
    )

    const folderA = screen.getByRole('treeitem', { name: 'Carpeta A' })
    const folderB = screen.getByRole('treeitem', { name: 'Carpeta B' })
    const leafB = screen.getByRole('treeitem', { name: 'Documento B' })
    const leafC = screen.getByRole('treeitem', { name: 'Documento C' })
    const disabled = screen.getByRole('treeitem', { name: 'Bloqueado' })

    expect(folderA).toHaveAttribute('draggable', 'false')
    expect(disabled).toHaveAttribute('draggable', 'false')

    fireEvent.dragStart(leafC, { dataTransfer: transfer })
    fireEvent.dragOver(folderB, { dataTransfer: transfer })
    fireEvent.drop(folderB, { dataTransfer: transfer })
    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith({ nodeIds: ['leaf-c'], targetBranchId: 'folder-b' })
    )

    onDrop.mockClear()
    fireEvent.dragStart(leafC, { dataTransfer: transfer })
    fireEvent.dragOver(folderA, { dataTransfer: transfer })
    fireEvent.drop(folderA, { dataTransfer: transfer })
    expect(onDrop).not.toHaveBeenCalled()

    fireEvent.dragStart(leafB, { dataTransfer: transfer })
    fireEvent.dragOver(folderB, { dataTransfer: transfer })
    fireEvent.drop(folderB, { dataTransfer: transfer })

    fireEvent.dragStart(leafC, { dataTransfer: transfer })
    fireEvent.drop(screen.getByRole('tree'), { dataTransfer: transfer })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('resolves an internal drop on a leaf to its accepted parent branch', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const transfer = dataTransfer()
    const nodes: HierarchyNode[] = [
      ...expandedNodes,
      { id: 'folder-b', parentId: null, kind: 'branch', label: 'Carpeta B' },
      { id: 'leaf-c', parentId: 'folder-b', kind: 'leaf', label: 'Documento C' },
    ]
    render(
      <HierarchyTree
        {...controlledProps({
          nodes,
          expandedIds: ['folder-a', 'folder-b'],
          nodeDrop: { canDrag: () => true, canDrop: () => true, onDrop },
        })}
      />
    )

    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Documento A' }), {
      dataTransfer: transfer,
    })
    fireEvent.dragOver(screen.getByRole('treeitem', { name: 'Documento C' }), {
      dataTransfer: transfer,
    })
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Documento C' }), {
      dataTransfer: transfer,
    })

    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith({ nodeIds: ['leaf-a'], targetBranchId: 'folder-b' })
    )
  })

  it('accepts a non-empty Files payload on a branch through the three foreign callbacks', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const canDragOver = vi.fn(() => true)
    const canDrop = vi.fn(() => true)
    const file = new File(['pdf'], 'memo.pdf', { type: 'application/pdf' })
    const transfer = dataTransfer({ files: [file], types: ['Files'] })
    render(
      <HierarchyTree
        {...controlledProps({
          foreignFileDrop: { canDragOver, canDrop, onDrop },
        })}
      />
    )

    const branch = screen.getByRole('treeitem', { name: 'Carpeta A' })
    fireEvent.dragOver(branch, { dataTransfer: transfer })
    fireEvent.drop(branch, { dataTransfer: transfer })

    await waitFor(() =>
      expect(onDrop).toHaveBeenCalledWith({ files: [file], targetBranchId: 'folder-a' })
    )
    expect(canDragOver).toHaveBeenCalledWith('folder-a')
    expect(canDrop).toHaveBeenCalledWith({ files: [file], targetBranchId: 'folder-a' })
  })

  it.each([
    ['empty Files payload', dataTransfer({ files: [], types: ['Files'] }), 'Carpeta A'],
    ['non-File payload', dataTransfer({ files: [], types: ['text/plain'] }), 'Carpeta A'],
    [
      'leaf target',
      dataTransfer({ files: [new File(['pdf'], 'memo.pdf')], types: ['Files'] }),
      'Documento A',
    ],
  ])('rejects a foreign %s', async (_case, transfer, targetName) => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    render(
      <HierarchyTree
        {...controlledProps({
          foreignFileDrop: { canDragOver: () => true, canDrop: () => true, onDrop },
        })}
      />
    )

    const target = screen.getByRole('treeitem', { name: targetName })
    fireEvent.dragOver(target, { dataTransfer: transfer })
    fireEvent.drop(target, { dataTransfer: transfer })
    await act(async () => Promise.resolve())

    expect(onDrop).not.toHaveBeenCalled()
  })

  it('rejects a foreign Files payload on the root container', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const transfer = dataTransfer({
      files: [new File(['pdf'], 'memo.pdf')],
      types: ['Files'],
    })
    render(
      <HierarchyTree
        {...controlledProps({
          foreignFileDrop: { canDragOver: () => true, canDrop: () => true, onDrop },
        })}
      />
    )

    fireEvent.drop(screen.getByRole('tree'), { dataTransfer: transfer })
    await act(async () => Promise.resolve())
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('cancels the browser default for a local file drop on every rejected target', async () => {
    const result = deferred<boolean>()
    const onForeignDrop = vi.fn().mockResolvedValue(undefined)
    render(
      <HierarchyTree
        {...controlledProps({
          onRenameLeaf: () => result.promise,
          foreignFileDrop: {
            canDragOver: () => true,
            canDrop: () => true,
            onDrop: onForeignDrop,
          },
        })}
      />
    )

    const renaming = screen.getByRole('treeitem', { name: 'Documento B' })
    fireEvent.focus(renaming)
    fireEvent.keyDown(renaming, { key: 'F2', code: 'F2' })
    await screen.findByRole('textbox')

    const targets = [
      screen.getByRole('treeitem', { name: 'Documento A' }),
      renaming,
      screen.getByRole('tree'),
    ]

    for (const target of targets) {
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        const transfer = dataTransfer({
          files: [new File(['pdf'], 'memo.pdf')],
          types: ['Files'],
        })
        const event = createEvent[type](target, { dataTransfer: transfer })
        fireEvent(target, event)
        expect(event.defaultPrevented).toBe(true)
      }
    }

    await act(async () => Promise.resolve())
    expect(onForeignDrop).not.toHaveBeenCalled()
  })

  it('starts F2 rename only for an eligible leaf and focuses its prefilled input', async () => {
    render(<HierarchyTree {...controlledProps({ onRenameLeaf: vi.fn() })} />)

    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })

    const input = await screen.findByRole('textbox', { name: 'Renombrar Documento A' })
    expect(input).toHaveValue('Documento A')
    expect(input).toHaveFocus()
    expect(input).toHaveProperty('selectionStart', 0)
    expect(input).toHaveProperty('selectionEnd', 'Documento A'.length)
  })

  it('keeps every typed character after F2 preselects the draft', async () => {
    render(<HierarchyTree {...controlledProps({ onRenameLeaf: vi.fn() })} />)

    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })

    const input = await screen.findByRole('textbox', { name: 'Renombrar Documento A' })
    await userEvent.type(input, 'abc', { skipClick: true })

    expect(input).toHaveValue('abc')
  })

  it('keeps F2 inert on branches and disabled leaves', async () => {
    const nodes: HierarchyNode[] = [
      ...expandedNodes,
      {
        id: 'leaf-disabled',
        parentId: 'folder-a',
        kind: 'leaf',
        label: 'Bloqueado',
        disabled: true,
      },
    ]
    render(<HierarchyTree {...controlledProps({ nodes, onRenameLeaf: vi.fn() })} />)

    for (const name of ['Carpeta A', 'Bloqueado']) {
      const item = screen.getByRole('treeitem', { name })
      fireEvent.focus(item)
      fireEvent.keyDown(item, { key: 'F2', code: 'F2' })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    }
  })

  it('cancels rename on Escape without committing and restores row focus', async () => {
    const onRenameLeaf = vi.fn()
    render(<HierarchyTree {...controlledProps({ onRenameLeaf })} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Otro nombre' } })
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    expect(onRenameLeaf).not.toHaveBeenCalled()
    expect(screen.getByRole('treeitem', { name: 'Documento A' })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Renombrado cancelado para Documento A')
  })

  it('cancels rename on blur without committing or stealing destination focus', async () => {
    const onRenameLeaf = vi.fn()
    render(
      <>
        <button type="button">Destino</button>
        <HierarchyTree {...controlledProps({ onRenameLeaf })} />
      </>
    )
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    await screen.findByRole('textbox')
    const destination = screen.getByRole('button', { name: 'Destino' })
    act(() => destination.focus())

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    expect(onRenameLeaf).not.toHaveBeenCalled()
    expect(destination).toHaveFocus()
  })

  it('keeps whitespace-only Enter in edit mode with localized feedback', async () => {
    const onRenameLeaf = vi.fn()
    render(<HierarchyTree {...controlledProps({ onRenameLeaf })} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(onRenameLeaf).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Escribe un nombre')
  })

  it('commits trimmed rename exactly once while pending, ignores pending blur, and focuses success', async () => {
    const result = deferred<boolean>()
    const onRenameLeaf = vi.fn(() => result.promise)
    const onActivateLeaf = vi.fn()
    const onSelectionChange = vi.fn()
    render(
      <HierarchyTree {...controlledProps({ onRenameLeaf, onActivateLeaf, onSelectionChange })} />
    )
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '  Nombre nuevo  ' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(input).toBeDisabled())
    expect(input.closest('[role="treeitem"]')).toHaveAttribute('draggable', 'false')
    expect(onRenameLeaf).toHaveBeenCalledTimes(1)
    expect(onRenameLeaf).toHaveBeenCalledWith('leaf-a', 'Nombre nuevo')
    expect(screen.getByRole('status')).toHaveTextContent('Guardando Nombre nuevo')
    expect(onActivateLeaf).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(input).toBeInTheDocument()

    await act(async () => result.resolve(true))
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'Nombre nuevo' })).toHaveFocus()
    )
    expect(screen.getByRole('status')).toHaveTextContent('Renombrado como Nombre nuevo')
  })

  it('retires an optimistic label after source catch-up, later source change, removal, and re-add', async () => {
    const result = deferred<boolean>()
    const onRenameLeaf = vi.fn(() => result.promise)
    const props = controlledProps({ onRenameLeaf })
    const { rerender } = render(<HierarchyTree {...props} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre B' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())
    await act(async () => result.resolve(true))
    await screen.findByRole('treeitem', { name: 'Nombre B' })

    const sourceB = expandedNodes.map((node) =>
      node.id === 'leaf-a' ? { ...node, label: 'Nombre B' } : node
    )
    rerender(<HierarchyTree {...props} nodes={sourceB} />)
    expect(screen.getByRole('treeitem', { name: 'Nombre B' })).toBeInTheDocument()

    const sourceC = sourceB.map((node) =>
      node.id === 'leaf-a' ? { ...node, label: 'Nombre C' } : node
    )
    rerender(<HierarchyTree {...props} nodes={sourceC} />)
    expect(screen.getByRole('treeitem', { name: 'Nombre C' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Nombre B' })).not.toBeInTheDocument()

    rerender(<HierarchyTree {...props} nodes={sourceC.filter((node) => node.id !== 'leaf-a')} />)
    expect(screen.queryByRole('treeitem', { name: /Nombre [BC]/ })).not.toBeInTheDocument()

    const readded = [
      sourceC[0],
      { ...expandedNodes[1], label: 'Nombre D' },
      sourceC[2],
    ] as HierarchyNode[]
    rerender(<HierarchyTree {...props} nodes={readded} />)
    expect(screen.getByRole('treeitem', { name: 'Nombre D' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Nombre B' })).not.toBeInTheDocument()
  })

  it('retires an optimistic label when the source jumps straight to a normalized one', async () => {
    const result = deferred<boolean>()
    const onRenameLeaf = vi.fn(() => result.promise)
    const props = controlledProps({ onRenameLeaf })
    const { rerender } = render(<HierarchyTree {...props} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre B' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())
    await act(async () => result.resolve(true))
    await screen.findByRole('treeitem', { name: 'Nombre B' })

    const normalized = expandedNodes.map((node) =>
      node.id === 'leaf-a' ? { ...node, label: 'nombre b' } : node
    )
    rerender(<HierarchyTree {...props} nodes={normalized} />)

    expect(screen.getByRole('treeitem', { name: 'nombre b' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Nombre B' })).not.toBeInTheDocument()
  })

  it('keeps a pending rename as the only session when F2 targets another leaf', async () => {
    const result = deferred<boolean>()
    render(<HierarchyTree {...controlledProps({ onRenameLeaf: () => result.promise })} />)
    const first = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(first)
    fireEvent.keyDown(first, { key: 'F2', code: 'F2' })
    fireEvent.keyUp(first, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'Renombrar Documento A' })
    fireEvent.change(input, { target: { value: 'Pendiente A' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())

    const second = screen.getByRole('treeitem', { name: 'Documento B' })
    fireEvent.focus(second)
    await act(async () => Promise.resolve())
    fireEvent.keyDown(second, { key: 'F2', code: 'F2' })

    expect(screen.getByRole('textbox', { name: 'Renombrar Documento A' })).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: 'Renombrar Documento B' })).not.toBeInTheDocument()
    await act(async () => result.resolve(false))
  })

  it('does not announce or focus after a pending rename settles post-unmount', async () => {
    const result = deferred<boolean>()
    const succeeded = vi.fn(() => 'éxito tardío')
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const { unmount } = render(
      <HierarchyTree
        {...controlledProps({
          onRenameLeaf: () => result.promise,
          announcements: {
            ...announcements,
            rename: { ...announcements.rename!, succeeded },
          },
        })}
      />
    )
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre tardío' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())
    const focusCallsBeforeUnmount = focus.mock.calls.length

    unmount()
    await act(async () => result.resolve(true))
    await act(async () => new Promise((resolve) => globalThis.setTimeout(resolve, 0)))

    expect(succeeded).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(focusCallsBeforeUnmount)
    focus.mockRestore()
  })

  it('rejects internal and foreign drops on a leaf throughout idle and pending rename', async () => {
    const result = deferred<boolean>()
    const onDrop = vi.fn().mockResolvedValue(undefined)
    const onForeignDrop = vi.fn().mockResolvedValue(undefined)
    const nodes: HierarchyNode[] = [
      ...expandedNodes,
      { id: 'folder-b', parentId: null, kind: 'branch', label: 'Carpeta B' },
      { id: 'leaf-c', parentId: 'folder-b', kind: 'leaf', label: 'Documento C' },
    ]
    render(
      <HierarchyTree
        {...controlledProps({
          nodes,
          expandedIds: ['folder-a', 'folder-b'],
          onRenameLeaf: () => result.promise,
          nodeDrop: { canDrag: () => true, canDrop: () => true, onDrop },
          foreignFileDrop: {
            canDragOver: () => true,
            canDrop: () => true,
            onDrop: onForeignDrop,
          },
        })}
      />
    )
    const source = screen.getByRole('treeitem', { name: 'Documento A' })
    const target = screen.getByRole('treeitem', { name: 'Documento C' })
    fireEvent.focus(target)
    fireEvent.keyDown(target, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    const internal = dataTransfer()

    fireEvent.dragStart(source, { dataTransfer: internal })
    fireEvent.dragOver(target, { dataTransfer: internal })
    fireEvent.drop(target, { dataTransfer: internal })
    act(() => {
      fireEvent.dragEnd(source, { dataTransfer: internal })
    })
    expect(onDrop).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'Pendiente C' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(input).toBeDisabled())
    fireEvent.dragStart(source, { dataTransfer: internal })
    fireEvent.dragOver(target, { dataTransfer: internal })
    fireEvent.drop(target, { dataTransfer: internal })

    const foreign = dataTransfer({
      files: [new File(['pdf'], 'memo.pdf')],
      types: ['Files'],
    })
    fireEvent.dragOver(target, { dataTransfer: foreign })
    fireEvent.drop(target, { dataTransfer: foreign })
    expect(onDrop).not.toHaveBeenCalled()
    expect(onForeignDrop).not.toHaveBeenCalled()
    await act(async () => result.resolve(false))
  })

  it.each([
    ['false result', () => Promise.resolve(false)],
    ['thrown error', () => Promise.reject(new Error('sensitive backend detail'))],
  ])('rolls back a rename after %s with generic feedback and row focus', async (_case, rename) => {
    render(<HierarchyTree {...controlledProps({ onRenameLeaf: rename })} />)
    const leaf = screen.getByRole('treeitem', { name: 'Documento A' })
    fireEvent.focus(leaf)
    fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nombre rechazado' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    const restored = screen.getByRole('treeitem', { name: 'Documento A' })
    await waitFor(() => expect(restored).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent('No se pudo renombrar Documento A')
    expect(screen.getByRole('status')).not.toHaveTextContent('sensitive backend detail')
  })

  it.each([
    ['first leaf', 'leaf-a', 'Documento A', 'Documento B'],
    ['middle leaf', 'leaf-b', 'Documento B', 'Documento C'],
    ['last leaf', 'leaf-c', 'Documento C', 'Documento B'],
  ])(
    'focuses the nearest visible row by previous position when the %s disappears',
    async (_case, targetId, targetLabel, expectedLabel) => {
      const result = deferred<boolean>()
      const nodes: HierarchyNode[] = [
        expandedNodes[0],
        expandedNodes[1],
        expandedNodes[2],
        { id: 'leaf-c', parentId: 'folder-a', kind: 'leaf', label: 'Documento C' },
      ]
      const props = controlledProps({ nodes, onRenameLeaf: () => result.promise })
      const { rerender } = render(<HierarchyTree {...props} />)
      const leaf = screen.getByRole('treeitem', { name: targetLabel })
      fireEvent.focus(leaf)
      fireEvent.keyDown(leaf, { key: 'F2', code: 'F2' })
      const input = await screen.findByRole('textbox')
      fireEvent.change(input, { target: { value: 'Nombre rechazado' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
      await waitFor(() => expect(input).toBeDisabled())

      rerender(<HierarchyTree {...props} nodes={nodes.filter((node) => node.id !== targetId)} />)
      await act(async () => result.resolve(false))

      const expected = screen.getByRole('treeitem', { name: expectedLabel })
      expect(expected).toHaveAttribute('aria-label', expectedLabel)
      await waitFor(() => expect(expected).toHaveFocus())
    }
  )

  // Contrato de fila de rama ([F] 2026-09-02): un click en la fila abre y nunca
  // cierra. Cerrar es el chevrón o ArrowLeft; tocar la carpeta ya no la colapsa.
  function ExpansionHarness({ initialExpandedIds }: { initialExpandedIds: readonly string[] }) {
    const [expandedIds, setExpandedIds] = useState<readonly string[]>(initialExpandedIds)
    return (
      <HierarchyTree
        {...controlledProps({
          expandedIds,
          onExpandedChange: setExpandedIds,
          rowViewModels: [{ nodeId: 'folder-a', variant: 'folder', leadingVisual: 'folder' }],
        })}
      />
    )
  }

  it('keeps an expanded branch expanded when its row is clicked', async () => {
    render(<ExpansionHarness initialExpandedIds={['folder-a']} />)
    const folder = screen.getByRole('treeitem', { name: 'Carpeta A' })

    await userEvent.click(folder)

    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('treeitem', { name: 'Documento A' })).toBeInTheDocument()
    expect(folder).toHaveFocus()
  })

  it('collapses an expanded branch through the chevron control', async () => {
    render(<ExpansionHarness initialExpandedIds={['folder-a']} />)
    const folder = screen.getByRole('treeitem', { name: 'Carpeta A' })

    await userEvent.click(within(folder).getByTestId('hierarchy-branch-toggle'))

    expect(folder).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Documento A' })).not.toBeInTheDocument()
    expect(folder).toHaveFocus()
  })

  it('expands a collapsed branch when its row is clicked', async () => {
    render(<ExpansionHarness initialExpandedIds={[]} />)
    const folder = screen.getByRole('treeitem', { name: 'Carpeta A' })

    await userEvent.click(folder)

    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('treeitem', { name: 'Documento A' })).toBeInTheDocument()
  })
})
