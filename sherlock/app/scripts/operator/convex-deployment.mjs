// ============================================================================
// CANDADO DE DEPLOYMENT DE LOS SCRIPTS DE OPERADOR
// ============================================================================
// Un solo dueño de "contra qué deployment habla este proceso", compartido por
// `vdr-pull.mjs` y `vdr-push.mjs`. Dos copias de esta decisión son dos
// oportunidades de escribir en la sala equivocada.
//
// Tres carriles: `dev`, `prod` y `local`. `local` lee la URL y la adminKey del
// `config.json` del sandbox (`.convex-local/.convex/local/default/config.json`)
// y llama las funciones con `ConvexHttpClient.setAdminAuth`, el mismo camino
// que `convex run` anónimo. No lee ni escribe `.env.local` y ignora
// `CONVEX_DEPLOY_KEY`.
//
// La trampa que justifica el módulo (documentada en CLAUDE.md): `bunx convex …
// --prod` IGNORA `--prod` si `sherlock/app/.env.local` trae un `CONVEX_DEPLOY_KEY`
// de dev, y opera sobre dev diciéndolo solo en un warning. Apartar el archivo
// mientras dura el proceso es lo que hace real el destino. La restauración
// tiene que sobrevivir a un throw, a `process.exit` y a SIGINT/SIGTERM: si no,
// el operador se queda sin `.env.local` y su siguiente comando falla raro.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(SCRIPT_DIR, '..', '..')
const PROD_DEPLOYMENT = 'prod:brainy-emu-822'
const LOCAL_DEPLOYMENT_FALLBACK = 'anonymous:anonymous-agent'
const LOCAL_BACKEND_CONFIG_RELATIVE = join(
  '.convex-local',
  '.convex',
  'local',
  'default',
  'config.json'
)
const LOCAL_MISSING_MESSAGE = 'No hay backend local: levanta `bun run dev:local` primero.'
const LOCAL_CONNECT_TIMEOUT_MS = 500
const LOCAL_CLOUD_PORT_MIN = 1
const LOCAL_CLOUD_PORT_MAX = 65535

export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2

/** Error con código de salida: cada script lo imprime con su propio prefijo. */
export class OperatorCliError extends Error {
  constructor(message, code = EXIT_FAILED) {
    super(message)
    this.name = 'OperatorCliError'
    this.code = code
  }
}

// `.env.local` guarda el deployment con un comentario pegado detrás
// (`dev:kindly-mole-736 # team: …, project: …`). Ese comentario es parte del
// valor para la CLI, pero no del identificador: se queda con el primer token.
function normalizeDeployment(value) {
  return value
    .replace(/^["']|["']$/g, '')
    .split('#')[0]
    .trim()
}

function readEnvLocalValue(name) {
  const envPath = join(APP_ROOT, '.env.local')
  if (!existsSync(envPath)) return undefined
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line)
    if (match) return normalizeDeployment(match[1])
  }
  return undefined
}

function readEnvLocalDeployment() {
  return readEnvLocalValue('CONVEX_DEPLOYMENT')
}

// Un deploy key trae el deployment adelante, separado por `|`
// (`prod:brainy-emu-822|ey…`). Un valor sin esa forma no dice a qué deployment
// apunta, y esta función devuelve `undefined` en vez de inventarlo.
function deployKeyDeployment(value) {
  if (!value) return undefined
  const [prefix] = value.split('|')
  return /^(dev|prod|preview):/.test(prefix) ? prefix : undefined
}

const ENV_LOCAL_PATH = join(APP_ROOT, '.env.local')
const ENV_LOCAL_STASH_PATH = `${ENV_LOCAL_PATH}.operator-bak`
// Quién tiene apartado el archivo. Sin esto, "ya existe .operator-bak" no
// distingue una corrida viva de los restos de una que murió.
const ENV_LOCAL_STASH_OWNER_PATH = `${ENV_LOCAL_STASH_PATH}.pid`
let envLocalStashed = false
let restoreHandlersRegistered = false

