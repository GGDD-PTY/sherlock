// ============================================================================
// Parseo de argumentos y tabla por empresa de `scripts/journeys-local.mjs`
// ============================================================================
// El runner de los cinco journeys se parametriza por empresa (`--company`) o
// por portfolio (`--portfolio N`). Aquí se prueba lo que decide antes de
// levantar nada: qué empresas va a medir, con qué dueño, y cómo lee la tabla
// final una corrida donde un journey se cayó.
// ============================================================================

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), '../../scripts/journeys-local.mjs')

type CompanyRun = {
  name: string
  slug: string
  ownerEmail: string
  profile: 'vacio' | 'completo' | 'desordenado'
  documents: number
}

type Options = {
  base: string | null
  port: string
  cloudPort: string
  sitePort: string
  portSet: boolean
  cloudPortSet: boolean
  sitePortSet: boolean
  journeys: string[]
  company: string | null
  portfolio: number | null
  keep: boolean
}

type StepRow = {
  empresa: string
  journey: string
  paso: string
  ms: number
  ok: boolean
}

type RunnerModule = {
  parseArgs: (argv: string[]) => Options
  inheritLiveBackendPorts: (options: Options) => Options
  buildCompanyRuns: (options: Pick<Options, 'company' | 'portfolio'>) => CompanyRun[]
  buildCompanyTable: (
    rows: StepRow[],
    runs: CompanyRun[]
  ) => Array<{
    company: CompanyRun
    cells: string[]
    total: number
    red: string[]
    overGoal: string[]
  }>
}

async function load(): Promise<RunnerModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as RunnerModule
}

describe('journeys-local.mjs — parseo', () => {
  it('sin flags corre los cinco journeys sobre la empresa fija', async () => {
    const { parseArgs } = await load()
    const options = parseArgs([])
    expect(options.journeys).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
    expect(options.company).toBeNull()
    expect(options.portfolio).toBeNull()
    expect(options.base).toBeNull()
    expect(options.keep).toBe(false)
  })

  it('lee --company, --portfolio, --journey, --base y --keep', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--company', 'Empresa Sintética 02, S. A.']).company).toBe(
      'Empresa Sintética 02, S. A.'
    )
    expect(parseArgs(['--portfolio', '10']).portfolio).toBe(10)
    expect(parseArgs(['--journey', 'J2']).journeys).toEqual(['j2'])
    expect(parseArgs(['--base', 'http://localhost:3130/']).base).toBe('http://localhost:3130')
    expect(parseArgs(['--keep']).keep).toBe(true)
  })

  it('--base sin --port toma el puerto de la URL', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--base', 'http://localhost:3130/']).port).toBe('3130')
  })

  it('--port gana al puerto de --base', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--base', 'http://localhost:3130', '--port', '3116']).port).toBe('3116')
    expect(parseArgs(['--port', '3116', '--base', 'http://localhost:3130']).port).toBe('3116')
  })

  it('inheritLiveBackendPorts no pisa un --cloud-port explícito', async () => {
    const { parseArgs, inheritLiveBackendPorts } = await load()
    const resolved = inheritLiveBackendPorts(
      parseArgs(['--base', 'http://localhost:3130', '--cloud-port', '3999', '--site-port', '3998'])
    )
    expect(resolved.cloudPort).toBe('3999')
    expect(resolved.sitePort).toBe('3998')
  })

  it('rechaza --company y --portfolio juntos', async () => {
    const { parseArgs } = await load()
    expect(() => parseArgs(['--company', 'X, S. A.', '--portfolio', '2'])).toThrow(/no van juntos/)
  })

  it('rechaza un --company vacío o sin slug', async () => {
    const { parseArgs } = await load()
    expect(() => parseArgs(['--company', '   '])).toThrow(/--company/)
    expect(() => parseArgs(['--company', '·'])).toThrow(/slug/)
  })

  it('rechaza un --portfolio que no es un entero de 1 a 50', async () => {
    const { parseArgs } = await load()
    expect(() => parseArgs(['--portfolio', '10abc'])).toThrow(/--portfolio/)
    expect(() => parseArgs(['--portfolio', '0'])).toThrow(/--portfolio/)
    expect(() => parseArgs(['--portfolio', '51'])).toThrow(/50/)
  })

  it('rechaza un journey desconocido y un flag desconocido', async () => {
    const { parseArgs } = await load()
    expect(() => parseArgs(['--journey', 'j9'])).toThrow(/desconocido/)
    expect(() => parseArgs(['--turbo'])).toThrow(/desconocido/)
  })
})

