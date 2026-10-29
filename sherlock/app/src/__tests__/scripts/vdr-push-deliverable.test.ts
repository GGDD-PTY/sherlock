// ============================================================================
// vdr-push.mjs contra un deployment falso
// ============================================================================
// `vdr-loop-scripts.test.ts` cubre los rechazos de `parseArgs`, que mueren antes
// de la red. Acá empieza donde aquél termina: el script corre COMPLETO — resolver
// empresa, sondear, subir bytes, publicar — contra un `bunx` falso y un Convex
// Storage falso.
//
// El script y su módulo de deployment se copian a un APP_ROOT temporal en vez
// de correrse en el árbol: `convex-deployment.mjs` lee `<APP_ROOT>/.env.local`,
// y el candado del carril dev es justo lo que ese archivo dice. Correrlo sobre
// el `.env.local` real haría que la prueba dependiera de la máquina.
//
// Lo que fija:
//  - un push cuya firma no se pudo verificar NO se anuncia como versión nueva:
//    grita, y sale con código distinto de 0;
//  - `--folder` que difiere del documento vivo se advierte, no se aplica;
//  - el nombre de la empresa se imprime ANTES de escribir, y sin `--yes` un
//    `--company` que no es el nombre exacto aborta sin tocar nada;
//  - el carril dev no le pasa `CONVEX_DEPLOY_KEY` al hijo y rechaza un
//    `.env.local` con deploy key de prod;
//  - si la mutation de publicación contesta ALREADY_CURRENT después de subir
//    (el sha entró como vigente entre el sondeo y la subida), `--slot` sella
//    igual que si el sondeo lo hubiera dicho, y el log dice «tras subir bytes»
//    en vez de «sin subir bytes».
// ============================================================================

import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const OPERATOR_DIR = resolve(process.cwd(), 'scripts/operator')
const EXIT_REFUSED = 2

let uploadServer: Server
let uploadUrl: string

beforeAll(async () => {
  uploadServer = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ storageId: 'kg_fake_1' }))
    })
  })
  await new Promise<void>((ready) => uploadServer.listen(0, '127.0.0.1', ready))
  const address = uploadServer.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  uploadUrl = `http://127.0.0.1:${address.port}/upload`
})

afterAll(async () => {
  await new Promise<void>((done) => uploadServer.close(() => done()))
})

type Backend = {
  convexEnv: string
  matches: Array<{ companyId: string; name: string; legalName: string | null }>
  inspect: Record<string, unknown>
  publish: Record<string, unknown>
  seal: Record<string, unknown>
}

type Call = { fn: string; args: Record<string, unknown> }

