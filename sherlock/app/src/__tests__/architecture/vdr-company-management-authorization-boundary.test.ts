import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { exportBlockWithSeam } from '../utils/convex-effect-seam'

const CONVEX_ROOT = path.resolve(__dirname, '../../../convex')
const APP_ROOT = path.resolve(CONVEX_ROOT, '..')

type LegacyMarker =
  | 'hasOwnership'
  | 'requireOwnership'
  | 'loadOwnedDealOrThrow'
  | 'rawOwnerComparison'

type Exemption = {
  file: string
  declaration: string
  marker: LegacyMarker
  pattern: RegExp
  reason: string
}

type GateOption = {
  symbol: string
  source: string
}

type SurfaceContract = {
  file: string
  gates: GateOption[]
}

// This is deliberately an explicit issuer-management inventory. Expanding it
// is a security review decision; silently sweeping every Convex module would
// conflate a principal's own rows with authority to administer an issuer.
const MANAGER_SURFACES = [
  '_documents/bulk.ts',
  '_documents/governance.ts',
  '_documents/ingest.ts',
  '_documents/mutations.ts',
  '_documents/queries.ts',
  '_documents/shared.ts',
  '_documents/storage.ts',
  '_documents/uploadIntents.ts',
  '_documents/versions.ts',
  '_guests/companyRoom.ts',
] as const

const SURFACE_CONTRACTS: SurfaceContract[] = [
  {
    file: '_guests/companyRoom.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: '../_documents/shared' }],
  },
  {
    file: '_documents/shared.ts',
    gates: [
      {
        symbol: 'evaluateCompanyManagementAuthorization',
        source: '../_helpers/companyAuthorization',
      },
    ],
  },
  {
    file: '_documents/bulk.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: './shared' }],
  },
  {
    file: '_documents/governance.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: './shared' }],
  },
  {
    file: '_documents/ingest.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: './shared' }],
  },
  {
    file: '_documents/mutations.ts',
    gates: [
      { symbol: 'requireCompanyOwnerOrAdmin', source: './shared' },
      {
        symbol: 'evaluateCompanyManagementAuthorization',
        source: '../_helpers/companyAuthorization',
      },
    ],
  },
  {
    file: '_documents/queries.ts',
    gates: [
      { symbol: 'requireCompanyOwnerOrAdmin', source: './shared' },
      {
        symbol: 'requireCompanyReadAuthorization',
        source: '../_helpers/companyAuthorization',
      },
    ],
  },
  {
    file: '_documents/storage.ts',
    gates: [{ symbol: 'resolveDownloadAccess', source: './shared' }],
  },
  {
    file: '_documents/uploadIntents.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: './shared' }],
  },
  {
    file: '_documents/versions.ts',
    gates: [{ symbol: 'requireCompanyOwnerOrAdmin', source: './shared' }],
  },
]

// Each exception is declaration-scoped. The test also requires every entry to
// stay exercised, so deleting the projected/investor branch makes its exception
// fail until the now-unnecessary allowance is removed.
const EXEMPTIONS: Exemption[] = [
  {
    file: '_documents/queries.ts',
    declaration: 'getRoomActivity',
    marker: 'rawOwnerComparison',
    pattern: /\blog\.accessedById\s*!==\s*company\.ownerId\b/,
    reason:
      'The issuer activity projection removes the issuer own events after central authorization; the comparison cannot grant access.',
  },
  {
    file: '_documents/shared.ts',
    declaration: 'evaluateDocumentAccessWithBaseline',
    marker: 'hasOwnership',
    pattern:
      /\bhasOwnership\s*\(\s*profile\s*,\s*company\.ownerId\s*\)\s*&&\s*!baseline\.companyManagementAuthorized\b/,
    reason:
      'This projected decision only selects a revoked-authorization denial; management remains gated by companyManagementAuthorized.',
  },
]

