import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// convex/_generated/api.d.ts is committed, so it drifts every time a Convex
// module is added without rerunning codegen. When it drifts, app code falls
// back to string makeFunctionReference calls that the compiler cannot check.
// This contract mirrors the Convex CLI entry-point filter and fails when the
// generated file and the tree disagree in either direction.

const CONVEX_ROOT = resolve(process.cwd(), 'convex')
const GENERATED_API = join(CONVEX_ROOT, '_generated', 'api.d.ts')
const ENTRY_POINT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts']

function isConvexEntryPoint(relPath: string): boolean {
  const base = basename(relPath)
  if (!ENTRY_POINT_EXTENSIONS.some((ext) => relPath.endsWith(ext))) return false
  if (relPath.endsWith('.d.ts')) return false
  if (relPath.startsWith(`_generated${sep}`) || relPath.startsWith(`_deps${sep}`)) return false
  if (base.startsWith('.') || base.startsWith('#')) return false
  if (base === 'schema.ts' || base === 'schema.js') return false
  if (relPath.includes(' ')) return false
  if (base.split('.').length > 2) return false
  return true
}

function collectEntryPoints(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      collectEntryPoints(path, out)
      continue
    }
    const relPath = relative(CONVEX_ROOT, path)
    if (!isConvexEntryPoint(relPath)) continue
    const source = readFileSync(path, 'utf8')
    if (!/^\s*(import|export)\b/m.test(source)) continue
    out.push(
      relPath
        .replace(/\.[cm]?[jt]sx?$/, '')
        .split(sep)
        .join('/')
    )
  }
  return out.sort()
}

function collectGeneratedModules(): string[] {
  const source = readFileSync(GENERATED_API, 'utf8')
  return [...source.matchAll(/^import type \* as \S+ from "\.\.\/(.+?)\.js";$/gm)]
    .map((match) => match[1])
    .sort()
}

describe('convex/_generated/api.d.ts covers every Convex module', () => {
  const onDisk = collectEntryPoints(CONVEX_ROOT)
  const generated = collectGeneratedModules()

  it('lists every module on disk (run `bunx convex codegen` when this fails)', () => {
    const missing = onDisk.filter((module) => !generated.includes(module))
    expect(missing, `modules missing from _generated/api.d.ts: ${missing.join(', ')}`).toEqual([])
  })

  it('lists no module that no longer exists on disk', () => {
    const stale = generated.filter((module) => !onDisk.includes(module))
    expect(stale, `stale modules in _generated/api.d.ts: ${stale.join(', ')}`).toEqual([])
  })
})