function makeWorkspace(backend: Partial<Backend> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sherlock-vdr-push-'))
  const operator = join(root, 'scripts', 'operator')
  const binDir = join(root, 'bin')
  mkdirSync(operator, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  for (const file of ['vdr-push.mjs', 'convex-deployment.mjs']) {
    copyFileSync(join(OPERATOR_DIR, file), join(operator, file))
  }

  const backendPath = join(root, 'backend.json')
  writeFileSync(
    backendPath,
    JSON.stringify({
      convexEnv: 'dev',
      matches: [{ companyId: 'company_1', name: 'Sample Hydro', legalName: null }],
      inspect: {
        status: 'NEW_VERSION',
        companyName: 'Sample Hydro',
        documentId: 'doc_1',
        folder: 'room_financial',
        versionNumber: 1,
      },
      publish: {
        kind: 'NEW_VERSION',
        documentId: 'doc_1',
        versionId: 'ver_2',
        versionNumber: 2,
        signatureVerified: true,
        folder: 'room_financial',
        folderIgnored: false,
      },
      seal: {
        delivered: true,
        kind: 'MODEL',
        from: 'REQUESTED',
        status: 'DELIVERED',
        noteApplied: true,
        versionId: 'ver_2',
        versionNumber: 2,
      },
      ...backend,
    })
  )

  const logPath = join(root, 'calls.log')
  writeFileSync(logPath, '')
  const envPath = join(root, '.env.local')

  // `bunx` falso: responde `convex env get` y las funciones de
  // operatorDeliverables que el script usa, y deja cada invocación (con el env
  // que la CLI real habría leído) en un log que el test inspecciona.
  const fakeBunx = join(binDir, 'bunx')
  writeFileSync(
    fakeBunx,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync, readFileSync } = require('node:fs')",
      'const argv = process.argv.slice(2)',
      "const backend = JSON.parse(readFileSync(process.env.PUSH_TEST_BACKEND, 'utf8'))",
      "if (argv[0] !== 'convex') process.exit(64)",
      "if (argv[1] === 'env' && argv[2] === 'get') {",
      '  appendFileSync(',
      '    process.env.PUSH_TEST_LOG,',
      "    JSON.stringify({ fn: 'env:get', args: { name: argv[3], deployKey: process.env.CONVEX_DEPLOY_KEY ?? null, deployment: process.env.CONVEX_DEPLOYMENT ?? null } }) + '\\n'",
      '  )',
      '  process.stdout.write(backend.convexEnv)',
      '  process.exit(0)',
      '}',
      "if (argv[1] !== 'run') process.exit(64)",
      'const fn = argv[2]',
      "const args = JSON.parse(argv[3] || '{}')",
      'appendFileSync(',
      '  process.env.PUSH_TEST_LOG,',
      "  JSON.stringify({ fn, args, deployKey: process.env.CONVEX_DEPLOY_KEY ?? null }) + '\\n'",
      ')',
      "if (fn === 'operatorDeliverables:resolveCompany') {",
      '  process.stdout.write(JSON.stringify({ matches: backend.matches }))',
      '  process.exit(0)',
      '}',
      "if (fn === 'operatorDeliverables:inspectDeliverableTarget') {",
      '  process.stdout.write(JSON.stringify(backend.inspect))',
      '  process.exit(0)',
      '}',
      "if (fn === 'operatorDeliverables:createDeliverableUploadUrl') {",
      '  process.stdout.write(JSON.stringify(process.env.PUSH_TEST_UPLOAD_URL))',
      '  process.exit(0)',
      '}',
      "if (fn === 'operatorDeliverables:publishDeliverable') {",
      '  process.stdout.write(JSON.stringify(backend.publish))',
      '  process.exit(0)',
      '}',
      "if (fn === 'operatorDeliverables:sealCurrentVersion') {",
      '  process.stdout.write(JSON.stringify(backend.seal))',
      '  process.exit(0)',
      '}',
      'process.exit(65)',
    ].join('\n')
  )
  chmodSync(fakeBunx, 0o755)

  const filePath = join(root, 'modelo.xlsx')
  writeFileSync(filePath, Buffer.from('PKlibro-falso'))
  writeFileSync(envPath, 'CONVEX_DEPLOYMENT=dev:kindly-mole-736 # team: sherlock\n')

  return { root, binDir, backendPath, logPath, envPath, filePath, operator }
}

type Workspace = ReturnType<typeof makeWorkspace>

async function runPush(
  workspace: Workspace,
  args: string[],
  env: Record<string, string | undefined> = {}
) {
  writeFileSync(workspace.logPath, '')
  const child = spawn(process.execPath, [join(workspace.operator, 'vdr-push.mjs'), ...args], {
    cwd: workspace.root,
    env: {
      ...process.env,
      PATH: `${workspace.binDir}:${process.env.PATH ?? ''}`,
      CONVEX_DEPLOYMENT: 'dev:kindly-mole-736',
      CONVEX_DEPLOY_KEY: undefined,
      PUSH_TEST_BACKEND: workspace.backendPath,
      PUSH_TEST_LOG: workspace.logPath,
      PUSH_TEST_UPLOAD_URL: uploadUrl,
      ...env,
    } as NodeJS.ProcessEnv,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const status = await new Promise<number>((done) => {
    child.on('close', (code) => done(code ?? -1))
  })
  const calls = readFileSync(workspace.logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call & { deployKey?: string | null })
  return { status, stdout, stderr, calls }
}

function pushArgs(workspace: Workspace, extra: string[] = []) {
  return [
    '--company',
    'Sample Hydro',
    '--file',
    workspace.filePath,
    '--folder',
    'room_financial',
    '--name',
    'Modelo financiero',
    ...extra,
  ]
}

describe('vdr-push: firma no verificada', () => {
  it('no anuncia versión nueva, grita y sale con código distinto de 0', async () => {
    const workspace = makeWorkspace({
      publish: {
        kind: 'NEW_VERSION',
        documentId: 'doc_1',
        versionId: 'ver_2',
        versionNumber: 2,
        signatureVerified: false,
        folder: 'room_financial',
        folderIgnored: false,
      },
    })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/cuarentena/i)
    expect(result.stdout).not.toMatch(/versión nueva v2/i)
  })

  it('una firma verificada sigue reportando la versión nueva y sale 0', async () => {
    const workspace = makeWorkspace()

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/versión nueva v2/i)
  })
})

