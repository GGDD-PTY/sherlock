#!/usr/bin/env node
// ============================================================================
// PURGA DE EMPRESAS DE PRUEBA (Convex + WorkOS) — camino ÚNICO
// ============================================================================
// Prod acumuló 45 empresas sembradas sobre 48 (2026-09-02): ruido en la vista
// general de admin y en `resolveCompany`. Este script es el único camino de
// purga, y el playbook vive en `llm-wiki/bundle/engineering/playbooks.md`.
//
// TRES CANDADOS, EN ESTE ORDEN:
//   1. `--dry-run` es el DEFAULT. Sin `--execute` no se borra nada, ni en
//      Convex ni en WorkOS: imprime el deployment resuelto y después el
//      inventario por empresa y por tabla de lo que BORRARÍA.
//   2. Una empresa se nombra con `--company-id` + `--confirm-name "<exacto>"`.
//      El nombre lo compara la mutation contra la fila real; escribirlo mal es
//      un rechazo, no un borrado parcial.
//   3. `--seed-sweep` sólo propone empresas cuyo DUEÑO tiene correo de dominio
//      semilla y en las que ningún miembro tiene correo real. La lista se
//      imprime ANTES de tocar nada y, con `--execute`, se vuelve a verificar
//      aquí: si alguna dejó de calificar, la corrida entera se rechaza.
//
// El destino lo resuelve `convex-deployment.mjs`, que aparta `.env.local`
// mientras dura una corrida prod (la trampa de `--prod` ignorado que documenta
// CLAUDE.md) y lo devuelve ante throw, exit, SIGINT/SIGTERM/SIGHUP.
//
// WorkOS va DESPUÉS de Convex y sólo con `--execute`: `userManagement.
// deleteUser` no es reversible. Un perfil sin `workosUserId` (todo lo sembrado)
// se salta con una línea impresa, nunca en silencio. Antes de borrar, cada
// usuario se LEE (`GET /user_management/users/<id>`) y se imprime su correo.
//
// LA CLAVE DE WORKOS VA POR AMBIENTE. `WORKOS_API_KEY` de `.env.local` es la
// del ambiente dev de WorkOS: contra prod responde «User not found» y parece
// que el usuario no existía (2026-09-06). Con `--target prod` el script lee
// SOLO `WORKOS_API_KEY_PROD` del entorno del proceso; si falta, imprime los
// ids, se salta WorkOS y termina con código 2 (Convex ya quedó purgado).
//
// Uso:
//   bun --cwd=sherlock/app run purge-company -- --seed-sweep
//   bun --cwd=sherlock/app run purge-company -- --seed-sweep --execute \
//     --operator-email fixture-4622a879@example.com --reason "..."
//   bun --cwd=sherlock/app run purge-company -- --company-id <id> \
//     --confirm-name "Nombre exacto" --execute --operator-email ... --reason "..."
//   bun --cwd=sherlock/app run purge-company -- --purge-user-email <correo> \
//     --target prod --execute --operator-email ... --reason "..."
//     (perfil huérfano con correo real: ni ADMIN, ni operador, ni dueño de empresa)
//   WORKOS_API_KEY_PROD=sk_live_… bun --cwd=sherlock/app run purge-company -- \
//     --target prod --execute ...   (la clave prod de WorkOS, solo en el entorno)
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_ROOT,
  EXIT_FAILED,
  EXIT_REFUSED,
  OperatorCliError,
  convexRun as runConvexFunction,
  resolveDeployment,
  restoreEnvLocal,
} from './convex-deployment.mjs'

/** Los dos usuarios semilla que quedaron pendientes en prod. Se
 *  DESACTIVAN, no se borran: `admin@dev.local` es el usuario del bypass de dev
 *  y ambos pueden firmar filas de la bitácora, que sobrevive a lo que audita. */
const DEFAULT_SEED_USER_EMAILS = ['fixture-ae0b4b41@example.com', 'admin@dev.local']

function log(message) {
  process.stdout.write(`[purge-company] ${message}\n`)
}

function fail(message, code = EXIT_FAILED) {
  process.stderr.write(`[purge-company] ${message}\n`)
  process.exit(code)
}

function orFail(action) {
  try {
    return action()
  } catch (error) {
    if (error instanceof OperatorCliError) fail(error.message, error.code)
    throw error
  }
}

/** `WORKOS_API_KEY` se lee ANTES de resolver el destino: el carril prod aparta
 *  `.env.local` y después ya no está en el árbol para leerlo. */
function readEnvLocalRaw(name) {
  if (process.env[name]) return process.env[name]
  const envPath = join(APP_ROOT, '.env.local')
  if (!existsSync(envPath)) return undefined
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '').trim()
  }
  return undefined
}

export const WORKOS_PROD_KEY_VAR = 'WORKOS_API_KEY_PROD'

