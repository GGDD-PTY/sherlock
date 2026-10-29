// ============================================================================
// Parseo e idempotencia de plan de `scripts/convex-local.mjs seed:portfolio`
// ============================================================================
// La función pura se prueba importándola. Los rechazos del comando se corren
// en un subproceso para comprobar que mueren ANTES de hablar con Convex.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/convex-local.mjs')

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

async function load() {
  return (await import(pathToFileURL(SCRIPT).href)) as {
    parseSeedPortfolioArgs: (argv: string[]) => { n: number }
    parseConvexRunJson: (stdout: string) => unknown
    buildPortfolioSeedPlan: (n: number) => Array<{
      name: string
      slug: string
      ownerEmail: string
      profile: 'vacio' | 'completo' | 'desordenado'
      documents: number
    }>
    PORTFOLIO_COMPANY_NAMES: readonly string[]
    slugifyCompanyName: (name: string) => string
  }
}

describe('convex-local.mjs seed:portfolio — parseo', () => {
  it('lee el JSON pretty-printed de convex run', async () => {
    const { parseConvexRunJson } = await load()
    expect(parseConvexRunJson('{\n  "documentsCreated": 0,\n  "created": false\n}\n')).toEqual({
      documentsCreated: 0,
      created: false,
    })
  })

  it('por defecto siembra 10 empresas', async () => {
    const { parseSeedPortfolioArgs } = await load()
    expect(parseSeedPortfolioArgs([])).toEqual({ n: 10 })
  })

  it('honra --n', async () => {
    const { parseSeedPortfolioArgs } = await load()
    expect(parseSeedPortfolioArgs(['--n', '3'])).toEqual({ n: 3 })
  })

  it('rechaza un --n que no es un entero', async () => {
    const { parseSeedPortfolioArgs } = await load()
    expect(() => parseSeedPortfolioArgs(['--n', '10abc'])).toThrow(/--n/)
  })

  it('rechaza un --n mayor a 50', async () => {
    const { parseSeedPortfolioArgs } = await load()
    expect(() => parseSeedPortfolioArgs(['--n', '51'])).toThrow(/50/)
  })

  it('rechaza un --n menor a 1', async () => {
    const { parseSeedPortfolioArgs } = await load()
    expect(() => parseSeedPortfolioArgs(['--n', '0'])).toThrow(/--n/)
  })
})

describe('convex-local.mjs seed:portfolio — plan', () => {
  it('tiene 50 nombres distintos explícitamente sintéticos', async () => {
    const { PORTFOLIO_COMPANY_NAMES, slugifyCompanyName } = await load()
    expect(PORTFOLIO_COMPANY_NAMES).toHaveLength(50)
    expect(new Set(PORTFOLIO_COMPANY_NAMES).size).toBe(50)
    expect(new Set(PORTFOLIO_COMPANY_NAMES.map(slugifyCompanyName)).size).toBe(50)
    expect(PORTFOLIO_COMPANY_NAMES).toEqual(
      expect.arrayContaining([
        'Empresa Sintética 01, S. A.',
        'Empresa Sintética 02, S. A.',
        'Empresa Sintética 03, S. A.',
      ])
    )
  })

  it('rota perfiles y documentos y no duplica dueños', async () => {
    const { buildPortfolioSeedPlan } = await load()
    const plan = buildPortfolioSeedPlan(10)
    expect(plan).toHaveLength(10)
    expect(plan.map((row) => row.profile)).toEqual([
      'vacio',
      'completo',
      'desordenado',
      'vacio',
      'completo',
      'desordenado',
      'vacio',
      'completo',
      'desordenado',
      'vacio',
    ])
    expect(plan.map((row) => row.documents)).toEqual([4, 12, 30, 4, 12, 30, 4, 12, 30, 4])
    expect(plan.map((row) => row.ownerEmail)).toEqual(plan.map((row) => `${row.slug}@dev.local`))
    expect(new Set(plan.map((row) => row.ownerEmail)).size).toBe(10)
    expect(new Set(plan.map((row) => row.name)).size).toBe(10)
  })
})

describe('convex-local.mjs seed:portfolio — rechazos antes de Convex', () => {
  it('rechaza un argumento desconocido', () => {
    const result = run(['seed:portfolio', '--turbo'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/desconocido/)
  })

  it('rechaza --n 51 antes de hablar con Convex', () => {
    const result = run(['seed:portfolio', '--n', '51'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/50/)
  })
})