describe('vdr-push: --slot mueve el rail del cliente', () => {
  it('pasa el slot a la mutation e imprime el estado de antes y el de después', async () => {
    const workspace = makeWorkspace({
      publish: {
        kind: 'NEW_VERSION',
        documentId: 'doc_1',
        versionId: 'ver_2',
        versionNumber: 2,
        signatureVerified: true,
        folder: 'room_financial',
        folderIgnored: false,
        slot: {
          deliverableId: 'deliverable_1',
          kind: 'MODEL',
          from: 'REQUESTED',
          to: 'DELIVERED',
        },
      },
    })

    const result = await runPush(workspace, pushArgs(workspace, ['--slot', 'MODEL']))

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/MODEL: REQUESTED → DELIVERED \(v2\)/)
    const publish = result.calls.find(
      (call) => call.fn === 'operatorDeliverables:publishDeliverable'
    )
    expect(publish?.args).toMatchObject({ slot: 'MODEL' })
  })

  // El mismo sha con `--slot` es el reintento que repara una entrega cuyo push
  // salió sin `--slot`: no sube bytes, pero SÍ mueve el rail sobre la versión
  // vigente vía `sealCurrentVersion`.
  const alreadyCurrent = {
    status: 'ALREADY_CURRENT',
    companyName: 'Sample Hydro',
    documentId: 'doc_1',
    versionNumber: 2,
  }

  it('con el sha vigente y --slot sella el slot sin subir bytes', async () => {
    const workspace = makeWorkspace({ inspect: alreadyCurrent })

    const result = await runPush(
      workspace,
      pushArgs(workspace, ['--slot', 'MODEL', '--note', 'Modelo v1 listo.'])
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(
      /MODEL: REQUESTED → DELIVERED \(v2, versión vigente, sin subir bytes\)/
    )
    expect(result.calls.map((call) => call.fn)).toEqual([
      'env:get',
      'operatorDeliverables:resolveCompany',
      'operatorDeliverables:inspectDeliverableTarget',
      'operatorDeliverables:sealCurrentVersion',
    ])
    const seal = result.calls.find((call) => call.fn === 'operatorDeliverables:sealCurrentVersion')
    expect(seal?.args).toEqual({
      companyId: 'company_1',
      documentId: 'doc_1',
      slot: 'MODEL',
      note: 'Modelo v1 listo.',
    })
  })

  it('con el sha vigente y --slot exige --note antes de tocar el slot', async () => {
    const workspace = makeWorkspace({ inspect: alreadyCurrent })

    const result = await runPush(workspace, pushArgs(workspace, ['--slot', 'MODEL']))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/exige --note/)
    expect(result.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:sealCurrentVersion'
    )
  })

  // La carrera: el sondeo dijo NEW_VERSION, los bytes subieron, y la mutation
  // contestó ALREADY_CURRENT porque el sha entró como vigente en el medio. Antes
  // el script se quedaba en «NO se movió» y hacía falta un segundo push. Y esa
  // vez los bytes SÍ viajaron: el log no puede decir «sin subir bytes».
  it('si la mutation contesta ALREADY_CURRENT después de subir, sella el slot igual', async () => {
    const workspace = makeWorkspace({
      publish: {
        kind: 'ALREADY_CURRENT',
        documentId: 'doc_1',
        versionId: 'ver_2',
        versionNumber: 2,
      },
    })

    const result = await runPush(
      workspace,
      pushArgs(workspace, ['--slot', 'MODEL', '--note', 'Modelo v1 listo.'])
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(
      /MODEL: REQUESTED → DELIVERED \(v2, versión vigente, tras subir bytes\)/
    )
    expect(result.stdout).not.toMatch(/sin subir bytes/)
    expect(result.stderr).not.toMatch(/NO se movió/)
    expect(result.calls.map((call) => call.fn)).toEqual([
      'env:get',
      'operatorDeliverables:resolveCompany',
      'operatorDeliverables:inspectDeliverableTarget',
      'operatorDeliverables:createDeliverableUploadUrl',
      'operatorDeliverables:publishDeliverable',
      'operatorDeliverables:sealCurrentVersion',
    ])
    const seal = result.calls.find((call) => call.fn === 'operatorDeliverables:sealCurrentVersion')
    expect(seal?.args).toEqual({
      companyId: 'company_1',
      documentId: 'doc_1',
      slot: 'MODEL',
      note: 'Modelo v1 listo.',
    })
  })

  it('dice cuando el slot ya estaba entregado con esta versión', async () => {
    const workspace = makeWorkspace({
      inspect: alreadyCurrent,
      seal: { delivered: false, kind: 'MODEL', status: 'DELIVERED', versionNumber: 2 },
    })

    const result = await runPush(
      workspace,
      pushArgs(workspace, ['--slot', 'MODEL', '--note', 'Modelo v1 listo.'])
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/slot MODEL ya estaba entregado con esta versión/)
  })

  it('con el sha vigente y sin --slot no toca el slot', async () => {
    const workspace = makeWorkspace({ inspect: alreadyCurrent })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/No se sube nada/)
    expect(result.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:sealCurrentVersion'
    )
    expect(result.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:publishDeliverable'
    )
  })
})