/** La clave de WorkOS es POR AMBIENTE. Dev sigue leyendo `WORKOS_API_KEY`
 *  (entorno o `.env.local`). Prod lee ÚNICAMENTE `WORKOS_API_KEY_PROD` del
 *  entorno del proceso: nunca `.env.local`, que trae la clave del ambiente dev
 *  y contra prod contesta «User not found» para un usuario que sí existe. */
export function resolveWorkosApiKey(target, env = process.env, readDevKey = readEnvLocalRaw) {
  if (target === 'prod') {
    return { apiKey: env[WORKOS_PROD_KEY_VAR] || undefined, variable: WORKOS_PROD_KEY_VAR }
  }
  return { apiKey: readDevKey('WORKOS_API_KEY'), variable: 'WORKOS_API_KEY' }
}

export function parseArgs(argv) {
  const options = {
    target: 'dev',
    execute: false,
    seedSweep: false,
    companyId: null,
    confirmName: null,
    operatorEmail: null,
    operatorProfileId: null,
    reason: null,
    excludeCompanyIds: [],
    deactivateSeedUsers: false,
    seedUserEmails: [...DEFAULT_SEED_USER_EMAILS],
    purgeUserEmails: [],
    batchSize: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index] ?? null
    switch (arg) {
      case '--target':
      case '--deployment':
        options.target = next()
        break
      case '--dry-run':
        options.execute = false
        break
      case '--execute':
        options.execute = true
        break
      case '--seed-sweep':
        options.seedSweep = true
        break
      case '--company-id':
        options.companyId = next()
        break
      case '--confirm-name':
        options.confirmName = next()
        break
      case '--operator-email':
        options.operatorEmail = next()
        break
      case '--operator-profile-id':
        options.operatorProfileId = next()
        break
      case '--reason':
        options.reason = next()
        break
      case '--exclude-company-id':
        options.excludeCompanyIds.push(next())
        break
      case '--deactivate-seed-users':
        options.deactivateSeedUsers = true
        break
      case '--seed-user-email':
        options.seedUserEmails = [...new Set([...options.seedUserEmails, next()])]
        break
      case '--purge-user-email':
        options.purgeUserEmails = [...new Set([...options.purgeUserEmails, next()])]
        break
      case '--batch-size':
        options.batchSize = Number.parseInt(next() ?? '', 10)
        break
      default:
        throw new OperatorCliError(`argumento desconocido: ${arg}`, EXIT_REFUSED)
    }
  }

  if (options.target !== 'dev' && options.target !== 'prod') {
    throw new OperatorCliError('falta --target dev|prod', EXIT_REFUSED)
  }
  if (
    !options.seedSweep &&
    !options.companyId &&
    !options.deactivateSeedUsers &&
    options.purgeUserEmails.length === 0
  ) {
    throw new OperatorCliError(
      'nada que hacer: pasa --seed-sweep, --company-id <id>, --deactivate-seed-users o --purge-user-email <correo>',
      EXIT_REFUSED
    )
  }
  if (options.companyId && !options.confirmName) {
    throw new OperatorCliError(
      '--company-id exige --confirm-name "<nombre exacto de la empresa>"',
      EXIT_REFUSED
    )
  }
  if (options.seedSweep && options.companyId) {
    throw new OperatorCliError('--seed-sweep y --company-id son excluyentes', EXIT_REFUSED)
  }
  if (options.batchSize !== null && !Number.isInteger(options.batchSize)) {
    throw new OperatorCliError('--batch-size espera un entero', EXIT_REFUSED)
  }
  return options
}

/** La regla de selección, verificada UNA SEGUNDA VEZ del lado del script: la
 *  primera la aplica `listSeedSweepCandidates` dentro de Convex. Una empresa
 *  que no venga marcada `selectable`, o que traiga cualquier correo bloqueante,
 *  mata la corrida en vez de saltarse. */
export function assertSweepSelection(selected) {
  const offenders = selected.filter(
    (row) => row.selectable !== true || (row.blockedBy ?? []).length > 0
  )
  if (offenders.length > 0) {
    throw new OperatorCliError(
      `${offenders.length} empresa(s) seleccionada(s) no pasan la regla de semilla: ` +
        offenders.map((row) => `${row.name} (${row.blockedBy.join(', ')})`).join(' · '),
      EXIT_REFUSED
    )
  }
}

function printCandidate(row) {
  const mark = row.selectable ? 'SEED   ' : 'PROTEGE'
  log(`  ${mark} ${row.name}  ${row.companyId}  dueño=${row.ownerEmail ?? '(sin correo)'}`)
  if (!row.selectable) log(`          bloquean: ${row.blockedBy.join(', ')}`)
  if (row.operatorEmails?.length) log(`          equipo: ${row.operatorEmails.join(', ')}`)
}

