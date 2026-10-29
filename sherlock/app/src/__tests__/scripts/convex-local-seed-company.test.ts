// ============================================================================
// Parseo de flags de `scripts/convex-local.mjs seed:company`
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
    parseSeedCompanyArgs: (argv: string[]) => {
      slug: string
      name: string
      documents: number
      profile: 'vacio' | 'completo' | 'desordenado'
      ownerEmail: string
    }
    slugifyCompanyName: (name: string) => string
  }
}

describe('convex-local.mjs seed:company — parseo', () => {
  it('deriva slug, email y defaults desde --name', async () => {
    const { parseSeedCompanyArgs } = await load()
    expect(parseSeedCompanyArgs(['--name', 'SampleFoods Foods'])).toEqual({
      slug: 'samplefoods-foods',
      name: 'SampleFoods Foods',
      documents: 8,
      profile: 'completo',
      ownerEmail: 'samplefoods-foods@dev.local',
    })
  })

  it('honra --docs, --perfil y --email', async () => {
    const { parseSeedCompanyArgs } = await load()
    expect(
      parseSeedCompanyArgs([
        '--name',
        'SampleFoods Foods',
        '--docs',
        '12',
        '--perfil',
        'vacio',
        '--email',
        'ops@dev.local',
      ])
    ).toEqual({
      slug: 'samplefoods-foods',
      name: 'SampleFoods Foods',
      documents: 12,
      profile: 'vacio',
      ownerEmail: 'ops@dev.local',
    })
  })

  it('slugifica acentos y puntuación', async () => {
    const { slugifyCompanyName } = await load()
    expect(slugifyCompanyName('Sintética Uno, S. A.')).toBe('sintetica-uno-s-a')
  })

  it('rechaza un --docs que no es un entero', async () => {
    const { parseSeedCompanyArgs } = await load()
    for (const docs of ['12abc', '1.5']) {
      expect(() => parseSeedCompanyArgs(['--name', 'SampleFoods Foods', '--docs', docs])).toThrow(/--docs/)
    }
  })

  it('acepta --perfil desordenado', async () => {
    const { parseSeedCompanyArgs } = await load()
    expect(
      parseSeedCompanyArgs(['--name', 'Prueba Desorden', '--perfil', 'desordenado', '--docs', '30'])
    ).toEqual({
      slug: 'prueba-desorden',
      name: 'Prueba Desorden',
      documents: 30,
      profile: 'desordenado',
      ownerEmail: 'prueba-desorden@dev.local',
    })
  })

  it('rechaza un --docs mayor a 200', async () => {
    const { parseSeedCompanyArgs } = await load()
    expect(() => parseSeedCompanyArgs(['--name', 'SampleFoods Foods', '--docs', '201'])).toThrow(/200/)
  })
})

describe('convex-local.mjs seed:company — rechazos antes de Convex', () => {
  it('exige --name', () => {
    const result = run(['seed:company'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--name es obligatorio/)
  })

  it('rechaza un --perfil que no es vacio|completo', () => {
    const result = run(['seed:company', '--name', 'SampleFoods Foods', '--perfil', 'lleno'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--perfil/)
  })

  it('rechaza un argumento desconocido', () => {
    const result = run(['seed:company', '--turbo'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/desconocido/)
  })

  it('rechaza --docs 12abc antes de hablar con Convex', () => {
    const result = run(['seed:company', '--name', 'SampleFoods Foods', '--docs', '12abc'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--docs/)
  })

  it('rechaza --docs 201 antes de hablar con Convex', () => {
    const result = run(['seed:company', '--name', 'SampleFoods Foods', '--docs', '201'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/200/)
  })
})