describe('vdr-push: la carpeta pedida no mueve un documento vivo', () => {
  it('advierte cuando el deployment ignoró --folder', async () => {
    const workspace = makeWorkspace({
      publish: {
        kind: 'NEW_VERSION',
        documentId: 'doc_1',
        versionId: 'ver_2',
        versionNumber: 2,
        signatureVerified: true,
        folder: 'room_financial',
        folderIgnored: true,
      },
    })

    const result = await runPush(workspace, pushArgs(workspace, ['--folder', 'room_legal']))

    expect(result.status).toBe(0)
    expect(result.stderr).toMatch(/room_legal/)
    expect(result.stderr).toMatch(/room_financial/)
    expect(result.stdout).toMatch(/room_financial/)
  })
})

describe('vdr-push: la empresa se nombra antes de escribir', () => {
  it('resuelve --company por nombre e imprime la empresa antes del primer write', async () => {
    const workspace = makeWorkspace()

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(0)
    // El nombre sale ANTES de la línea de éxito, que es la que prueba que ya se
    // escribió: leerlo después no le sirve de nada al operador.
    const namedAt = result.stdout.indexOf('Sample Hydro')
    const wroteAt = result.stdout.indexOf('documento doc_1')
    expect(namedAt).toBeGreaterThanOrEqual(0)
    expect(wroteAt).toBeGreaterThan(namedAt)
    expect(result.calls.map((call) => call.fn)).toEqual([
      'env:get',
      'operatorDeliverables:resolveCompany',
      'operatorDeliverables:inspectDeliverableTarget',
      'operatorDeliverables:createDeliverableUploadUrl',
      'operatorDeliverables:publishDeliverable',
    ])
  })

  it('un --company que no es el nombre exacto aborta sin escribir, salvo --yes', async () => {
    const workspace = makeWorkspace()

    const refused = await runPush(workspace, [
      '--company',
      'company_1',
      '--file',
      workspace.filePath,
      '--folder',
      'room_financial',
    ])

    expect(refused.status).toBe(EXIT_REFUSED)
    expect(refused.stderr).toMatch(/Sample Hydro/)
    expect(refused.stderr).toMatch(/--yes/)
    expect(refused.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:publishDeliverable'
    )

    const accepted = await runPush(workspace, [
      '--company',
      'company_1',
      '--file',
      workspace.filePath,
      '--folder',
      'room_financial',
      '--yes',
    ])
    expect(accepted.status).toBe(0)
  })

  it('si el deployment nombra otra empresa para ese id, no escribe', async () => {
    const workspace = makeWorkspace({
      inspect: {
        status: 'NEW_VERSION',
        companyName: 'Andina Capital',
        documentId: 'doc_1',
        versionNumber: 1,
      },
    })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/Andina Capital/)
    expect(result.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:createDeliverableUploadUrl'
    )
  })

  it('sin coincidencias no sube nada', async () => {
    const workspace = makeWorkspace({ matches: [] })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.calls.map((call) => call.fn)).not.toContain(
      'operatorDeliverables:createDeliverableUploadUrl'
    )
  })

  it('con dos empresas homónimas lista las dos y no escoge', async () => {
    const workspace = makeWorkspace({
      matches: [
        { companyId: 'company_1', name: 'Sample Hydro', legalName: null },
        { companyId: 'company_2', name: 'Sample Hydro', legalName: null },
      ],
    })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toContain('company_1')
    expect(result.stderr).toContain('company_2')
  })
})

