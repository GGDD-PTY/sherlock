// ============================================================================
// Candados de scripts/operator/purge-company.mjs
// ============================================================================
// El script es el ÚNICO camino de purga y borra salas enteras. Se prueban dos
// cosas: (a) los rechazos que ocurren dentro de `parseArgs`, antes de que
// `resolveDeployment` aparte `.env.local` o hable con Convex, y (b) la
// segunda verificación de la regla de semilla del lado del script, que es la
// que impide que un cambio en la query de Convex convierta una sala real en
// candidata sin que nadie se entere.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/operator/purge-company.mjs')
const EXIT_REFUSED = 2

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
    env: { ...process.env, CONVEX_DEPLOYMENT: '' },
  })
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

async function load() {
  return (await import(pathToFileURL(SCRIPT).href)) as {
    parseArgs: (argv: string[]) => Record<string, unknown>
    assertSweepSelection: (rows: unknown[]) => void
  }
}

describe('purge-company.mjs — rechazos antes de tocar nada', () => {
  it('rechaza un argumento desconocido', () => {
    const result = run(['--turbo'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/desconocido/i)
  })

  it('rechaza un --target que no es dev|prod', () => {
    const result = run(['--seed-sweep', '--target', 'staging'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--target/)
  })

  it('se niega a correr sin decir qué purgar', () => {
    const result = run([])
    expect(result.status).toBe(EXIT_REFUSED)
    // Tres aserciones, no una alternancia: el mensaje tiene que nombrar TODOS
    // los trabajos, y con `|` bastaba con que sobreviviera uno.
    expect(result.stderr).toMatch(/--seed-sweep/)
    expect(result.stderr).toMatch(/--company-id/)
    expect(result.stderr).toMatch(/--purge-user-email/)
  })

  it('exige --confirm-name junto a --company-id', () => {
    const result = run(['--company-id', 'j97d596n'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--confirm-name/)
  })

  it('rechaza mezclar --seed-sweep con --company-id', () => {
    const result = run(['--seed-sweep', '--company-id', 'j97d596n', '--confirm-name', 'X'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/excluyentes/)
  })
})

describe('purge-company.mjs — contrato de banderas', () => {
  it('el dry-run es el default y --execute es explícito', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--seed-sweep']).execute).toBe(false)
    expect(parseArgs(['--seed-sweep', '--dry-run']).execute).toBe(false)
    expect(parseArgs(['--seed-sweep', '--execute']).execute).toBe(true)
    // Un `--dry-run` posterior gana sobre `--execute`: la ambigüedad se
    // resuelve siempre hacia no borrar.
    expect(parseArgs(['--seed-sweep', '--execute', '--dry-run']).execute).toBe(false)
  })

  it('dev es el destino por defecto, nunca prod', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--seed-sweep']).target).toBe('dev')
  })

  it('trae los dos usuarios semilla de PENDING por defecto', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--deactivate-seed-users']).seedUserEmails).toEqual([
      'fixture-ae0b4b41@example.com',
      'admin@dev.local',
    ])
  })

  it('acepta --purge-user-email como único trabajo y no ejecuta por default', async () => {
    const { parseArgs } = await load()
    expect(parseArgs(['--purge-user-email', 'orphan.guest@example.test'])).toMatchObject({
      purgeUserEmails: ['orphan.guest@example.test'],
      execute: false,
      target: 'dev',
    })
  })

  it('deduplica el mismo correo pasado dos veces', async () => {
    const { parseArgs } = await load()
    expect(
      parseArgs([
        '--purge-user-email',
        'orphan.guest@example.test',
        '--purge-user-email',
        'orphan.guest@example.test',
        '--purge-user-email',
        'other.guest@example.test',
      ]).purgeUserEmails
    ).toEqual(['orphan.guest@example.test', 'other.guest@example.test'])
  })
})

describe('purge-company.mjs — segunda verificación de la regla de semilla', () => {
  it('acepta una selección donde toda empresa está marcada selectable y sin bloqueos', async () => {
    const { assertSweepSelection } = await load()
    expect(() =>
      assertSweepSelection([
        { name: 'Global Nike Inc', companyId: 'c1', selectable: true, blockedBy: [] },
      ])
    ).not.toThrow()
  })

  it.each([
    ['no marcada selectable', { selectable: false, blockedBy: [] }],
    ['con un correo bloqueante', { selectable: true, blockedBy: ['fixture-8b8414fc@example.com'] }],
  ])('mata la corrida si una empresa viene %s', async (_, patch) => {
    const { assertSweepSelection } = await load()
    expect(() => assertSweepSelection([{ name: 'SAMPLE_LOGISTICS', companyId: 'c2', ...patch }])).toThrow(
      /no pasan la regla de semilla/
    )
  })
})