describe('journeys-local.mjs — empresas de la corrida', () => {
  it('sin flags mide la empresa fija con su dueño de siempre', async () => {
    const { buildCompanyRuns } = await load()
    expect(buildCompanyRuns({ company: null, portfolio: null })).toEqual([
      {
        name: 'Journeys, S. A.',
        slug: 'journeys-s-a',
        ownerEmail: 'journeys-s-a@dev.local',
        profile: 'completo',
        documents: 1,
      },
    ])
  })

  it('--portfolio 10 trae las diez primeras con dueño propio y perfiles rotados', async () => {
    const { buildCompanyRuns } = await load()
    const runs = buildCompanyRuns({ company: null, portfolio: 10 })
    expect(runs).toHaveLength(10)
    expect(new Set(runs.map((run) => run.ownerEmail)).size).toBe(10)
    expect(runs.map((run) => run.ownerEmail)).toEqual(runs.map((run) => `${run.slug}@dev.local`))
    expect(runs.map((run) => run.profile).slice(0, 3)).toEqual(['vacio', 'completo', 'desordenado'])
  })

  it('--company de una empresa del portfolio usa el perfil del plan', async () => {
    const { buildCompanyRuns } = await load()
    expect(buildCompanyRuns({ company: 'Empresa Sintética 02, S. A.', portfolio: null })).toEqual([
      {
        name: 'Empresa Sintética 02, S. A.',
        slug: 'empresa-sintetica-02-s-a',
        ownerEmail: 'empresa-sintetica-02-s-a@dev.local',
        profile: 'completo',
        documents: 12,
      },
    ])
  })

  it('--company de una empresa nueva la siembra sin documentos', async () => {
    const { buildCompanyRuns } = await load()
    expect(buildCompanyRuns({ company: 'SampleFoods Foods, S. A.', portfolio: null })).toEqual([
      {
        name: 'SampleFoods Foods, S. A.',
        slug: 'samplefoods-foods-s-a',
        ownerEmail: 'samplefoods-foods-s-a@dev.local',
        profile: 'completo',
        documents: 0,
      },
    ])
  })
})

describe('journeys-local.mjs — tabla por empresa', () => {
  const company: CompanyRun = {
    name: 'Agroindustrias del Istmo, S. A.',
    slug: 'agroindustrias-del-istmo-s-a',
    ownerEmail: 'agroindustrias-del-istmo-s-a@dev.local',
    profile: 'vacio',
    documents: 4,
  }

  function total(journey: string, ms: number): StepRow {
    return { empresa: company.name, journey, paso: 'total', ms, ok: true }
  }

  it('da ms del journey verde, rojo del que se cayó y guion del que no corrió', async () => {
    const { buildCompanyTable } = await load()
    const [row] = buildCompanyTable(
      [
        total('J1', 40_000),
        { empresa: company.name, journey: 'J2', paso: 'entrar', ms: 900, ok: false },
        total('J3', 30_000),
      ],
      [company]
    )
    expect(row.cells).toEqual(['40000', 'rojo', '30000', '-', '-'])
    expect(row.red).toEqual(['J2'])
    // El total suma solo lo verde: el journey rojo no tiene tiempo que sumar.
    expect(row.total).toBe(70_000)
  })

  it('marca el journey que pasó su meta sin marcarlo rojo', async () => {
    const { buildCompanyTable } = await load()
    const [row] = buildCompanyTable([total('J1', 95_000)], [company])
    expect(row.red).toEqual([])
    expect(row.overGoal).toEqual(['J1 95000 > 90000'])
  })

  it('separa las filas de dos empresas de la misma corrida', async () => {
    const { buildCompanyTable } = await load()
    const otra: CompanyRun = {
      name: 'Empresa Sintética 02, S. A.',
      slug: 'empresa-sintetica-02-s-a',
      ownerEmail: 'empresa-sintetica-02-s-a@dev.local',
      profile: 'completo',
      documents: 12,
    }
    const table = buildCompanyTable(
      [
        total('J1', 40_000),
        { empresa: otra.name, journey: 'J1', paso: 'total', ms: 50_000, ok: true },
      ],
      [company, otra]
    )
    expect(table.map((row) => row.cells[0])).toEqual(['40000', '50000'])
  })
})