describe('vdr-push: el carril dev no puede terminar en prod', () => {
  it('no le pasa CONVEX_DEPLOY_KEY al hijo aunque esté exportado', async () => {
    const workspace = makeWorkspace()

    const result = await runPush(workspace, pushArgs(workspace), {
      CONVEX_DEPLOY_KEY: 'prod:brainy-emu-822|deadbeef',
    })

    expect(result.status).toBe(0)
    for (const call of result.calls) {
      expect(call.deployKey ?? null).toBeNull()
    }
  })

  it('rechaza un .env.local con deploy key de prod', async () => {
    const workspace = makeWorkspace()
    writeFileSync(
      workspace.envPath,
      'CONVEX_DEPLOYMENT=dev:kindly-mole-736\nCONVEX_DEPLOY_KEY=prod:brainy-emu-822|deadbeef\n'
    )

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/CONVEX_DEPLOY_KEY/)
    expect(result.calls).toEqual([])
  })

  it('rechaza si el deployment resuelto se declara production', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })

    const result = await runPush(workspace, pushArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/production/i)
    expect(result.calls.map((call) => call.fn)).toEqual(['env:get'])
  })

  it('un CONVEX_DEPLOYMENT de prod en el carril dev sigue muriendo antes de la red', async () => {
    const workspace = makeWorkspace()

    const result = await runPush(workspace, pushArgs(workspace), {
      CONVEX_DEPLOYMENT: 'prod:brainy-emu-822',
    })

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.calls).toEqual([])
  })
})

// El archivo temporal muere con el tmpdir del sistema; borrarlo acá obligaría a
// serializar los casos, que corren en paralelo sobre workspaces distintos.
export {}

// ============================================================================
// EL RESPALDO DE .env.local NO PUEDE QUEDAR HUÉRFANO
// ============================================================================
// El carril prod aparta `.env.local` a `.env.local.operator-bak` mientras dura
// el proceso. Si una corrida muere sin restaurarlo, el operador se queda SIN
// `.env.local` y toda corrida siguiente lo rechazaba con "ya existe
// .operator-bak" — dos daños de un solo crash. El respaldo se reclama: con un
// dueño vivo se espera, sin dueño se restaura.