function dropStashOwner() {
  if (existsSync(ENV_LOCAL_STASH_OWNER_PATH)) {
    rmSync(ENV_LOCAL_STASH_OWNER_PATH, { force: true })
  }
}

export function restoreEnvLocal() {
  if (!envLocalStashed) return
  envLocalStashed = false
  // El candado se suelta solo si sigue siendo NUESTRO. Si otro proceso lo
  // reclamó (nos dio por muertos), ni el respaldo ni el `.pid` son nuestros
  // para tocarlos: devolverlos acá pisaría el `.env.local` que ese otro ya
  // restauró.
  const owner = readStashOwner()
  if (owner !== undefined && owner !== process.pid) return
  if (existsSync(ENV_LOCAL_STASH_PATH)) {
    renameSync(ENV_LOCAL_STASH_PATH, ENV_LOCAL_PATH)
  }
  dropStashOwner()
}

function registerRestoreHandlers() {
  if (restoreHandlersRegistered) return
  restoreHandlersRegistered = true
  process.on('exit', restoreEnvLocal)
  // SIGHUP entra en la lista porque es lo que recibe el proceso cuando el
  // operador cierra la terminal a media corrida, que es justo el momento en que
  // dejar `.env.local` apartado le cuesta más caro.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => {
      restoreEnvLocal()
      process.exit(code)
    })
  }
  process.on('uncaughtException', (error) => {
    restoreEnvLocal()
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exit(EXIT_FAILED)
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = el proceso existe y es de otro usuario. Solo ESRCH prueba muerte.
    return error?.code === 'EPERM'
  }
}

