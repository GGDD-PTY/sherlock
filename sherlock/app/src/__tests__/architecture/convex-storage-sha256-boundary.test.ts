// ============================================================================
// CONVEX STORAGE SHA256 BOUNDARY
// ============================================================================
// Incidente 2026-08-26 (LESSONS, PR #418): Convex Storage expone
// `_storage.sha256` en base64 aunque su doc diga base16. Todo digest de blob
// leído de `ctx.db.system.get()` debe pasar por `normalizeSha256Hex` (o su
// alias `normalizeModelRunSha256`) antes de compararse o persistirse; un
// `blob.sha256` desnudo comparado contra hex rechazó el 100% de los uploads
// de prod mientras CI seguía verde con fixtures placeholder.
//
// El contrato es léxico y de dos frentes:
//   1. binding: toda variable asignada desde `ctx.db.system.get(...)`;
//   2. naming: todo identificador que termina en `blob`/`Blob` (la convención
//      del repo para metadata de storage), tenga o no el binding a la vista
//      (cubre parámetros de helpers).
// Cada lectura `.sha256` de un identificador rastreado debe estar envuelta en
// el normalizador, ser un guard `typeof`, o ser el fallback documentado
// `normalizeSha256Hex(x.sha256) ?? x.sha256`.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const CONVEX_ROOT = path.join(APP_ROOT, 'convex')

interface NakedDigestSite {
  line: number
  identifier: string
  snippet: string
}

function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  return withoutBlocks
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

// El binding pre-Effect es `const x = await ctx.db.system.get(...)`. La
// costura de `convex/_helpers/effect.ts` lo reescribió a
// `const x = yield* convexPromise(() => ctx.db.system.get(...))` (o
// `async () =>` cuando el callback también espera algo más) en las 17
// llamadas de `convex/` — ninguna quedó en la forma `await`. Sin esta
// alternativa el regex no rastreaba NINGÚN binding real y la detección
// completa dependía del fallback por nombre (`.../blob$/i`), que no cubre un
// binding sin ese sufijo (`operatorPrune.ts:197` tiene uno: `const stored =`).
const SYSTEM_GET_BINDING =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(?\s*await\s+|yield\*\s*convexPromise\(\s*(?:async\s*)?\(\)\s*=>\s*)ctx\.db\.system\.get\(/g
const SHA256_READ = /\b([A-Za-z_$][\w$]*)\.sha256\b/g
const NORMALIZER_CALL = /(?:normalizeSha256Hex|normalizeModelRunSha256)\s*\(\s*$/
const TYPEOF_GUARD = /\btypeof\s*$/

export function findNakedBlobSha256Sites(source: string): NakedDigestSite[] {
  const code = stripComments(source)
  const tracked = new Set<string>()
  for (const match of code.matchAll(SYSTEM_GET_BINDING)) {
    tracked.add(match[1])
  }

  const lines = code.split('\n')
  const sites: NakedDigestSite[] = []
  for (const match of code.matchAll(SHA256_READ)) {
    const identifier = match[1]
    if (!tracked.has(identifier) && !/blob$/i.test(identifier)) continue

    const before = code.slice(Math.max(0, match.index - 200), match.index)
    if (NORMALIZER_CALL.test(before) || TYPEOF_GUARD.test(before)) continue

    const lineNumber = code.slice(0, match.index).split('\n').length
    const line = lines[lineNumber - 1] ?? ''
    const fallbackIdiom = new RegExp(
      `(?:normalizeSha256Hex|normalizeModelRunSha256)\\(\\s*${identifier}\\.sha256\\s*\\)\\s*\\?\\?\\s*${identifier}\\.sha256`
    )
    if (/\?\?\s*$/.test(before) && fallbackIdiom.test(line)) continue

    sites.push({ line: lineNumber, identifier, snippet: line.trim() })
  }
  return sites
}

// Baseline documentada: sitios que normalizan a mano con `.toLowerCase()` en vez
// de `normalizeSha256Hex`. Quedan fijados por snippet (no por línea) para que un
// sitio NUEVO en el mismo archivo siga rompiendo esta prueba. Al pasar el módulo
// por el normalizador se borra la entrada, no se amplía la lista. Vacía desde
// que el puente MCP→VDR salió del árbol ([F] 2026-09-06, DECISIONS).
const DOCUMENTED_BASELINE: ReadonlyArray<{ file: string; snippet: string }> = []

function isBaselined(file: string, snippet: string): boolean {
  return DOCUMENTED_BASELINE.some((entry) => entry.file === file && entry.snippet === snippet)
}

function convexSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '_generated') return []
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return convexSourceFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

describe('convex storage sha256 boundary', () => {
  it('detects a naked digest comparison on a system.get binding regardless of its name', () => {
    const sites = findNakedBlobSha256Sites(
      [
        'const metadata = await ctx.db.system.get(args.storageId)',
        'if (metadata.sha256 !== intent.declaredSha256) reject()',
      ].join('\n')
    )
    expect(sites).toEqual([
      {
        line: 2,
        identifier: 'metadata',
        snippet: 'if (metadata.sha256 !== intent.declaredSha256) reject()',
      },
    ])
  })

  it('detects a naked digest comparison on an Effect system.get binding, blob-named or not', () => {
    const sites = findNakedBlobSha256Sites(
      [
        'const stored = yield* convexPromise(() => ctx.db.system.get(version.storageId))',
        'if (stored.sha256 !== intent.declaredSha256) reject()',
        'const legacyBlob = yield* convexPromise(async () => ctx.db.system.get(replacementStorageId))',
        'if (legacyBlob.sha256 !== intent.declaredSha256) reject()',
      ].join('\n')
    )
    expect(sites.map((site) => site.identifier)).toEqual(['stored', 'legacyBlob'])
  })

  it('detects naked persistence and blob-named parameters without a visible binding', () => {
    const sites = findNakedBlobSha256Sites(
      [
        'function register(storedBlob: StorageDoc) {',
        '  return { sha256: storedBlob.sha256 }',
        '}',
      ].join('\n')
    )
    expect(sites.map((site) => site.line)).toEqual([2])
  })

  it('accepts the normalized, typeof-guarded, and documented fallback forms', () => {
    const sites = findNakedBlobSha256Sites(
      [
        'const blob = await ctx.db.system.get(args.storageId)',
        'if (typeof blob.sha256 !== "string") reject()',
        'const hashMismatch = normalizeSha256Hex(blob.sha256) !== intent.declaredSha256',
        'const stored = normalizeSha256Hex(blob.sha256) ?? blob.sha256',
        'const wrapped = normalizeModelRunSha256(',
        '  blob.sha256',
        ')',
      ].join('\n')
    )
    expect(sites).toEqual([])
  })

  it('keeps the canonical normalizer in place', () => {
    const helper = fs.readFileSync(path.join(CONVEX_ROOT, '_helpers', 'sha256.ts'), 'utf8')
    expect(helper).toMatch(/export function normalizeSha256Hex\b/)
  })

  it('never compares or persists a storage blob sha256 without normalizeSha256Hex in convex/', () => {
    const violations = convexSourceFiles(CONVEX_ROOT).flatMap((filePath) => {
      const relative = path.relative(APP_ROOT, filePath)
      return findNakedBlobSha256Sites(fs.readFileSync(filePath, 'utf8'))
        .filter((site) => !isBaselined(relative, site.snippet))
        .map((site) => `${relative}:${site.line}: ${site.snippet}`)
    })

    expect(violations).toEqual([])
  })
})
