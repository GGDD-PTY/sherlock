import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(process.cwd(), 'src')
const HIERARCHY_TREE = 'src/components/hierarchy/HierarchyTree.tsx'
const HIERARCHY_TYPES = 'src/lib/hierarchy/types.ts'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [absolute] : []
  })
}

function productionSources() {
  return sourceFiles(SRC_ROOT)
    .map((absolute) => ({
      path: relative(process.cwd(), absolute).split(sep).join('/'),
      source: readFileSync(absolute, 'utf8'),
    }))
    .filter(({ path }) => !path.startsWith('src/__tests__/'))
    .filter(({ path }) => !path.includes('/dev-viewers/'))
}

describe('hierarchy engine boundary', () => {
  it('keeps @headless-tree imports in the single Sherlock-owned production adapter', () => {
    const importers = productionSources()
      .filter(({ source }) => source.includes("from '@headless-tree/"))
      .map(({ path }) => path)

    expect(importers).toEqual([HIERARCHY_TREE])
  })

  it('uses the React Compiler getter entrypoint without exporting engine instance types', () => {
    const sources = productionSources()
    const hierarchyTree = sources.find(({ path }) => path === HIERARCHY_TREE)?.source

    expect(hierarchyTree).toContain("from '@headless-tree/react/react-compiler'")
    expect(hierarchyTree).not.toMatch(/const\s+\w+\s*=\s*tree\(\)\s*;?(?:\r?\n|$)/)

    const leakedEngineTypes = sources
      .filter(({ source }) => /\b(?:TreeInstance|ItemInstance)\b/.test(source))
      .map(({ path }) => path)

    expect(leakedEngineTypes).toEqual([])
  })

  it('keeps browser transfer objects inside the hierarchy adapter', () => {
    const sources = productionSources()
    const transferOwners = sources
      .filter(({ source }) => /\bDataTransfer\b/.test(source))
      .map(({ path }) => path)
    const publicTypes = sources.find(({ path }) => path === HIERARCHY_TYPES)?.source

    expect(transferOwners).toEqual([HIERARCHY_TREE])
    expect(publicTypes).not.toMatch(/\b(?:DataTransfer|DragTarget|ItemInstance|TreeInstance)\b/)
  })
})