// 2026-09-06: `--target prod --execute` purgó Convex prod y WorkOS contestó
// «User not found» porque la clave de `.env.local` es la del ambiente dev.
describe('purge-company.mjs — la clave de WorkOS va por ambiente', () => {
  async function loadWorkos() {
    return (await import(pathToFileURL(SCRIPT).href)) as {
      resolveWorkosApiKey: (
        target: 'dev' | 'prod',
        env?: Record<string, string | undefined>,
        readDevKey?: (name: string) => string | undefined
      ) => { apiKey: string | undefined; variable: string }
      deleteInWorkos: (args: {
        userIds: string[]
        organizationIds: string[]
        apiKey: string | undefined
        variable?: string
        createClient?: (apiKey: string) => Promise<unknown>
        print?: (line: string) => void
      }) => Promise<'DONE' | 'NOTHING' | 'MISSING_KEY'>
      WORKOS_PROD_KEY_VAR: string
    }
  }

  it('prod lee SOLO WORKOS_API_KEY_PROD del entorno, nunca la clave dev', async () => {
    const { resolveWorkosApiKey } = await loadWorkos()
    const readDevKey = vi.fn(() => 'sk_test_dev_key_from_env_local')
    expect(resolveWorkosApiKey('prod', { WORKOS_API_KEY: 'sk_test_dev_key' }, readDevKey)).toEqual({
      apiKey: undefined,
      variable: 'WORKOS_API_KEY_PROD',
    })
    expect(readDevKey).not.toHaveBeenCalled()
    expect(
      resolveWorkosApiKey('prod', { WORKOS_API_KEY_PROD: 'sk_live_prod_key' }, readDevKey)
    ).toEqual({ apiKey: 'sk_live_prod_key', variable: 'WORKOS_API_KEY_PROD' })
  })

  it('dev sigue leyendo WORKOS_API_KEY (entorno o .env.local)', async () => {
    const { resolveWorkosApiKey } = await loadWorkos()
    const readDevKey = vi.fn((name: string) =>
      name === 'WORKOS_API_KEY' ? 'sk_test_dev' : undefined
    )
    expect(resolveWorkosApiKey('dev', {}, readDevKey)).toEqual({
      apiKey: 'sk_test_dev',
      variable: 'WORKOS_API_KEY',
    })
  })

  it('sin la clave prod se salta WorkOS con un mensaje claro y devuelve MISSING_KEY', async () => {
    const { deleteInWorkos } = await loadWorkos()
    const lines: string[] = []
    const createClient = vi.fn()
    const outcome = await deleteInWorkos({
      userIds: ['user_01AAAAAAAAAAAAAAAAAAAAAAAA'],
      organizationIds: [],
      apiKey: undefined,
      variable: 'WORKOS_API_KEY_PROD',
      createClient,
      print: (line) => lines.push(line),
    })
    expect(outcome).toBe('MISSING_KEY')
    expect(createClient).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/falta WORKOS_API_KEY_PROD/)
    expect(lines.join('\n')).toMatch(/ambiente dev de WorkOS/)
  })

  it('lee el usuario e imprime su correo antes de borrarlo', async () => {
    const { deleteInWorkos } = await loadWorkos()
    const lines: string[] = []
    const getUser = vi.fn(async (id: string) => ({ id, email: 'cliente@example.test' }))
    const deleteUser = vi.fn(async () => undefined)
    const outcome = await deleteInWorkos({
      userIds: ['user_01AAAAAAAAAAAAAAAAAAAAAAAA'],
      organizationIds: [],
      apiKey: 'sk_live_prod_key',
      variable: 'WORKOS_API_KEY_PROD',
      createClient: async () => ({ userManagement: { getUser, deleteUser } }),
      print: (line) => lines.push(line),
    })
    expect(outcome).toBe('DONE')
    expect(getUser).toHaveBeenCalledWith('user_01AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(deleteUser).toHaveBeenCalledWith('user_01AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(getUser.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUser.mock.invocationCallOrder[0]!
    )
    expect(lines).toContain(
      'workos: usuario user_01AAAAAAAAAAAAAAAAAAAAAAAA <cliente@example.test> — borrando'
    )
  })

  it('si el usuario no se puede leer, no lo borra', async () => {
    const { deleteInWorkos } = await loadWorkos()
    const lines: string[] = []
    const deleteUser = vi.fn(async () => undefined)
    await deleteInWorkos({
      userIds: ['user_01AAAAAAAAAAAAAAAAAAAAAAAA'],
      organizationIds: [],
      apiKey: 'sk_live_prod_key',
      createClient: async () => ({
        userManagement: {
          getUser: async () => {
            throw new Error('User not found')
          },
          deleteUser,
        },
      }),
      print: (line) => lines.push(line),
    })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/NO SE LEYÓ — User not found; no se borra/)
  })
})

describe('purge-company.mjs — qué llega a WorkOS', () => {
  it.each([
    ['user_01AAAAAAAAAAAAAAAAAAAAAAAA', true],
    ['user_01AAAAAAAAAAAAAAAAAAAAAAAA', true],
    // Ids sintéticos que dev sí tiene en `users.workosUserId` y que WorkOS
    // nunca emitió: mandarlos a `deleteUser` es ruido, no un borrado.
    ['dev_company_001_workos', false],
    ['user_codex_local_1780475693904', false],
    ['', false],
  ])('%s → enviable a deleteUser: %s', async (candidate, expected) => {
    const { looksLikeWorkosUserId } = (await import(pathToFileURL(SCRIPT).href)) as {
      looksLikeWorkosUserId: (value: string) => boolean
    }
    expect(looksLikeWorkosUserId(candidate)).toBe(expected)
  })
})