describe('vdr-push: respaldo huérfano de .env.local', () => {
  const prodArgs = (workspace: Workspace) => pushArgs(workspace, ['--deployment', 'prod', '--yes'])

  it('restaura un .operator-bak sin dueño vivo y sigue', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })
    const stashPath = `${workspace.envPath}.operator-bak`
    writeFileSync(stashPath, 'CONVEX_DEPLOYMENT=dev:kindly-mole-736\nSECRETO=abc\n')
    rmSync(workspace.envPath)

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(0)
    expect(result.stderr).toMatch(/huérfan|restaurando/i)
    expect(existsSync(workspace.envPath)).toBe(true)
    expect(readFileSync(workspace.envPath, 'utf8')).toContain('SECRETO=abc')
    expect(existsSync(stashPath)).toBe(false)
  })

  it('descarta un .operator-bak idéntico al .env.local vigente', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })
    const stashPath = `${workspace.envPath}.operator-bak`
    copyFileSync(workspace.envPath, stashPath)

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(0)
    expect(existsSync(workspace.envPath)).toBe(true)
    expect(existsSync(stashPath)).toBe(false)
  })

  it('un .operator-bak que difiere del .env.local vigente se reconcilia a mano', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })
    const stashPath = `${workspace.envPath}.operator-bak`
    writeFileSync(stashPath, 'CONVEX_DEPLOYMENT=dev:otro-mole-999\n')

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/mano/i)
    expect(result.calls).toEqual([])
    expect(existsSync(stashPath)).toBe(true)
  })

  it('con otra corrida viva espera en vez de robarle el respaldo', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })
    const stashPath = `${workspace.envPath}.operator-bak`
    writeFileSync(stashPath, 'CONVEX_DEPLOYMENT=dev:kindly-mole-736\n')
    // El propio proceso de vitest: un pid que existe y no es el del hijo.
    writeFileSync(`${stashPath}.pid`, `${process.pid}\n`)
    rmSync(workspace.envPath)

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(new RegExp(`${process.pid}`))
    expect(result.calls).toEqual([])
    expect(existsSync(stashPath)).toBe(true)
  })

  it('una corrida prod normal devuelve .env.local y no deja respaldo', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(0)
    expect(readFileSync(workspace.envPath, 'utf8')).toContain('CONVEX_DEPLOYMENT=')
    expect(existsSync(`${workspace.envPath}.operator-bak`)).toBe(false)
    expect(existsSync(`${workspace.envPath}.operator-bak.pid`)).toBe(false)
  })

  // El daño de una corrida PROD que murió sin devolver `.env.local` lo cobra el
  // carril DEV, que es el default de vdr-pull/vdr-push: el reclamo vivía dentro
  // de `stashEnvLocal`, que solo corre en prod, así que el carril dev moría con
  // "CONVEX_DEPLOYMENT ausente" con el respaldo ahí al lado.
  it('el carril dev también reclama el respaldo huérfano', async () => {
    const workspace = makeWorkspace()
    const stashPath = `${workspace.envPath}.operator-bak`
    writeFileSync(stashPath, 'CONVEX_DEPLOYMENT=dev:kindly-mole-736\nSECRETO=abc\n')
    rmSync(workspace.envPath)

    const result = await runPush(workspace, pushArgs(workspace), {
      // Sin `CONVEX_DEPLOYMENT` exportado: el único deployment del carril dev
      // es el que trae el archivo apartado.
      CONVEX_DEPLOYMENT: undefined,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toMatch(/huérfan|restaurando/i)
    expect(existsSync(workspace.envPath)).toBe(true)
    expect(readFileSync(workspace.envPath, 'utf8')).toContain('SECRETO=abc')
    expect(existsSync(stashPath)).toBe(false)
  })

  it('un .pid sin respaldo no traba la corrida siguiente', async () => {
    const workspace = makeWorkspace({ convexEnv: 'production' })
    // Lo que deja una corrida que murió entre reservar el candado y mover el
    // archivo: dueño sin respaldo.
    writeFileSync(`${workspace.envPath}.operator-bak.pid`, '999999999\n')

    const result = await runPush(workspace, prodArgs(workspace))

    expect(result.status).toBe(0)
    expect(existsSync(`${workspace.envPath}.operator-bak.pid`)).toBe(false)
  })
})

// ============================================================================
// EL CANDADO COMPARA EL DEPLOYMENT, NO SU CLASE
// ============================================================================
// Con `CONVEX_DEPLOYMENT=dev:otro` exportado y una deploy key de OTRO dev en el
// archivo, mirar solo el prefijo `dev:` dejaba pasar la corrida: el script
// imprimía un deployment y la CLI escribía en el otro.

describe('vdr-push: deploy key de otro dev en .env.local', () => {
  it('rechaza cuando la deploy key del archivo no es el deployment resuelto', async () => {
    const workspace = makeWorkspace()
    writeFileSync(
      workspace.envPath,
      'CONVEX_DEPLOYMENT=dev:kindly-mole-736\nCONVEX_DEPLOY_KEY=dev:otro-mole-999|deadbeef\n'
    )

    const result = await runPush(workspace, pushArgs(workspace), {
      CONVEX_DEPLOYMENT: 'dev:kindly-mole-736',
    })

    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/dev:otro-mole-999/)
    expect(result.stderr).toMatch(/dev:kindly-mole-736/)
    expect(result.calls).toEqual([])
  })

  it('una deploy key del MISMO deployment sigue corriendo', async () => {
    const workspace = makeWorkspace()
    writeFileSync(
      workspace.envPath,
      'CONVEX_DEPLOYMENT=dev:kindly-mole-736\nCONVEX_DEPLOY_KEY=dev:kindly-mole-736|deadbeef\n'
    )

    const result = await runPush(workspace, pushArgs(workspace), {
      CONVEX_DEPLOYMENT: 'dev:kindly-mole-736',
    })

    expect(result.status).toBe(0)
    // Y el hijo sigue sin verla: la CLI la leerá del archivo, no del entorno.
    for (const call of result.calls) {
      expect(call.deployKey ?? null).toBeNull()
    }
  })
})
