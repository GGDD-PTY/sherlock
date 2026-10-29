// ============================================================================
// CONVEX SUITE TAUTOLOGY GUARD
// ============================================================================
// A suite under src/__tests__/convex/ that never touches convex/ source can only
// assert on its own mocks — it names a production module in its describe string
// while exercising zero production lines. Those suites read as coverage in a
// grep and provide none.
//
// This is a RATCHET, not a rewrite: the known-tautological suites are listed in
// TAUTOLOGICAL_SUITES_BASELINE. New files may not join the list, and a file that
// gets rewritten to touch real code must be REMOVED from it (the second test
// fails otherwise). The list may only shrink.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONVEX_SUITE_DIR = join(process.cwd(), 'src/__tests__/convex')

// Suites that still assert only on their own mocks. Do not add entries.
const TAUTOLOGICAL_SUITES_BASELINE = [
  'activityLogs.test.ts',
  'documents.test.ts',
  'notifications.test.ts',
]

// The baseline may only shrink, and the ceiling shrinks with it: leaving room
// above the list lets a deletion be undone without turning this red. Raise
// nothing here; lower both as suites are rewritten to invoke real handlers.
// 2026-09-11: 8 -> 4. `crons.test.ts` now reads the real cron registry;
// `analytics`, `auth-helpers` and `kyc-transitions` were deleted (their
// remaining suites are auth-helpers-real and the KYC cron bounds).
// `analyticsIncremental.test.ts` still covers the counter module; production
// no longer calls it.
const BASELINE_CEILING = 4

function convexSuiteFiles(): string[] {
  return readdirSync(CONVEX_SUITE_DIR)
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
}

/**
 * What survives the compiler and is not globally mocked. An `import type` is
 * erased on emit and `convex/_generated/` is mocked in setup: neither one
 * proves the suite reaches production.
 */
function runtimeSource(file: string): string {
  return readFileSync(join(CONVEX_SUITE_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*import\s+type\s/.test(line))
    .filter((line) => !/convex\/_generated\//.test(line))
    .join('\n')
}

/**
 * True when the suite reaches production code: it imports a module from convex/
 * or from the app under `@/`, or it pins a source-string contract by reading a
 * convex/ file.
 */
function exercisesProductionCode(file: string): boolean {
  const source = runtimeSource(file)

  const importsConvexModule = /from\s+'(?:\.\.\/)+convex\//.test(source)
  const importsAppModule = /from\s+'@\//.test(source)
  const readsConvexSource =
    /readFileSync\(/.test(source) && /['"](?:\.\.\/)*convex(?:\/|['"])/.test(source)

  return importsConvexModule || importsAppModule || readsConvexSource
}

describe('convex test suites exercise production code', () => {
  it('has no tautological suite outside the documented baseline', () => {
    const offenders = convexSuiteFiles().filter(
      (file) => !exercisesProductionCode(file) && !TAUTOLOGICAL_SUITES_BASELINE.includes(file)
    )

    expect(offenders).toEqual([])
  })

  it('keeps the baseline honest: entries that now touch real code must be removed', () => {
    const staleEntries = TAUTOLOGICAL_SUITES_BASELINE.filter(
      (file) => convexSuiteFiles().includes(file) && exercisesProductionCode(file)
    )

    expect(staleEntries).toEqual([])
  })

  it('lists only files that still exist', () => {
    const files = convexSuiteFiles()
    const missing = TAUTOLOGICAL_SUITES_BASELINE.filter((file) => !files.includes(file))

    expect(missing).toEqual([])
  })

  it('never grows the baseline', () => {
    expect(TAUTOLOGICAL_SUITES_BASELINE.length).toBeLessThanOrEqual(BASELINE_CEILING)
  })
})
