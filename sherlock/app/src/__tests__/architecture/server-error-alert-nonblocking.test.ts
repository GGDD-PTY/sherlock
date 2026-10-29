// ============================================================================
// CANDADO: la alerta de 5xx nunca se mete en el camino de la respuesta (A7)
// ============================================================================
// El aviso al equipo cuelga de `captureServerException`, que a su vez cuelga de
// `apiError()` y de `onRequestError`. Si alguien lo awaitea, cada 500 se paga
// con un round trip a Convex ANTES de responderle al cliente — y si Convex está
// caído, con el timeout entero. Este test lee el código como TEXTO por esa
// razón: el contrato es la forma del call site, no lo que devuelve.
//
// Lee también la firma: `reportServerErrorToTeam` devuelve `void`, así que
// awaitearla no compila a nada útil y `no-floating-promises` no la marca.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

const SOURCE_ROOT = resolve(process.cwd(), 'src')

function collectSourceFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      collectSourceFiles(fullPath, results)
      continue
    }
    if (entry.name.endsWith('.ts')) results.push(fullPath)
  }
  return results
}

/**
 * Los argumentos de nivel superior de una llamada, en orden. Parte por las
 * comas que NO viven dentro de un string, un template ni unos paréntesis,
 * llaves o corchetes anidados — `{ error: 'a, b' }` es UN argumento.
 */
function topLevelArguments(call: string): string[] {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'))
  const args: string[] = []
  let current = ''
  let depth = 0
  let quote: string | null = null

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]

    if (quote !== null) {
      current += char
      if (char === '\\') {
        current += inner[index + 1] ?? ''
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      if (current.trim()) args.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) args.push(current.trim())
  return args
}

/** El 4º argumento de `apiError`: el contexto, lo único que llega al aviso. */
function alertContextArgument(call: string): string {
  return topLevelArguments(call)[3] ?? ''
}

/** Los call sites de `apiError` con status 5xx literal, con su texto completo. */
function fiveHundredCallSites(source: string): string[] {
  const calls: string[] = []
  for (const match of source.matchAll(/apiError\(/g)) {
    let index = match.index + match[0].length
    let depth = 1
    while (index < source.length && depth > 0) {
      if (source[index] === '(') depth += 1
      else if (source[index] === ')') depth -= 1
      index += 1
    }
    const call = source.slice(match.index, index)
    if (/^apiError\(\s*[^,]+,\s*5\d\d\s*,/.test(call)) calls.push(call)
  }
  return calls
}

const CAPTURE_PATH = 'src/lib/observability/posthog-server-exception.ts'
const ALERT_PATH = 'src/lib/observability/server-error-alert.ts'
const RESPONSE_PATH = 'src/lib/api/response.ts'

// ============================================================================
// CANDADO: un 5xx dice de qué handler salió
// ============================================================================
// `route` es la mitad de la llave de dedupe. Un `apiError(500)` que no la pasa
// avisa como `/unknown|<nombre del error>` y se agrupa con el 5xx de cualquier
// otro handler que comparta nombre: una ventana de 15 minutos esconde de dónde
// vino el incidente, y el segundo handler que se rompe no despierta a nadie.
// El call site es un literal de cada handler a propósito — la request no viaja
// hasta el aviso — así que este candado también se lee como texto.
//
// Se exige en el CUARTO argumento, el contexto: es el único que `apiError` le
// pasa a `captureServerException`. Un `route` en el tercero es cuerpo JSON de la
// respuesta —se lo lleva el cliente y nunca llega al aviso—, así que buscarlo en
// el texto entero de la llamada daba verde a un 5xx que avisa como `/unknown`.
describe('todo apiError 5xx nombra su ruta', () => {
  const offenders = collectSourceFiles(SOURCE_ROOT)
    .flatMap((file) =>
      fiveHundredCallSites(readFileSync(file, 'utf8'))
        .filter((call) => !/\broute\s*[:,}]/.test(alertContextArgument(call)))
        .map(() => relative(process.cwd(), file))
    )
    .sort()

  it('no deja ningún 5xx avisando como /unknown', () => {
    expect(offenders).toEqual([])
  })
})

describe('la alerta de 5xx no bloquea el camino de la respuesta', () => {
  it('el camino de captura llama a reportServerErrorToTeam sin await ni void de promesa', () => {
    const source = read(CAPTURE_PATH)

    expect(source).toMatch(/^\s*reportServerErrorToTeam\(\{/m)
    expect(source).not.toMatch(/await\s+reportServerErrorToTeam\s*\(/)
    expect(source).not.toMatch(/return\s+reportServerErrorToTeam\s*\(/)
    expect(source).not.toMatch(/reportServerErrorToTeam\s*\([\s\S]*?\)\s*\.then\s*\(/)
  })

  it('reportServerErrorToTeam devuelve void y no es async', () => {
    const source = read(ALERT_PATH)

    expect(source).toMatch(
      /export function reportServerErrorToTeam\(input: ServerErrorAlertInput\): void \{/
    )
    expect(source).not.toMatch(/export async function reportServerErrorToTeam/)
  })

  it('la entrega a Convex sólo corre agendada después de la respuesta', () => {
    const source = read(ALERT_PATH)

    // El único call site de la entrega es el que pasa por `scheduleAfterResponse`.
    const callSites = [...source.matchAll(/deliverServerErrorAlert\(/g)]
    expect(callSites).toHaveLength(2) // la definición y la tarea agendada
    expect(source).toMatch(/scheduleAfterResponse\(\(\) => deliverServerErrorAlert\(payload\)\)/)
    expect(source).toMatch(/function scheduleAfterResponse\(task: \(\) => Promise<unknown>\): void/)
    expect(source).toMatch(/\bafter\(task\)/)
  })

  it('apiError sigue reportando el 5xx sin await, como antes', () => {
    const source = read(RESPONSE_PATH)

    expect(source).toMatch(/void captureServerException\(/)
    expect(source).not.toMatch(/await captureServerException\(/)
  })

  it('el módulo de la alerta no importa el cliente de Convex de forma estática', () => {
    const source = read(ALERT_PATH)

    // Import estático metería `convex/browser` y la api generada en el grafo de
    // TODA ruta de API, que es lo que este módulo evita a propósito.
    expect(source).not.toMatch(/^import .*from '@\/lib\/convex\/admin-client'/m)
    expect(source).not.toMatch(/^import .*from '@\/\.\.\/convex\/_generated\/api'/m)
    expect(source).toMatch(/await Promise\.all\(\[\s*import\('@\/lib\/convex\/admin-client'\)/)
  })
})
