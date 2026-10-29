import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// ===== EL NAVEGADOR NO IMPORTA MÓDULOS QUE REGISTRAN FUNCIONES =====
// `/es/admin/security` abría con el overlay «7 Issues» de Next y el log del
// servidor decía «Convex functions should not be imported in the browser».
// La causa: `AdminSecurityClient.tsx` importaba su vocabulario de
// `convex/security.ts`, que además registra seis `query` y `mutation`. Cada
// builder llama a `assertNotBrowser()` al construirse
// (`node_modules/convex/dist/esm/server/impl/registration_impl.js`), así que
// basta con que el módulo entre al bundle del cliente para que el error salga
// en cada carga; Convex avisa que en una versión futura va a tirar.
//
// Cruzar `convex/` → `src/` sigue permitido: lo que no se puede es cruzar
// hacia un módulo que registre funciones, ni hacia uno que importe a otro que
// las registre. El vocabulario compartido vive en un módulo puro
// (`convex/_security/shared.ts`, `convex/_roadmap/registry.ts`,
// `convex/_adminVdr/capabilityFormat.ts`). Tarjeta OB-RES-3.

const APP = resolve(__dirname, '..', '..', '..')
const SRC = join(APP, 'src')
const CONVEX = join(APP, 'convex')

// La convención del repo: toda función de Convex se registra como
// `export const nombre = builder(`.
const REGISTERS_FUNCTION =
  /^export const \w+ = (?:internalQuery|internalMutation|internalAction|query|mutation|action|httpAction)\(/m

const IMPORT_SPECIFIER = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g
const NON_NEWLINE = /[^\n]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '_generated' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function stripComments(source: string): string {
  return source
    .replaceAll(BLOCK_COMMENT, (block) => block.replaceAll(NON_NEWLINE, ' '))
    .replaceAll(LINE_COMMENT, (line, lead: string) => lead + ' '.repeat(line.length - lead.length))
}

function importedPaths(source: string): string[] {
  const paths: string[] = []
  IMPORT_SPECIFIER.lastIndex = 0
  for (const match of source.matchAll(IMPORT_SPECIFIER)) paths.push(match[1])
  return paths
}

/** `@/../convex/x`, `../../convex/x` y `./x` desde dentro de `convex/`. */
function resolveConvexModule(specifier: string, fromFile: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : undefined
  if (base === undefined) return undefined
  if (!base.startsWith(`${CONVEX}/`)) return undefined
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const registers = new Map<string, boolean>()
for (const file of walk(CONVEX)) {
  registers.set(file, REGISTERS_FUNCTION.test(stripComments(readFileSync(file, 'utf-8'))))
}

/** El primer módulo con registros al que llega `entry`, o `undefined`. */
function reachesRegistration(entry: string): string | undefined {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (seen.has(current)) continue
    seen.add(current)
    if (registers.get(current) === true) return current
    for (const specifier of importedPaths(stripComments(readFileSync(current, 'utf-8')))) {
      const next = resolveConvexModule(specifier, current)
      if (next !== undefined) queue.push(next)
    }
  }
  return undefined
}

function findOffences(): string[] {
  const offences: string[] = []
  for (const file of walk(SRC)) {
    if (!file.endsWith('.tsx')) continue
    for (const specifier of importedPaths(stripComments(readFileSync(file, 'utf-8')))) {
      const target = resolveConvexModule(specifier, file)
      if (target === undefined) continue
      const registrar = reachesRegistration(target)
      if (registrar === undefined) continue
      offences.push(
        `${relative(APP, file)} importa ${specifier}, que llega a ${relative(APP, registrar)}`
      )
    }
  }
  return offences
}

const OFFENCES = findOffences()
const SHARED_VOCABULARY = reachesRegistration(join(CONVEX, '_security', 'shared.ts'))
const SECURITY_MODULE = reachesRegistration(join(CONVEX, 'security.ts'))

describe('convex browser import boundary', () => {
  it('keeps modules that register Convex functions out of client components', () => {
    expect(OFFENCES).toEqual([])
  })

  it('sees the vocabulary module as pure and convex/security.ts as a registrar', () => {
    expect(SHARED_VOCABULARY).toBeUndefined()
    expect(SECURITY_MODULE).toBe(join(CONVEX, 'security.ts'))
  })
})