function printInventory(result) {
  const header = result.alreadyPurged
    ? `${result.companyId} — ya purgada, deleted 0`
    : `${result.company}  ${result.companyId}  [${result.status}]`
  log(`  ${header}`)
  for (const entry of result.tables ?? []) {
    const capped = entry.capped ? ' (techo)' : ''
    log(`    ${entry.decision.padEnd(6)} ${entry.table}  ${entry.rows ?? entry.deleted}${capped}`)
  }
  if (result.execute) {
    log(
      `    totales  filas ${result.deleted}  marcadas ${result.marked}  blobs ${result.blobsDeleted}  lotes ${result.passes}`
    )
  }
  const workosUsers = result.workos?.userIds ?? []
  log(
    `    workos   usuarios ${workosUsers.length ? workosUsers.join(', ') : '(ninguno)'}  org ${result.workos?.organizationId ?? '(ninguna)'}`
  )
  for (const note of result.notes ?? []) log(`    nota: ${note}`)
}

/** WorkOS emite ids con forma `user_` + 26 caracteres de ULID en mayúsculas.
 *  Dev guarda además ids sintéticos (`dev_company_001_workos`,
 *  `user_codex_local_1780475693904`) que WorkOS nunca emitió: mandarlos a
 *  `deleteUser` no borra nada y ensucia la salida con fallos falsos. */
export function looksLikeWorkosUserId(value) {
  return typeof value === 'string' && /^user_[0-9A-Z]{26}$/.test(value)
}

async function defaultWorkosClient(apiKey) {
  const { WorkOS } = await import('@workos-inc/node')
  return new WorkOS(apiKey)
}

/** Devuelve `'DONE'`, `'NOTHING'` o `'MISSING_KEY'`. Con `MISSING_KEY` y algo
 *  que borrar, `main` cierra con código 2: Convex ya quedó purgado y WorkOS no,
 *  y eso tiene que verse en el exit code, no solo en una línea del log. */
export async function deleteInWorkos({
  userIds,
  organizationIds,
  apiKey,
  variable = 'WORKOS_API_KEY',
  createClient = defaultWorkosClient,
  print = log,
}) {
  const skipped = userIds.filter((id) => !looksLikeWorkosUserId(id))
  for (const id of skipped) {
    print(`workos: OMITIDO ${id} — no tiene forma de id de WorkOS (identidad sintética de seed)`)
  }
  userIds = userIds.filter(looksLikeWorkosUserId)

  if (userIds.length === 0 && organizationIds.length === 0) {
    print('workos: nada que borrar (ningún perfil traía workosUserId ni organización)')
    return 'NOTHING'
  }
  if (!apiKey) {
    print(
      `workos: OMITIDO — falta ${variable} en el entorno del proceso; los ids quedan arriba y ` +
        'nada se tocó en WorkOS' +
        (variable === WORKOS_PROD_KEY_VAR
          ? ' (la WORKOS_API_KEY de .env.local es del ambiente dev de WorkOS y contra prod ' +
            'contesta «User not found»)'
          : '')
    )
    return 'MISSING_KEY'
  }
  const workos = await createClient(apiKey)
  for (const userId of userIds) {
    // Leer antes de borrar: el correo impreso es la prueba de que la clave
    // apunta al ambiente correcto. Si la lectura falla, ese id no se borra.
    let email
    try {
      const user = await workos.userManagement.getUser(userId)
      email = user?.email ?? '(sin correo)'
    } catch (error) {
      print(`workos: usuario ${userId} NO SE LEYÓ — ${error?.message ?? error}; no se borra`)
      continue
    }
    print(`workos: usuario ${userId} <${email}> — borrando`)
    try {
      await workos.userManagement.deleteUser(userId)
      print(`workos: usuario ${userId} <${email}> borrado`)
    } catch (error) {
      print(`workos: usuario ${userId} <${email}> FALLÓ — ${error?.message ?? error}`)
    }
  }
  for (const organizationId of organizationIds) {
    try {
      await workos.organizations.deleteOrganization(organizationId)
      print(`workos: organización ${organizationId} borrada`)
    } catch (error) {
      print(`workos: organización ${organizationId} FALLÓ — ${error?.message ?? error}`)
    }
  }
  return 'DONE'
}

function resolveOperatorProfileId(target, options) {
  if (options.operatorProfileId) return options.operatorProfileId
  const listing = runConvexFunction(target, 'operatorPurge:listAdminOperators', {})
  const operators = listing?.operators ?? []
  if (options.operatorEmail) {
    const found = operators.find((row) => row.email === options.operatorEmail)
    if (!found) {
      throw new OperatorCliError(
        `--operator-email ${options.operatorEmail} no es un perfil ADMIN activo. Disponibles: ` +
          operators.map((row) => row.email).join(', '),
        EXIT_REFUSED
      )
    }
    return found.profileId
  }
  throw new OperatorCliError(
    'falta --operator-email (o --operator-profile-id). Perfiles ADMIN activos: ' +
      (operators.map((row) => `${row.email} → ${row.profileId}`).join(' · ') || '(ninguno)'),
    EXIT_REFUSED
  )
}

