import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

// El 2026-08-28 el boton de voto del roadmap se anunciaba a los lectores de
// pantalla como "roadmap.board.voteAria" — la RUTA DE LA CLAVE, no el texto.
// La causa: `t('board.voteAria')` sobre el mensaje "Votar por {title}" sin pasar
// values. Un comentario en el codigo afirmaba que next-intl "deja el placeholder
// intacto"; no lo hace. Corre el mensaje por ICU, lanza FORMATTING_ERROR y
// devuelve la ruta de la clave como fallback visible.
//
// El test unitario del componente no lo cazo porque su mock pasaba el label ya
// resuelto, asi que la interpolacion real nunca se ejercio. Esta guarda mira el
// codigo fuente, que es donde vive el defecto, y no el render mockeado.

const APP = join(__dirname, '../../..')
const SRC = join(APP, 'src')
const MESSAGES = join(SRC, 'messages')

type Flat = Record<string, string>

function flatten(node: unknown, prefix: string, out: Flat): Flat {
  if (typeof node === 'string') {
    out[prefix] = node
    return out
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

function loadMessages(locale: string): Flat {
  return flatten(JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf-8')), '', {})
}

function countBraces(value: string): number {
  let depth = 0
  for (const char of value) {
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth < 0) return depth
  }
  return depth
}

// Los argumentos de un bloque ICU (`{count, plural, ...}`) no son un placeholder
// simple: se declaran dentro del propio bloque. Se recortan antes de buscar.
const ICU_BLOCK = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)[\s\S]*?\}\s*\}/g
const SIMPLE_PLACEHOLDER = /\{\s*(\w+)\s*\}/g

function simplePlaceholders(message: string): string[] {
  const body = message.replace(ICU_BLOCK, ' ')
  return [...new Set([...body.matchAll(SIMPLE_PLACEHOLDER)].map((m) => m[1]))].sort()
}

// Un `t('clave')` citado DENTRO de un comentario no es una llamada. Este mismo
// archivo y el de la pagina del roadmap citan la forma rota para explicarla.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + ' '.repeat(line.length - lead.length))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// const t = useTranslations('ns')  |  const t = await getTranslations({ namespace: 'ns' })
const BIND_HOOK = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?useTranslations\(\s*['"]([^'"]+)['"]/g
const BIND_SERVER =
  /(?:const|let)\s+(\w+)\s*=\s*await\s+getTranslations\(\s*\{[^}]*namespace:\s*['"]([^'"]+)['"]/g
// Una llamada con UN SOLO argumento string y nada mas: `t('a.b')`, `t.rich('a.b')`.
const SINGLE_ARG = /\b(\w+)(?:\.rich|\.markup)?\(\s*(['"])([^'"]+)\2\s*\)/g

type Offence = { file: string; line: number; key: string; missing: string[]; message: string }

function findOffences(): Offence[] {
  const es = loadMessages('es')
  const withPlaceholders = new Map<string, string[]>()
  for (const [key, message] of Object.entries(es)) {
    const placeholders = simplePlaceholders(message)
    if (placeholders.length > 0) withPlaceholders.set(key, placeholders)
  }

  const offences: Offence[] = []
  for (const file of walk(SRC)) {
    const raw = readFileSync(file, 'utf-8')
    const source = stripComments(raw)

    const namespaces = new Map<string, string>()
    for (const pattern of [BIND_HOOK, BIND_SERVER]) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) namespaces.set(match[1], match[2])
    }
    if (namespaces.size === 0) continue

    SINGLE_ARG.lastIndex = 0
    for (const match of source.matchAll(SINGLE_ARG)) {
      const namespace = namespaces.get(match[1])
      if (namespace === undefined) continue
      const key = `${namespace}.${match[3]}`
      const missing = withPlaceholders.get(key)
      if (!missing) continue
      offences.push({
        file: relative(APP, file),
        line: source.slice(0, match.index).split('\n').length,
        key,
        missing,
        message: es[key],
      })
    }
  }
  return offences
}

describe('i18n placeholder values contract', () => {
  it('never calls t() without values on a message that carries a placeholder', () => {
    const offences = findOffences()
    const report = offences
      .map((o) => `${o.file}:${o.line}  ${o.key}  falta ${o.missing.join(', ')}  → "${o.message}"`)
      .join('\n')

    expect(report).toBe('')
  })

  // El escaner solo sirve si de verdad reconoce la forma rota. Sin esta prueba,
  // un cambio que rompiera el regex dejaria el contrato en verde para siempre.
  it('recognises the broken form, so a green result means something', () => {
    const es = loadMessages('es')
    expect(simplePlaceholders(es['roadmap.board.voteAria'])).toEqual(['title'])
    expect(simplePlaceholders('sin placeholder')).toEqual([])
    // Un bloque ICU declara su propio argumento: no cuenta como placeholder simple.
    expect(simplePlaceholders('{count, plural, one {# voto} other {# votos}}')).toEqual([])
  })

  it('ignores a broken call quoted inside a comment', () => {
    const stripped = stripComments(`// nunca hagas t('roadmap.board.voteAria')\nconst x = 1`)
    expect(stripped).not.toContain('voteAria')
    expect(stripped).toContain('const x = 1')
  })

  // Este caso comparaba `es` contra `en`. [F] 2026-09-03 borró el segundo
  // catálogo, así que la deriva que queda por atrapar es interna: un placeholder
  // ICU mal cerrado o un `{}` vacío que el runtime resuelve a la clave cruda.
  it('keeps every placeholder in the Spanish catalog well formed', () => {
    const es = loadMessages('es')

    expect(Object.keys(es).length).toBeGreaterThan(0)

    const malformed = Object.entries(es)
      .filter(([, value]) => /\{\s*\}/.test(value) || countBraces(value) !== 0)
      .map(([key, value]) => `${key}: ${value}`)

    expect(malformed).toEqual([])
  })
})
