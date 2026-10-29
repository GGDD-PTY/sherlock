// ============================================================================
// VDR READ MCP — executable import boundary
// ============================================================================
// The client-facing read surface is the only MCP in the tree since the Mycroft
// bridge was deleted ([F] 2026-09-06, DECISIONS), and this lock keeps it that
// way: the test fails if `src/lib/vdr-mcp` or `src/app/api/vdr-mcp` ever
// reaches into model runs, private worker routes, Mycroft, the broker, or a
// MODEL_RUNS_* secret — and if the shared OAuth core ever depends on a
// concrete surface (the direction must stay surface -> shared, never
// shared -> surface).
// ============================================================================

import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const SOURCE_EXTENSION = /\.(?:c|m)?tsx?$/

const READ_SURFACE_ROOTS = [
  'src/lib/vdr-mcp',
  'src/app/api/vdr-mcp',
  // RFC 9728 forces these URLs (and therefore these paths) to nest under the
  // shared `/.well-known/oauth-protected-resource` segment. The whole subtree
  // is the read surface's: the root PRM and the one by path. The Model Runs
  // architecture test excludes the subtree; this one owns it.
  'src/app/.well-known/oauth-protected-resource',
]
const SHARED_ROOTS = ['src/lib/mcp-shared']

const FORBIDDEN_IN_READ_SURFACE: Array<[string, RegExp]> = [
  ['imports-model-runs', /from\s+['"](?:@\/lib\/model-runs|[./]*(?:\.\.\/)*model-runs)\//],
  ['imports-model-runs-convex', /from\s+['"][^'"]*convex\/_modelRuns\//],
  ['imports-internal-routes', /from\s+['"][^'"]*app\/api\/internal\//],
  ['references-internal-route-path', /['"`]\/api\/internal\//],
  ['imports-worker', /from\s+['"][^'"]*(?:sherlock-)?worker(?:['"/])/i],
  ['mentions-mycroft', /\bmycroft\b/i],
  ['mentions-broker', /\bmog-broker\b|\bbrokerLane\b|\bbroker_lane\b/i],
  ['model-runs-secret', /\bMODEL_RUNS_[A-Z_]+\b/],
  [
    'model-runs-tool-dispatch',
    /\bprepare_financial_model\b|\blist_model_run_disclosures\b|\bget_authorized_model_artifact\b/,
  ],
  ['artifact-uri-scheme', /sm-artifact:\/\//],
]

const FORBIDDEN_IN_SHARED: Array<[string, RegExp]> = [
  ['shared-imports-model-runs', /from\s+['"][^'"]*model-runs\//],
  ['shared-imports-vdr-mcp', /from\s+['"][^'"]*vdr-mcp\//],
  ['shared-knows-a-surface-env', /\bMODEL_RUNS_[A-Z_]+\b|\bVDR_MCP_[A-Z_]+\b/],
]

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function walkFiles(current: string): string[] {
  if (!existsSync(current)) return []
  const stat = lstatSync(current)
  if (stat.isSymbolicLink()) return []
  if (stat.isFile()) return [current]
  if (!stat.isDirectory()) return []
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => walkFiles(resolve(current, entry.name)))
}

function sourcesUnder(roots: readonly string[]): Array<{ path: string; source: string }> {
  const appRoot = process.cwd()
  return roots
    .flatMap((root) => walkFiles(resolve(appRoot, root)))
    .filter((path) => SOURCE_EXTENSION.test(path))
    .map((path) => ({
      path: toPosix(relative(appRoot, path)),
      source: readFileSync(path, 'utf8'),
    }))
}

function violations(
  files: ReadonlyArray<{ path: string; source: string }>,
  rules: ReadonlyArray<[string, RegExp]>
): string[] {
  const found: string[] = []
  for (const file of files) {
    for (const [rule, pattern] of rules) {
      if (pattern.test(file.source)) found.push(`${file.path}: ${rule}`)
    }
  }
  return found.sort()
}

describe('VDR read MCP import boundary', () => {
  it('detects a planted violation so the scanner cannot pass vacuously', () => {
    const planted = [
      {
        path: 'src/lib/vdr-mcp/planted.ts',
        source: [
          "import { createSherlockMcpHandler } from '@/lib/model-runs/mcp'",
          'const secret = process.env.MODEL_RUNS_SERVER_SECRET',
          "await fetch('/api/internal/model-runs/claim')",
          "const uri = 'sm-artifact://v1/abc'",
          '// mycroft worker bridge',
        ].join('\n'),
      },
    ]
    expect(
      violations(planted, FORBIDDEN_IN_READ_SURFACE).map((entry) => entry.split(': ')[1])
    ).toEqual(
      expect.arrayContaining([
        'imports-model-runs',
        'model-runs-secret',
        'references-internal-route-path',
        'artifact-uri-scheme',
        'mentions-mycroft',
      ])
    )
  })

  it('keeps the real read surface free of Model Runs, worker and Mycroft reach', () => {
    const files = sourcesUnder(READ_SURFACE_ROOTS)
    expect(files.length, 'the VDR read surface must exist').toBeGreaterThan(5)
    expect(violations(files, FORBIDDEN_IN_READ_SURFACE)).toEqual([])
  })

  it('keeps the shared OAuth core independent of every concrete surface', () => {
    const files = sourcesUnder(SHARED_ROOTS)
    expect(files.length, 'the shared MCP core must exist').toBeGreaterThan(0)
    expect(violations(files, FORBIDDEN_IN_SHARED)).toEqual([])
  })

  it('keeps the read route outside the retired bridge directories', () => {
    const appRoot = process.cwd()
    // Directories of the deleted bridge; the lock outlives them on purpose.
    const successorDirectories = [
      'src/lib/model-runs',
      'src/app/api/mcp',
      'src/app/api/internal/model-runs',
      'convex/_modelRuns',
    ]
    const readSurfacePaths = [
      'src/app/api/vdr-mcp/route.ts',
      'src/lib/vdr-mcp/mcp.ts',
      'convex/vdrRead.ts',
    ]
    for (const path of readSurfacePaths) {
      expect(existsSync(resolve(appRoot, path)), path).toBe(true)
      for (const directory of successorDirectories) {
        expect(path.startsWith(`${directory}/`), `${path} must stay outside ${directory}`).toBe(
          false
        )
      }
    }
  })
})
