import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The committed convex/_generated/api.d.ts does not cover every module (intake,
// support), so app code reaches those functions through
// makeFunctionReference<'kind', ...>('module:fn') with a hand-declared kind that
// the compiler cannot check. This contract imports each referenced module and
// compares the declared kind with the registered function's own flags.

const APP_ROOT = resolve(process.cwd())
const SRC_ROOT = resolve(APP_ROOT, 'src')
const CONVEX_ROOT = resolve(APP_ROOT, 'convex')
const SKIPPED_DIRECTORIES = new Set(['__tests__', 'node_modules', '.next'])
const REFERENCE_PATTERN =
  /makeFunctionReference<\s*'(query|mutation|action)'[\s\S]*?>\(\s*'([^']+)'\s*\)/g

type Reference = { file: string; kind: string; name: string }

function collectSourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) collectSourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path)
  }
  return out
}

function collectReferences(): Reference[] {
  const references: Reference[] = []
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(REFERENCE_PATTERN)) {
      references.push({ file: relative(APP_ROOT, file), kind: match[1], name: match[2] })
    }
  }
  return references
}

function registeredKind(exported: unknown): string {
  const fn = exported as { isQuery?: boolean; isMutation?: boolean; isAction?: boolean }
  if (fn?.isQuery) return 'query'
  if (fn?.isMutation) return 'mutation'
  if (fn?.isAction) return 'action'
  return 'unknown'
}

describe('string function references declare the real Convex kind', () => {
  const references = collectReferences()

  it('finds the string references used by the app', () => {
    expect(references.length).toBeGreaterThan(0)
  })

  for (const reference of references) {
    it(`${reference.name} is a ${reference.kind} (${reference.file})`, async () => {
      const [modulePath, functionName] = reference.name.split(':')
      const convexModule = (await import(join(CONVEX_ROOT, `${modulePath}.ts`))) as Record<
        string,
        unknown
      >
      expect(
        convexModule[functionName],
        `convex/${modulePath}.ts must export ${functionName}`
      ).toBeDefined()
      expect(registeredKind(convexModule[functionName])).toBe(reference.kind)
    })
  }
})
