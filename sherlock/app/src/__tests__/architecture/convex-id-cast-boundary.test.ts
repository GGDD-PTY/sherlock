import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

// El 2026-08-28 `/settings/privacy` caía al error boundary en cada entrada por
// `/dev-login`. La causa era una sola línea:
//
//   export const DEMO_COMPANY_PROFILE_ID = 'demo_company_profile' as Id<'profiles'>
//
// El `as` satisface al compilador y no convierte la cadena en un id de Convex.
// `useCurrentUserDev` sintetizaba un perfil con ese `_id`, y toda query que
// declarara `profileId: v.id('profiles')` lo rechazaba en runtime con
// `Validator: v.id("profiles")`. El tipo decía que era un id; la base decía que
// no. TypeScript no puede cazarlo porque el cast es precisamente la instrucción
// de dejar de mirar.
//
// Un id de Convex se obtiene leyéndolo de la base o recibiéndolo del cliente y
// validándolo — nunca escribiéndolo a mano.

const APP = join(__dirname, '../../..')
const SRC = join(APP, 'src')
const CONVEX = join(APP, 'convex')

// `'literal' as Id<'tabla'>` y su forma con comillas dobles o backticks.
const LITERAL_ID_CAST = /(['"`])[^'"`\n]*\1\s+as\s+(?:unknown\s+as\s+)?Id<\s*['"`]\w+['"`]\s*>/g

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
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + ' '.repeat(line.length - lead.length))
}

type Offence = { file: string; line: number; snippet: string }

function findLiteralIdCasts(roots: string[]): Offence[] {
  const offences: Offence[] = []
  for (const root of roots) {
    for (const file of walk(root)) {
      // Las suites pueden fabricar ids: nunca llegan a un validador de Convex.
      if (file.includes('__tests__') || /\.(test|spec)\.tsx?$/.test(file)) continue
      const source = stripComments(readFileSync(file, 'utf-8'))
      LITERAL_ID_CAST.lastIndex = 0
      for (const match of source.matchAll(LITERAL_ID_CAST)) {
        offences.push({
          file: relative(APP, file),
          line: source.slice(0, match.index).split('\n').length,
          snippet: match[0].slice(0, 80),
        })
      }
    }
  }
  return offences
}

// Línea base al 2026-08-28: 65 casts repartidos en 13 archivos, casi todos
// fixtures de dev y clientes admin que pintan datos demo. Son deuda conocida,
// no se arreglan de paso, y el ratchet existe para que no crezcan. La entrada
// que rompía `/settings/privacy` sigue en `demo-data.ts`, pero ya no llega a
// Convex: `useCurrentUserDev` lee el perfil real y sólo cae al literal en el
// modo "view as" de un admin, donde ese id nunca se le pasa a una query.
const BASELINE: Record<string, number> = {
  'convex/_helpers/companyVisibility.ts': 1,
  'src/app/[locale]/dev-viewers/ViewerBenchClient.tsx': 2,
  'src/components/admin/AdminSecurityClient.tsx': 5,
  'src/components/admin/AuditLogsClient.tsx': 4,
  'src/components/company/SupportThread.tsx': 1,
  'src/lib/dev-auth/demo-data.ts': 12,
}

describe('Convex id cast boundary', () => {
  it('adds no new string-literal Id<> cast, and lets the known ones shrink', () => {
    const byFile = new Map<string, number>()
    for (const o of findLiteralIdCasts([SRC, CONVEX])) {
      byFile.set(o.file, (byFile.get(o.file) ?? 0) + 1)
    }

    const regressions: string[] = []
    for (const [file, count] of byFile) {
      const allowed = BASELINE[file] ?? 0
      if (count > allowed) {
        regressions.push(
          allowed === 0
            ? `${file}: ${count} cast(s) nuevos — un id de Convex se lee de la base, no se escribe a mano`
            : `${file}: ${count} casts, la línea base permite ${allowed}`
        )
      }
    }

    expect(regressions).toEqual([])

    // El ratchet baja, nunca sube: si un archivo se limpió, hay que bajarle el
    // número aquí para que no vuelva a subir sin que nadie lo note.
    const stale = Object.entries(BASELINE)
      .filter(([file, allowed]) => (byFile.get(file) ?? 0) < allowed)
      .map(
        ([file, allowed]) => `${file}: quedan ${byFile.get(file) ?? 0}, baja la base de ${allowed}`
      )

    expect(stale).toEqual([])
  })

  // Sin esto el contrato podría quedar verde para siempre por un regex roto.
  it('recognises the exact shape that broke the privacy page', () => {
    const broken = `export const DEMO_COMPANY_PROFILE_ID = 'demo_company_profile' as Id<'profiles'>`
    LITERAL_ID_CAST.lastIndex = 0
    expect(LITERAL_ID_CAST.test(broken)).toBe(true)

    LITERAL_ID_CAST.lastIndex = 0
    expect(LITERAL_ID_CAST.test(`const id = doc._id`)).toBe(false)

    // La variante `as unknown as Id<>` esquiva al compilador igual de bien.
    LITERAL_ID_CAST.lastIndex = 0
    expect(LITERAL_ID_CAST.test(`const x = "abc" as unknown as Id<"profiles">`)).toBe(true)
  })

  it('ignores the shape when it is quoted inside a comment', () => {
    const stripped = stripComments(`// no hagas 'x' as Id<'profiles'>\nconst ok = 1`)
    expect(stripped).not.toContain('Id<')
    expect(stripped).toContain('const ok = 1')
  })
})
