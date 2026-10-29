// ============================================================================
// Resolución de `--deployment local` (scripts/operator/convex-deployment.mjs)
// ============================================================================
// El carril local no adivina destino ni lee `.env.local`: o hay un
// `config.json` del backend anónimo en el sandbox del worktree, o el script
// sale 2 pidiendo `bun run dev:local`. Estos tests escriben (o no) ese archivo
// en un APP_ROOT temporal, el mismo patrón que `vdr-push-deliverable.test.ts`.
// ============================================================================

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const OPERATOR_DIR = resolve(process.cwd(), 'scripts/operator')
const DEPLOYMENT = resolve(OPERATOR_DIR, 'convex-deployment.mjs')
const EXIT_REFUSED = 2
const MISSING_LOCAL = 'No hay backend local: levanta `bun run dev:local` primero.'

const temps: string[] = []
const servers: net.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done())
        })
    )
  )
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function listenLocal() {
  const server = net.createServer()
  servers.push(server)
  await new Promise<void>((ready, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ready())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('sin puerto')
  }
  return { server, port: address.port }
}

async function closedLocalPort() {
  const { server, port } = await listenLocal()
  await new Promise<void>((done) => {
    server.close(() => done())
  })
  const index = servers.indexOf(server)
  if (index !== -1) servers.splice(index, 1)
  return port
}

function tempAppRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sherlock-o3-04-'))
  temps.push(root)
  return root
}

function writeLocalConfig(
  appRoot: string,
  config: {
    ports?: { cloud?: number; site?: number }
    adminKey?: string
    deploymentName?: string
  }
) {
  const dir = join(appRoot, '.convex-local', '.convex', 'local', 'default')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'config.json')
  writeFileSync(path, `${JSON.stringify(config)}\n`)
  return path
}

async function load() {
  return (await import(pathToFileURL(DEPLOYMENT).href)) as {
    EXIT_REFUSED: number
    OperatorCliError: new (message: string, code?: number) => Error & { code: number }
    resolveDeployment: (input: { deployment: string; appRoot?: string }) =>
      | Promise<{
          deployment: string
          env: NodeJS.ProcessEnv
          isProd: boolean
          isLocal?: boolean
          url?: string
          adminKey?: string
        }>
      | {
          deployment: string
          env: NodeJS.ProcessEnv
          isProd: boolean
          isLocal?: boolean
          url?: string
          adminKey?: string
        }
  }
}

function copyOperatorScripts(appRoot: string) {
  const operator = join(appRoot, 'scripts', 'operator')
  mkdirSync(operator, { recursive: true })
  for (const file of ['convex-deployment.mjs', 'vdr-pull.mjs', 'vdr-push.mjs']) {
    copyFileSync(join(OPERATOR_DIR, file), join(operator, file))
  }
  return operator
}

