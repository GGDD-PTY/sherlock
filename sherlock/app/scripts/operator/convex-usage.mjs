#!/usr/bin/env node
// ============================================================================
// USO CONVEX POR EMPRESA (operador)
// ============================================================================
// Imprime, por sala, documentos, versiones (vigentes / SUPERSEDED /
// QUARANTINED), MB de blobs por estado y las filas de bitácora que crecen con
// cada subida y cada lectura. Es el medidor del plan de pruning; no borra nada.
//
// Su única superficie Convex es `operatorUsage:getUsageByCompany`, `internalQuery`
// y por lo tanto solo alcanzable con la deploy key del deployment.
//
// Uso:
//   bun --cwd=sherlock/app run usage
//   bun --cwd=sherlock/app run usage -- --target prod
// ============================================================================

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
  EXIT_FAILED,
  EXIT_REFUSED,
  OperatorCliError,
  convexRun as runConvexFunction,
  resolveDeployment,
  restoreEnvLocal,
} from './convex-deployment.mjs'

const BYTES_PER_MB = 1024 * 1024

function log(message) {
  process.stdout.write(`[convex-usage] ${message}\n`)
}

function fail(message, code = EXIT_FAILED) {
  process.stderr.write(`[convex-usage] ${message}\n`)
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

function parseArgs(argv) {
  const options = { target: 'dev' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target') {
      options.target = argv[++index] ?? null
      continue
    }
    fail(`argumento desconocido: ${arg}`, EXIT_REFUSED)
  }
  if (options.target !== 'dev' && options.target !== 'prod') {
    fail('falta --target dev|prod', EXIT_REFUSED)
  }
  return options
}

function formatMb(bytes) {
  return (Number(bytes) / BYTES_PER_MB).toFixed(2)
}

function formatAge(log) {
  if (!log || log.count === 0 || log.oldestAgeDays === null || log.oldestAgeDays === undefined) {
    return '—'
  }
  return `${log.oldestAgeDays}d`
}

export function formatLogCount(log) {
  const count = log?.count ?? 0
  return log?.countCapped ? `${count}+` : String(count)
}

export function formatLog(name, log) {
  return `${name} ${formatLogCount(log)} (${formatAge(log)})`
}

/** Las notas del reporte son la única señal de lo que el medidor NO ve (los
 *  documentAccessLogs legacy sin companyId). Tragárselas deja al operador
 *  leyendo un total corto como si fuera completo. */
export function formatNotes(notes) {
  return (notes ?? []).map((note) => `nota: ${note}`)
}

function printCompany(row) {
  log(row.companyId ? `${row.name}  ${row.companyId}` : row.name)
  log(`  documentos ${row.documents}`)
  const quarantinedCurrent = row.versions?.currentQuarantined ?? 0
  const currentNote = quarantinedCurrent > 0 ? `  vigentes en cuarentena ${quarantinedCurrent}` : ''
  log(
    `  versiones  vigentes ${row.versions.current}${currentNote}  SUPERSEDED ${row.versions.superseded}  QUARANTINED ${row.versions.quarantined}`
  )
  log(
    `  MB blobs   vigentes ${formatMb(row.blobBytes.current)}  SUPERSEDED ${formatMb(row.blobBytes.superseded)}  QUARANTINED ${formatMb(row.blobBytes.quarantined)}  total ${formatMb(row.blobBytes.total)}`
  )
  log(
    `  ${formatLog('accessLogs', row.logs.documentAccessLogs)}  ${formatLog('vdrReadAudits', row.logs.vdrReadAudits)}  ${formatLog('teamAlerts', row.logs.teamAlerts)}  ${formatLog('adminAuditLogs', row.logs.adminAuditLogs)}`
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = orFail(() => resolveDeployment({ deployment: options.target }))
  log(`deployment ${target.deployment}`)

  const report = orFail(() => runConvexFunction(target, 'operatorUsage:getUsageByCompany', {}))
  if (!report || !Array.isArray(report.companies) || !report.total) {
    fail('operatorUsage:getUsageByCompany no devolvió el reporte')
  }

  log(`generatedAt ${new Date(report.generatedAt).toISOString()}`)
  log('')

  for (const company of report.companies) {
    printCompany(company)
    log('')
  }

  printCompany({
    name: `TOTAL  ${report.total.companies} empresas`,
    companyId: '',
    documents: report.total.documents,
    versions: report.total.versions,
    blobBytes: report.total.blobBytes,
    logs: report.total.logs,
  })
  const unattributed = report.total.unattributed
  if (unattributed?.adminAuditLogs || unattributed?.teamAlerts) {
    log(
      `  no atribuidos  ${formatLog('adminAuditLogs', unattributed.adminAuditLogs)}  ${formatLog('teamAlerts', unattributed.teamAlerts)}`
    )
  }
  for (const line of formatNotes(report.notes)) {
    log(line)
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