async function main() {
  const options = orFail(() => parseArgs(process.argv.slice(2)))
  const workosKey = resolveWorkosApiKey(options.target)

  // El destino se imprime ANTES de leer o escribir una sola fila.
  const target = orFail(() => resolveDeployment({ deployment: options.target }))
  log(`deployment ${target.deployment}`)
  log(options.execute ? 'modo EXECUTE — esto BORRA' : 'modo DRY-RUN — no borra nada')

  const reason = options.reason ?? 'Purga de empresas de prueba (dry-run del operador).'
  const operatorProfileId = orFail(() => resolveOperatorProfileId(target, options))
  log(`operador ${operatorProfileId}`)

  const excluded = new Set(options.excludeCompanyIds)
  let queue = []

  if (options.seedSweep) {
    const report = orFail(() =>
      runConvexFunction(target, 'operatorPurge:listSeedSweepCandidates', {})
    )
    log(`dominios semilla: ${report.seedDomains.join(', ')}`)
    log(`empresas inspeccionadas: ${report.companies.length}${report.capped ? ' (techo)' : ''}`)
    for (const row of report.companies) printCandidate(row)

    const selected = report.companies.filter(
      (row) => row.selectable && !excluded.has(row.companyId)
    )
    orFail(() => assertSweepSelection(selected))
    log('')
    log(`seleccionadas ${selected.length} de ${report.companies.length}`)
    for (const row of selected) log(`  ${row.name}  ${row.companyId}`)
    for (const id of excluded) log(`  excluida a mano: ${id}`)
    log('')
    queue = selected.map((row) => ({ companyId: row.companyId, confirmName: row.name }))
  } else if (options.companyId) {
    queue = [{ companyId: options.companyId, confirmName: options.confirmName }]
  }

  const workosUserIds = []
  const workosOrganizationIds = []

  for (const item of queue) {
    const result = orFail(() =>
      runConvexFunction(target, 'operatorPurge:purgeCompany', {
        companyId: item.companyId,
        confirmName: item.confirmName,
        operatorProfileId,
        reason,
        execute: options.execute,
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      })
    )
    printInventory(result)
    for (const userId of result.workos?.userIds ?? []) workosUserIds.push(userId)
    if (result.workos?.organizationId) workosOrganizationIds.push(result.workos.organizationId)
    if (result.status === 'SCHEDULED') {
      log('    lote reagendado en Convex; vuelve a correr el script para ver el cierre')
    }
  }

  if (options.deactivateSeedUsers) {
    const result = orFail(() =>
      runConvexFunction(target, 'operatorPurge:deactivateSeedUsers', {
        emails: options.seedUserEmails,
        operatorProfileId,
        reason,
        execute: options.execute,
      })
    )
    log('usuarios semilla:')
    for (const row of result.users) log(`  ${row.action.padEnd(18)} ${row.email}`)
  }

  // Perfiles huérfanos con correo real: borrado completo, fila por fila, con el
  // inventario impreso antes. La mutation se niega si el correo es ADMIN, es el
  // operador o es dueño de una empresa (eso va por --company-id).
  for (const email of options.purgeUserEmails) {
    const result = orFail(() =>
      runConvexFunction(target, 'operatorPurge:purgeOrphanUser', {
        email,
        operatorProfileId,
        reason,
        execute: options.execute,
      })
    )
    log(`perfil ${email}: ${result.action}`)
    for (const blocker of result.blockers ?? []) log(`    se niega: ${blocker}`)
    for (const entry of result.tables ?? []) {
      log(`    ${entry.decision.padEnd(6)} ${entry.table}  ${entry.rows}`)
    }
    if (result.workosUserId) {
      log(`    workos   usuario ${result.workosUserId}`)
      if (options.execute) workosUserIds.push(result.workosUserId)
    } else {
      log('    workos   (sin usuario)')
    }
  }

  if (!options.execute) {
    log('')
    log('DRY-RUN terminado: nada se borró. Repite con --execute para ejecutar.')
    return
  }

  const workosOutcome = await deleteInWorkos({
    userIds: [...new Set(workosUserIds)],
    organizationIds: [...new Set(workosOrganizationIds)],
    apiKey: workosKey.apiKey,
    variable: workosKey.variable,
  })
  if (workosOutcome === 'MISSING_KEY') {
    // Convex ya quedó purgado y WorkOS no: un exit 0 lo escondería.
    process.exitCode = EXIT_REFUSED
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  try {
    await main()
  } finally {
    restoreEnvLocal()
  }
}
