import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { HierarchyTree } from '@/components/hierarchy/HierarchyTree'
import type { HierarchyNode, HierarchyProps } from '@/lib/hierarchy/types'

const rebuildState = vi.hoisted(() => ({
  patched: new WeakSet<object>(),
  rebuild: vi.fn(),
  getItem: vi.fn(),
}))

vi.mock('@headless-tree/react/react-compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@headless-tree/react/react-compiler')>()
  return {
    ...actual,
    useTree: ((config: Parameters<typeof actual.useTree>[0]) => {
      rebuildState.getItem.mockImplementation((itemId: string) => config.dataLoader.getItem(itemId))
      const getter = actual.useTree(config)
      const instance = getter()
      if (!rebuildState.patched.has(instance)) {
        rebuildState.patched.add(instance)
        const original = instance.rebuildTree
        instance.rebuildTree = () => {
          rebuildState.rebuild()
          original()
        }
      }
      return getter
    }) as typeof actual.useTree,
  }
})

const branch: HierarchyNode = {
  id: 'folder-a',
  parentId: null,
  kind: 'branch',
  label: 'Carpeta A',
}

const props: HierarchyProps = {
  ariaLabel: 'Documentos de la sala',
  nodes: [branch],
  preset: 'browse',
  selectedIds: [],
  expandedIds: [],
  selectionPolicy: {
    parentPropagation: 'none',
    preserveHiddenSelection: false,
  },
  announcements: {
    selectionChanged: () => 'selección',
    selectionLimitReached: () => 'límite',
    revealed: () => 'revelado',
  },
  onSelectionChange: vi.fn(),
  onExpandedChange: vi.fn(),
}

describe('HierarchyTree projection rebuild', () => {
  it('rebuilds exactly once for a structural projection change and not for a label change', () => {
    const { rerender } = render(<HierarchyTree {...props} />)
    rebuildState.rebuild.mockClear()

    rerender(<HierarchyTree {...props} nodes={[{ ...branch, label: 'Carpeta renombrada' }]} />)
    expect(rebuildState.rebuild).not.toHaveBeenCalled()

    rerender(
      <HierarchyTree
        {...props}
        nodes={[branch, { id: 'leaf-a', parentId: 'folder-a', kind: 'leaf', label: 'Documento A' }]}
      />
    )
    expect(rebuildState.rebuild).toHaveBeenCalledTimes(1)
  })

  it('never aliases a removed row to the root while filtering rebuilds the projection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const nodes: HierarchyNode[] = [
      branch,
      { id: 'leaf-a', parentId: 'folder-a', kind: 'leaf', label: 'Documento A' },
      { id: 'leaf-b', parentId: 'folder-a', kind: 'leaf', label: 'Documento B' },
    ]
    const expandedProps = { ...props, nodes, expandedIds: ['folder-a'] }
    const { rerender } = render(<HierarchyTree {...expandedProps} />)

    rerender(<HierarchyTree {...expandedProps} nodes={[branch]} />)
    await waitFor(() => expect(rebuildState.rebuild).toHaveBeenCalled())

    expect(
      consoleError.mock.calls.some((call) =>
        call.some(
          (value) => typeof value === 'string' && value.includes('two children with the same key')
        )
      )
    ).toBe(false)
    consoleError.mockRestore()
  })

  it('returns a stable non-root tombstone for an explicit missing item', () => {
    render(<HierarchyTree {...props} />)

    const firstMiss = rebuildState.getItem('missing-leaf') as HierarchyNode
    const secondMiss = rebuildState.getItem('missing-leaf') as HierarchyNode
    expect(firstMiss).toMatchObject({
      id: 'missing-leaf',
      parentId: null,
      kind: 'leaf',
      disabled: true,
    })
    expect(firstMiss).toBe(secondMiss)
    expect(firstMiss.id).not.toBe('__sherlock_hierarchy_root__')
  })
})