const LEGACY_MARKERS: Array<{ name: LegacyMarker; pattern: RegExp }> = [
  { name: 'hasOwnership', pattern: /\bhasOwnership\b/g },
  { name: 'requireOwnership', pattern: /\brequireOwnership\b/g },
  { name: 'loadOwnedDealOrThrow', pattern: /\bloadOwnedDealOrThrow\b/g },
  {
    name: 'rawOwnerComparison',
    pattern:
      /(?:[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:===|!==|==|!=)\s*(?:company|deal)\.ownerId\b|\b(?:company|deal)\.ownerId\s*(?:===|!==|==|!=)\s*(?:[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)/g,
  },
]

function readConvexFile(relativePath: string): string {
  return fs.readFileSync(path.join(CONVEX_ROOT, relativePath), 'utf8')
}

function maskComments(source: string): string {
  const output = source.split('')
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]

    if (mode === 'code') {
      if (char === '/' && next === '/') mode = 'line'
      else if (char === '/' && next === '*') mode = 'block'
      else if (char === "'") mode = 'single'
      else if (char === '"') mode = 'double'
      else if (char === '`') mode = 'template'
      continue
    }

    if (mode === 'line') {
      if (char === '\n') mode = 'code'
      else output[index] = ' '
      continue
    }

    if (mode === 'block') {
      if (char === '*' && next === '/') {
        output[index] = ' '
        output[index + 1] = ' '
        index++
        mode = 'code'
      } else if (char !== '\n') {
        output[index] = ' '
      }
      continue
    }

    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`'
    if (char === '\\') {
      index++
      continue
    }
    if (char === closer) mode = 'code'
  }

  return output.join('')
}

function declarationRanges(source: string) {
  const declaration = /^(?:export\s+)?(?:async\s+)?(?:const|function)\s+([A-Za-z0-9_]+)/gm
  const starts = [...source.matchAll(declaration)].map((match) => ({
    name: match[1],
    start: match.index ?? 0,
  }))

  // Con la costura de Convex el cuerpo de `foo` vive en `fooProgram`, un
  // `const` de nivel superior que este corte ve como declaración propia. El
  // hallazgo se sigue detectando, pero bajo el nombre del programa, y las
  // exenciones de arriba están escritas con el nombre del export. Se traduce
  // el programa a su export, nunca al revés, para que exentar un export no
  // exente un programa que nadie registró.
  const exportForProgram = new Map<string, string>()
  const registration =
    /export const ([A-Za-z0-9_]+) = (?:internalMutation|internalQuery|internalAction|mutation|query|action)\(\{[\s\S]*?runConvex\(([A-Za-z0-9_]+)\(/g
  for (const match of source.matchAll(registration)) {
    exportForProgram.set(match[2], match[1])
  }

  return starts.map((entry, index) => ({
    ...entry,
    name: exportForProgram.get(entry.name) ?? entry.name,
    end: starts[index + 1]?.start ?? source.length,
  }))
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function importStatements(source: string): string[] {
  return [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm)].map((match) => match[0])
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * El sufijo `Effect` es la misma guarda con el AppError en el canal de error
 * tipado en vez de lanzado: `requireCompanyOwnerOrAdminEffect` verifica lo
 * mismo que `requireCompanyOwnerOrAdmin`. Se acepta explícitamente y no con un
 * comodín, para que una función parecida con otro nombre no cuente como
 * compuerta.
 */
function importsFrom(source: string, symbol: string, modulePath: string): boolean {
  const symbolPattern = new RegExp(`\\b${symbol}(?:Effect)?\\b`)
  const sourcePattern = new RegExp(`from\\s+['"]${escapeRegExp(modulePath)}['"]`)
  return importStatements(source).some(
    (statement) => symbolPattern.test(statement) && sourcePattern.test(statement)
  )
}

describe('VDR issuer-management authorization boundary', () => {
  it('keeps every manager surface on session-aware company authorization', () => {
    const violations: string[] = []
    const exercisedExemptions = new Set<string>()

    for (const file of MANAGER_SURFACES) {
      const rawSource = readConvexFile(file)
      const source = maskComments(rawSource)
      const ranges = declarationRanges(source)

      for (const marker of LEGACY_MARKERS) {
        for (const match of source.matchAll(marker.pattern)) {
          const index = match.index ?? 0
          const owner = ranges.find((range) => index >= range.start && index < range.end)
          const exemption = owner
            ? EXEMPTIONS.find((entry) => {
                if (
                  entry.file !== file ||
                  entry.declaration !== owner.name ||
                  entry.marker !== marker.name
                ) {
                  return false
                }
                const declarationSource = source.slice(owner.start, owner.end)
                const allowedMatch = declarationSource.match(entry.pattern)
                if (!allowedMatch || allowedMatch.index === undefined) return false
                const allowedStart = owner.start + allowedMatch.index
                const allowedEnd = allowedStart + allowedMatch[0].length
                return index >= allowedStart && index < allowedEnd
              })
            : undefined

          if (exemption) {
            exercisedExemptions.add(
              `${exemption.file}:${exemption.declaration}:${exemption.marker}`
            )
            continue
          }

          // A legacy import is allowed only when this exact symbol is still
          // required by a live declaration-scoped investor/projection exemption.
          const importAllowance = !owner
            ? EXEMPTIONS.some((entry) => entry.file === file && entry.marker === marker.name)
            : false
          if (importAllowance) continue

          violations.push(
            `${file}:${lineNumberAt(rawSource, index)} ${owner?.name ?? 'module import'} uses ${marker.name}`
          )
        }
      }
    }

    const expectedExemptions = EXEMPTIONS.map(
      (entry) => `${entry.file}:${entry.declaration}:${entry.marker}`
    ).sort()
    expect(EXEMPTIONS.every((entry) => entry.reason.trim().length >= 40)).toBe(true)
    expect([...exercisedExemptions].sort()).toEqual(expectedExemptions)

    expect(SURFACE_CONTRACTS.map((contract) => contract.file).sort()).toEqual(
      [...MANAGER_SURFACES].sort()
    )

    for (const contract of SURFACE_CONTRACTS) {
      const source = readConvexFile(contract.file)
      const missingGates = contract.gates.filter(
        (gate) =>
          !importsFrom(source, gate.symbol, gate.source) ||
          !new RegExp(`\\b${gate.symbol}(?:Effect)?\\s*\\(`).test(maskComments(source))
      )
      if (missingGates.length > 0) {
        violations.push(
          `${contract.file} must import and call ${missingGates
            .map((gate) => `${gate.symbol} from ${gate.source}`)
            .join(', ')}`
        )
      }
    }

    // La puerta de la invitación a la sala de empresa es el único gateway de
    // gestión que queda: exige la autorización central con sesión y no puede
    // caer en una comparación cruda de propiedad.
    const companyRoomSource = maskComments(readConvexFile('_guests/companyRoom.ts'))
    const managerBlock = declarationRanges(companyRoomSource).find(
      (range) => range.name === 'requireCompanyGuestManager'
    )
    expect(managerBlock).toBeDefined()
    const managerBody = companyRoomSource.slice(managerBlock!.start, managerBlock!.end)
    expect(managerBody).toMatch(/\brequireCompanyOwnerOrAdmin\s*\(/)
    expect(managerBody).not.toMatch(
      /\b(?:hasOwnership|requireOwnership)\b/
    )

    // This internal mutation is reached through a server API client rather than
    // Convex session auth. Keep the authenticated WorkOS subject explicit so a
    // caller cannot reconstruct management authority from a profile id alone.
    const documentMutationsSource = maskComments(readConvexFile('_documents/mutations.ts'))
    // Este bloque necesita las dos mitades: los validadores `v.*`, que viven en
    // el registro, y la lógica de autorización, que vive en el programa.
    // `exportBlockWithSeam` devuelve la unión de ambas.
    const validatedUploadBody = exportBlockWithSeam(
      documentMutationsSource,
      'createFromValidatedUpload'
    )
    expect(validatedUploadBody).toBeDefined()
    expect(validatedUploadBody).toMatch(/uploaderProviderUserId:\s*v\.string\(\)/)
    expect(validatedUploadBody).toMatch(
      /uploaderUser\.workosUserId\s*!==\s*args\.uploaderProviderUserId/
    )
    expect(validatedUploadBody).toMatch(/\bevaluateCompanyManagementAuthorization\s*\(/)

    const uploadRoute = fs.readFileSync(
      path.join(APP_ROOT, 'src/app/api/documents/upload/route.ts'),
      'utf8'
    )
    expect(uploadRoute).toMatch(/uploaderProviderUserId:\s*user\.id/)

    // These wrappers are only session-aware when callers propagate the live
    // AuthResult. Passing a profile recreates the provider-blind boundary even
    // if the wrapper name itself remains unchanged.
    const profileOnlyDocumentGate =
      /\b(?:requireCompanyOwnerOrAdmin|assertDocumentAccess|resolveDownloadAccess|evaluateDocumentAccess)\s*\(\s*ctx\s*,\s*profile\b/g
    for (const file of MANAGER_SURFACES.filter((entry) => entry.startsWith('_documents/'))) {
      const source = maskComments(readConvexFile(file))
      for (const match of source.matchAll(profileOnlyDocumentGate)) {
        violations.push(
          `${file}:${lineNumberAt(source, match.index ?? 0)} passes profile instead of AuthResult to a document authorization gate`
        )
      }
    }

    expect(violations).toEqual([])
  })
})