describe('resolveDeployment --deployment local', () => {
  it('lee ports.cloud y adminKey del config.json del sandbox', async () => {
    const { resolveDeployment } = await load()
    const { port } = await listenLocal()
    const appRoot = tempAppRoot()
    writeLocalConfig(appRoot, {
      ports: { cloud: port, site: 3271 },
      adminKey: 'anonymous-agent|test-admin-key',
      deploymentName: 'anonymous:anonymous-agent',
    })
    writeFileSync(join(appRoot, '.env.local'), 'CONVEX_DEPLOY_KEY=prod:brainy-emu-822|leak\n')

    const previousKey = process.env.CONVEX_DEPLOY_KEY
    process.env.CONVEX_DEPLOY_KEY = 'prod:brainy-emu-822|exported'
    try {
      const target = await resolveDeployment({ deployment: 'local', appRoot })
      expect(target.isLocal).toBe(true)
      expect(target.isProd).toBe(false)
      expect(target.url).toBe(`http://127.0.0.1:${port}`)
      expect(target.adminKey).toBe('anonymous-agent|test-admin-key')
      expect(target.deployment).toBe('anonymous:anonymous-agent')
      expect(target.env.CONVEX_DEPLOY_KEY).toBeUndefined()
      expect(existsSync(join(appRoot, '.env.local'))).toBe(true)
      expect(existsSync(join(appRoot, '.env.local.operator-bak'))).toBe(false)
    } finally {
      if (previousKey === undefined) delete process.env.CONVEX_DEPLOY_KEY
      else process.env.CONVEX_DEPLOY_KEY = previousKey
    }
  })

  it('sin config.json sale 2 pidiendo dev:local', async () => {
    const { resolveDeployment, OperatorCliError, EXIT_REFUSED: refused } = await load()
    const appRoot = tempAppRoot()
    writeFileSync(join(appRoot, '.env.local'), 'CONVEX_DEPLOYMENT=dev:kindly-mole-736\n')
    writeFileSync(join(appRoot, '.env.local.operator-bak'), 'CONVEX_DEPLOYMENT=dev:otro-mole-999\n')

    await expect(resolveDeployment({ deployment: 'local', appRoot })).rejects.toBeInstanceOf(
      OperatorCliError
    )
    try {
      await resolveDeployment({ deployment: 'local', appRoot })
    } catch (error) {
      const refusedError = error as Error & { code: number }
      expect(refusedError.message).toBe(MISSING_LOCAL)
      expect(refusedError.code).toBe(refused)
      expect(refusedError.code).toBe(EXIT_REFUSED)
    }

    // Un stash que difiere del .env.local vigente mataría el carril dev. El
    // carril local no lo toca: no hay backend, y el archivo sigue donde estaba.
    expect(existsSync(join(appRoot, '.env.local'))).toBe(true)
    expect(existsSync(join(appRoot, '.env.local.operator-bak'))).toBe(true)
  })

  it('un config.json sin adminKey o sin ports.cloud se rechaza', async () => {
    const { resolveDeployment, OperatorCliError } = await load()
    const appRoot = tempAppRoot()
    writeLocalConfig(appRoot, { ports: { cloud: 3270 }, adminKey: '' })

    await expect(resolveDeployment({ deployment: 'local', appRoot })).rejects.toBeInstanceOf(
      OperatorCliError
    )
    await expect(resolveDeployment({ deployment: 'local', appRoot })).rejects.toThrow(/adminKey/)
  })

  it('un config.json de un backend apagado sale 2 pidiendo levantar dev:local', async () => {
    const { resolveDeployment, OperatorCliError, EXIT_REFUSED: refused } = await load()
    const port = await closedLocalPort()
    const appRoot = tempAppRoot()
    writeLocalConfig(appRoot, {
      ports: { cloud: port, site: 3271 },
      adminKey: 'anonymous-agent|test-admin-key',
    })

    try {
      await resolveDeployment({ deployment: 'local', appRoot })
      throw new Error('tenía que rechazar un puerto cerrado')
    } catch (error) {
      const refusedError = error as Error & { code: number }
      expect(error).toBeInstanceOf(OperatorCliError)
      expect(refusedError.message).toBe(
        `No hay backend local escuchando en 127.0.0.1:${port}: levanta \`bun run dev:local\` primero.`
      )
      expect(refusedError.code).toBe(refused)
    }
  })

  it('un ports.cloud fuera de 1-65535 se rechaza antes de conectar', async () => {
    const { resolveDeployment, OperatorCliError } = await load()
    const appRoot = tempAppRoot()
    writeLocalConfig(appRoot, {
      ports: { cloud: 65536, site: 3271 },
      adminKey: 'anonymous-agent|test-admin-key',
    })

    await expect(resolveDeployment({ deployment: 'local', appRoot })).rejects.toBeInstanceOf(
      OperatorCliError
    )
    await expect(resolveDeployment({ deployment: 'local', appRoot })).rejects.toThrow(
      /ports\.cloud=65536 no es un puerto TCP válido \(entero 1-65535\)/
    )
  })
})

describe('vdr-pull/vdr-push --deployment local sin backend', () => {
  it('vdr-pull sale 2 con el mensaje de backend ausente', () => {
    const appRoot = tempAppRoot()
    const operator = copyOperatorScripts(appRoot)
    const result = spawnSync(
      process.execPath,
      [realpathSync(join(operator, 'vdr-pull.mjs')), '--company', 'x', '--deployment', 'local'],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: { ...process.env, CONVEX_DEPLOY_KEY: 'prod:brainy-emu-822|exported' },
      }
    )
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain(MISSING_LOCAL)
  })

  it('vdr-push acepta --version, omite --folder y sale 2 sin config.json', () => {
    const appRoot = tempAppRoot()
    const operator = copyOperatorScripts(appRoot)
    const filePath = join(appRoot, 'modelo.xlsx')
    writeFileSync(filePath, 'PK')
    const result = spawnSync(
      process.execPath,
      [
        realpathSync(join(operator, 'vdr-push.mjs')),
        '--company',
        'Sintética Uno, S. A.',
        '--deployment',
        'local',
        '--file',
        filePath,
        '--version',
        'v1',
        '--note',
        'prueba local',
      ],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: { ...process.env, CONVEX_DEPLOY_KEY: 'prod:brainy-emu-822|exported' },
      }
    )
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain(MISSING_LOCAL)
    expect(result.stderr).not.toMatch(/desconocido/)
    expect(result.stderr).not.toMatch(/falta --folder/)
  })
})