function readStashOwner() {
  if (!existsSync(ENV_LOCAL_STASH_OWNER_PATH)) return undefined
  const pid = Number.parseInt(readFileSync(ENV_LOCAL_STASH_OWNER_PATH, 'utf8').trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Un `.operator-bak` sin dueño vivo son los restos de una corrida que murió sin
 * devolver `.env.local` — y el peor caso es justo el que la versión anterior no
 * atendía: sin `.env.local` en el árbol, `stashEnvLocal` salía temprano y el
 * respaldo se quedaba ahí para siempre, rechazando toda corrida siguiente.
 */
function reclaimOrphanStash() {
  // El respaldo de ESTA corrida no es huérfano: sin esta salida temprana, el
  // proceso que ya apartó su `.env.local` se lo devolvería a sí mismo a media
  // corrida y seguiría hablando con el deployment del archivo.
  if (envLocalStashed) return

  const owner = readStashOwner()
  if (owner !== undefined && owner !== process.pid && isProcessAlive(owner)) {
    throw new OperatorCliError(
      `otra corrida de operador (pid ${owner}) tiene apartado .env.local. ` +
        'Espera a que termine antes de correr esta. Si ese pid ya no es una corrida ' +
        `de operador, borra ${ENV_LOCAL_STASH_OWNER_PATH} a mano.`,
      EXIT_REFUSED
    )
  }

  if (!existsSync(ENV_LOCAL_STASH_PATH)) {
    // Un dueño sin respaldo es un candado muerto: la corrida que lo reservó
    // murió en la ventana entre reservar y apartar. Se suelta.
    dropStashOwner()
    return
  }

  if (!existsSync(ENV_LOCAL_PATH)) {
    process.stderr.write(
      `[operator] aviso: restaurando ${ENV_LOCAL_STASH_PATH}, huérfano de una corrida ` +
        'anterior que no lo devolvió\n'
    )
    renameSync(ENV_LOCAL_STASH_PATH, ENV_LOCAL_PATH)
    dropStashOwner()
    return
  }

  if (readFileSync(ENV_LOCAL_STASH_PATH, 'utf8') === readFileSync(ENV_LOCAL_PATH, 'utf8')) {
    process.stderr.write(
      `[operator] aviso: ${ENV_LOCAL_STASH_PATH} huérfano e idéntico al .env.local vigente: ` +
        'se descarta\n'
    )
    rmSync(ENV_LOCAL_STASH_PATH, { force: true })
    dropStashOwner()
    return
  }

  // Dos archivos distintos y ningún dueño: el respaldo puede traer secretos que
  // el `.env.local` vigente no tiene. Borrar uno de los dos no es decisión de
  // un script.
  throw new OperatorCliError(
    `${ENV_LOCAL_STASH_PATH} quedó de una corrida anterior y DIFIERE del .env.local ` +
      'vigente. Reconcilia los dos archivos a mano antes de seguir.',
    EXIT_REFUSED
  )
}

function stashEnvLocal() {
  reclaimOrphanStash()
  if (!existsSync(ENV_LOCAL_PATH)) return
  registerRestoreHandlers()
  // El dueño se RESERVA antes de mover el archivo, y con `wx` (crear-o-fallar),
  // que es la única operación atómica que da el filesystem. En el orden inverso
  // existía una ventana con el respaldo ya en disco y sin `.pid`: otra corrida
  // lo leía como huérfano, devolvía `.env.local` al árbol, y esta corrida
  // seguía creyéndolo apartado — un carril prod hablando con el deployment del
  // archivo, en silencio, que es justo lo que este módulo existe para evitar.
  try {
    writeFileSync(ENV_LOCAL_STASH_OWNER_PATH, `${process.pid}\n`, { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    throw new OperatorCliError(
      `otra corrida de operador se adelantó a apartar .env.local (${ENV_LOCAL_STASH_OWNER_PATH}). ` +
        'Espera a que termine antes de correr esta.',
      EXIT_REFUSED
    )
  }
  try {
    renameSync(ENV_LOCAL_PATH, ENV_LOCAL_STASH_PATH)
  } catch (error) {
    dropStashOwner()
    throw error
  }
  envLocalStashed = true
}

function convexCli(target, args) {
  const result = spawnSync('bunx', ['convex', ...args], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: target.env,
  })
  if (result.error) {
    throw new OperatorCliError(`no se pudo invocar bunx convex ${args[0]}: ${result.error.message}`)
  }
  return result
}

function extractJson(stdout) {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{"]/)
    if (start === -1) return trimmed
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      return trimmed
    }
  }
}

export function convexRun(target, functionName, args = {}) {
  if (target.isLocal) {
    throw new OperatorCliError(
      'el carril local no usa bunx convex: llama runOperatorFunction',
      EXIT_FAILED
    )
  }
  const result = convexCli(target, ['run', functionName, JSON.stringify(args)])
  if (result.status !== 0) {
    throw new OperatorCliError(
      `convex run ${functionName} falló (${result.status}): ${result.stderr?.trim() ?? ''}`
    )
  }
  return extractJson(result.stdout ?? '')
}

// El CLI (`node_modules/convex/src/cli/lib/run.ts`) construye un
// ConvexHttpClient, llama `setAdminAuth(adminKey)` y despacha por
// `POST /api/function`. Eso es lo que alcanza las `internal*` del operador
// sin deploy key de la nube. El import es dinámico para que los tests que
// copian este módulo a un tmpdir no resuelvan `convex/browser` desde /tmp.
async function invokeLocalFunction(target, functionName, args) {
  const { ConvexHttpClient } = await import('convex/browser')
  const client = new ConvexHttpClient(target.url, { logger: false })
  client.setAdminAuth(target.adminKey)
  try {
    return await client.function(functionName, undefined, args)
  } catch (error) {
    throw new OperatorCliError(`convex run ${functionName} falló: ${error?.message ?? error}`)
  }
}

export async function runOperatorFunction(target, functionName, args = {}) {
  if (target.isLocal) {
    return invokeLocalFunction(target, functionName, args)
  }
  return convexRun(target, functionName, args)
}

// La única prueba de que el child NO está hablando con dev es preguntarle al
// deployment quién dice ser.
function assertProductionDeployment(target) {
  const result = convexCli(target, ['env', 'get', 'CONVEX_ENV'])
  const value = (result.stdout ?? '').trim()
  if (result.status !== 0 || value !== 'production') {
    throw new OperatorCliError(
      `el deployment no se declara production (CONVEX_ENV=${value || 'ausente'}). ` +
        'Ponlo con `CONVEX_DEPLOYMENT=prod:brainy-emu-822 bunx convex env set CONVEX_ENV production --prod` ' +
        'antes de correr contra prod.',
      EXIT_REFUSED
    )
  }
  return value
}

// El mismo interrogatorio, del otro lado: el carril dev también le pregunta al
// deployment quién dice ser, porque `CONVEX_DEPLOYMENT` es una intención y no
// un destino. Un deployment que se declara production mata la corrida; que la
// pregunta falle NO la mata (un dev sin `CONVEX_ENV` es normal), solo avisa —
// el candado duro son los dos chequeos estáticos de `resolveDeployment`.
function assertNotProductionDeployment(target) {
  const result = convexCli(target, ['env', 'get', 'CONVEX_ENV'])
  const value = (result.stdout ?? '').trim()
  if (result.status !== 0) {
    process.stderr.write(
      `[operator] aviso: no se pudo confirmar CONVEX_ENV del deployment ${target.deployment}\n`
    )
    return
  }
  if (value === 'production') {
    throw new OperatorCliError(
      `el carril dev terminó hablando con un deployment que se declara production ` +
        `(${target.deployment}). Revisa CONVEX_DEPLOY_KEY en tu entorno y en .env.local ` +
        'antes de seguir.',
      EXIT_REFUSED
    )
  }
}

function localBackendConfigPath(appRoot = APP_ROOT) {
  return join(appRoot, LOCAL_BACKEND_CONFIG_RELATIVE)
}

function localBackendNotListeningMessage(port) {
  return `No hay backend local escuchando en 127.0.0.1:${port}: levanta \`bun run dev:local\` primero.`
}

// Misma prueba que `isPortBusy` en `scripts/convex-local.mjs`: el config.json
// sobrevive a un backend que ya se apagó, y sin este sondeo el carril local
// devolvería una URL muerta.
function isLocalCloudListening(port) {
  return new Promise((resolveListening) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(LOCAL_CONNECT_TIMEOUT_MS)
    let settled = false
    const settle = (listening) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveListening(listening)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.once('timeout', () => settle(false))
  })
}

/**
 * Carril local: URL `http://127.0.0.1:<ports.cloud>` y adminKey del
 * `config.json` del sandbox de ESTE worktree. No toca `.env.local`.
 * Es async porque confirma que el puerto del config acepta conexión.
 */
async function resolveLocalBackend(appRoot = APP_ROOT) {
  const configPath = localBackendConfigPath(appRoot)
  if (!existsSync(configPath)) {
    throw new OperatorCliError(LOCAL_MISSING_MESSAGE, EXIT_REFUSED)
  }

  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new OperatorCliError(`${configPath} no es JSON válido`, EXIT_REFUSED)
  }

  const cloudPortRaw = config?.ports?.cloud
  const cloudPort = Number(cloudPortRaw)
  const adminKey = typeof config?.adminKey === 'string' ? config.adminKey.trim() : ''
  if (adminKey.length === 0 || !Number.isInteger(cloudPort)) {
    throw new OperatorCliError(
      `${configPath} no trae ports.cloud y adminKey del backend anónimo`,
      EXIT_REFUSED
    )
  }
  if (cloudPort < LOCAL_CLOUD_PORT_MIN || cloudPort > LOCAL_CLOUD_PORT_MAX) {
    throw new OperatorCliError(
      `ports.cloud=${cloudPortRaw} no es un puerto TCP válido (entero ${LOCAL_CLOUD_PORT_MIN}-${LOCAL_CLOUD_PORT_MAX})`,
      EXIT_REFUSED
    )
  }

  if (!(await isLocalCloudListening(cloudPort))) {
    throw new OperatorCliError(localBackendNotListeningMessage(cloudPort), EXIT_REFUSED)
  }

  const named = typeof config.deploymentName === 'string' ? config.deploymentName.trim() : ''
  const env = { ...process.env }
  delete env.CONVEX_DEPLOY_KEY

  return {
    deployment: named.length > 0 ? named : LOCAL_DEPLOYMENT_FALLBACK,
    env,
    isProd: false,
    isLocal: true,
    url: `http://127.0.0.1:${cloudPort}`,
    adminKey,
  }
}

/**
 * Resuelve el destino y lo prueba. Devuelve `{ deployment, env, isProd }` para
 * pasarle a `convexRun`, o el target local con `url` y `adminKey`. Lanza
 * `OperatorCliError` en cualquier ambigüedad.
 */
export function resolveDeployment({ deployment, appRoot = APP_ROOT }) {
  if (deployment === 'local') {
    return resolveLocalBackend(appRoot)
  }
  if (deployment !== 'dev' && deployment !== 'prod') {
    throw new OperatorCliError(
      'falta --deployment dev|prod|local (no se adivina destino)',
      EXIT_REFUSED
    )
  }

  // EL RECLAMO ES DE LOS DOS CARRILES. Solo el carril prod aparta `.env.local`,
  // pero el daño de que una corrida prod muera sin devolverlo lo cobra el
  // carril DEV, que es el default de `vdr-pull`/`vdr-push`: sin `.env.local` en
  // el árbol se queda sin `CONVEX_DEPLOYMENT` y muere con "ausente" en vez de
  // restaurar el respaldo que está ahí al lado.
  reclaimOrphanStash()

  if (deployment === 'prod') {
    stashEnvLocal()
    const env = { ...process.env, CONVEX_DEPLOYMENT: PROD_DEPLOYMENT }
    delete env.CONVEX_DEPLOY_KEY
    const target = { deployment: PROD_DEPLOYMENT, env, isProd: true }
    assertProductionDeployment(target)
    return target
  }

  const raw = process.env.CONVEX_DEPLOYMENT ?? readEnvLocalDeployment()
  const resolved = raw ? normalizeDeployment(raw) : undefined
  if (!resolved) {
    throw new OperatorCliError(
      'CONVEX_DEPLOYMENT ausente: --deployment dev no tiene deployment que usar',
      EXIT_REFUSED
    )
  }
  if (!resolved.startsWith('dev:') || resolved === PROD_DEPLOYMENT) {
    throw new OperatorCliError(
      `CONVEX_DEPLOYMENT=${resolved} no es un deployment dev:`,
      EXIT_REFUSED
    )
  }

  // `CONVEX_DEPLOY_KEY` LE GANA a `CONVEX_DEPLOYMENT`: con una deploy key de
  // prod exportada, el carril dev escribía en prod diciendo `dev:`. Se borra
  // del entorno del hijo igual que en prod — y como la CLI también lee
  // `.env.local`, una deploy key EN EL ARCHIVO no se puede desactivar desde
  // acá y la corrida se rechaza en vez de adivinar.
  //
  // La comparación es de IGUALDAD, no de clase. Mirar solo el prefijo `dev:`
  // dejaba pasar el caso que más se parece a una corrida sana: con
  // `CONVEX_DEPLOYMENT=dev:otro` exportado y una deploy key de
  // `dev:kindly-mole-736` en el archivo, el script imprimía un deployment y la
  // CLI escribía en otro — dos salas dev distintas, y el operador leyendo la
  // equivocada.
  const fileKeyDeployment = deployKeyDeployment(readEnvLocalValue('CONVEX_DEPLOY_KEY'))
  if (fileKeyDeployment && fileKeyDeployment !== resolved) {
    throw new OperatorCliError(
      `.env.local trae un CONVEX_DEPLOY_KEY de ${fileKeyDeployment}, que le gana a ` +
        `CONVEX_DEPLOYMENT=${resolved}: el script diría ${resolved} y la CLI escribiría en ` +
        `${fileKeyDeployment}. Sácalo del archivo o alinéalo antes de correr el carril dev.`,
      EXIT_REFUSED
    )
  }

  const env = { ...process.env, CONVEX_DEPLOYMENT: resolved }
  delete env.CONVEX_DEPLOY_KEY
  const target = { deployment: resolved, env, isProd: false }
  assertNotProductionDeployment(target)
  return target
}
