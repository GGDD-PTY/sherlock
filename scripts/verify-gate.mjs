#!/usr/bin/env bun

// verify:gate — el gate artesanal ([F] 2026-09-04 20:11).
//
// Corre localmente, con el mismo entorno, EXACTAMENTE los pasos `run:`
// del job `pr-gate` de `.github/workflows/ci.yml`. El YAML es la única fuente de
// verdad: no hay una segunda lista de comandos que pueda desviarse del gate de la
// nube. Instala dependencias primero y corre los checks restantes en paralelo.
// Deja un recibo JSON en `~/Developer/sherlock-handoffs/verify-receipts/`
// (verde o rojo) con SHA, pasos, duraciones y versiones de bun/node.
// Exige un commit limpio al iniciar, entre pasos y al terminar. El YAML se lee
// desde ese commit; el recibo incluye el estado Git inicial y final.
//
// Uso (desde el ROOT):
//   bun run verify:gate            # corre el gate y escribe el recibo
//   bun run verify:gate -- --list  # solo lista los pasos que correría

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCommittedRepository, readRepositoryState } from './verify-gate-repository.mjs'
import { runGateCommand } from './verify-gate-command.mjs'
import { executeGateSteps } from './verify-gate-execution.mjs'
import {
  assertRuntimeVersions,
  gateRuntimeEnvironment,
  parseRuntimePins,
} from './verify-gate-runtime.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_PATH = '.github/workflows/ci.yml'
const JOB_ID = 'verify'
const RECEIPTS_DIR = path.join(REPO_ROOT, '.artifacts', 'verify-receipts')

// `yaml` vive en sherlock/app; el root no tiene node_modules propio.
const requireFromApp = createRequire(path.join(REPO_ROOT, 'sherlock/app/package.json'))
const { parse } = requireFromApp('yaml')

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyEnv(env) {
  const out = {}
  if (!isRecord(env)) return out
  for (const [key, value] of Object.entries(env)) out[key] = String(value)
  return out
}

// Sustituye `${{ env.NAME }}` con el valor del bloque `env:` del workflow.
function renderExpressions(command, workflowEnv) {
  return command.replace(
    /\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}/g,
    (_match, name) => workflowEnv[name] ?? ''
  )
}

function loadGateSteps(source) {
  const workflow = parse(source)
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs[JOB_ID])) {
    throw new Error(`${WORKFLOW_PATH} no define el job ${JOB_ID}`)
  }
  const job = workflow.jobs[JOB_ID]
  const workflowEnv = stringifyEnv(workflow.env)
  const steps = Array.isArray(job.steps) ? job.steps : []
  const runnable = steps
    .filter((step) => isRecord(step) && typeof step.run === 'string')
    .map((step) => ({
      name: typeof step.name === 'string' ? step.name : step.run.split('\n')[0],
      command: renderExpressions(step.run.trim(), workflowEnv),
      env: { ...workflowEnv, ...stringifyEnv(job.env), ...stringifyEnv(step.env) },
    }))
  if (runnable.length === 0)
    throw new Error(`${WORKFLOW_PATH}: el job ${JOB_ID} no tiene pasos run:`)
  return runnable
}

function capture(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${command} ${args.join(' ')} salió con ${code}`))
    })
  })
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
    : `${seconds}s`
}

function receiptTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

async function writeReceipt(receipt) {
  await mkdir(RECEIPTS_DIR, { recursive: true })
  const filename = `verify-gate-${receiptTimestamp(receipt.finishedAt)}-${receipt.gitSha.slice(0, 12)}.json`
  const destination = path.join(RECEIPTS_DIR, filename)
  const temporary = `${destination}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await rename(temporary, destination)
  return destination
}

function printResults(results) {
  console.log('')
  for (const step of results) {
    const mark = step.status === 'pass' ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${formatDuration(step.durationMs).padStart(7)}  ${step.name}`)
  }
}

async function main() {
  const listOnly = process.argv.includes('--list')

  if (listOnly) {
    const steps = loadGateSteps(await readFile(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8'))
    console.log(`verify:gate — ${steps.length} pasos de ${WORKFLOW_PATH} (job ${JOB_ID}):`)
    for (const [index, step] of steps.entries()) {
      console.log(`\n[${index + 1}/${steps.length}] ${step.name}\n${step.command}`)
    }
    return
  }

  const startedAt = new Date().toISOString()
  const started = performance.now()
  const initialRepository = await readRepositoryState(REPO_ROOT)
  const gitSha = initialRepository.gitSha
  let workflowBlob = null
  let runtimePins = null
  const runtimes = {
    bun: process.versions.bun ?? 'unknown',
    node: 'unknown',
  }
  const results = []
  let failure = null

  try {
    assertCommittedRepository(initialRepository, gitSha)
    runtimePins = parseRuntimePins(
      await capture('git', ['show', `${gitSha}:sherlock/app/.nvmrc`]),
      await capture('git', ['show', `${gitSha}:package.json`])
    )
    const nodeInstall = await capture('mise', ['where', `node@${runtimePins.node}`])
    const commandEnvironment = gateRuntimeEnvironment(process.env, process.execPath, nodeInstall)
    runtimes.node = (await capture('node', ['--version'], commandEnvironment)).replace(/^v/, '')
    assertRuntimeVersions(runtimes, runtimePins)
    assertRuntimeVersions(
      { ...runtimes, bun: await capture('bun', ['--version'], commandEnvironment) },
      runtimePins
    )
    console.log(`verify:gate ${gitSha} (bun ${runtimes.bun}, node ${runtimes.node})`)
    workflowBlob = await capture('git', ['rev-parse', `${gitSha}:${WORKFLOW_PATH}`])
    const source = await capture('git', ['show', `${gitSha}:${WORKFLOW_PATH}`])
    const steps = loadGateSteps(source)

    const logDirectory = path.join(
      RECEIPTS_DIR,
      `verify-gate-${receiptTimestamp(startedAt)}-${gitSha.slice(0, 12)}-${process.pid}-logs`
    )
    await mkdir(logDirectory, { recursive: true })
    results.push(
      ...(await executeGateSteps(steps, {
        checkRepository: async () =>
          assertCommittedRepository(await readRepositoryState(REPO_ROOT), gitSha),
        run: async (step, index) => {
          const logPath = path.join(logDirectory, `${String(index + 1).padStart(2, '0')}.log`)
          const exitCode = await runGateCommand(
            step.command,
            gateRuntimeEnvironment({ ...process.env, ...step.env }, process.execPath, nodeInstall),
            REPO_ROOT,
            logPath
          )
          return { exitCode, logPath }
        },
        report: (event, result) => {
          console.log(
            `[${result.index}/${steps.length}] ${event === 'start' ? 'START' : result.status.toUpperCase()} ${result.name}`
          )
          if (result.logPath) console.log(`Log: ${result.logPath}`)
        },
      }))
    )
    const failed = results.filter((result) => result.status === 'fail')
    if (failed.length)
      failure = failed
        .map((result) => `${result.name}: ${result.failure ?? `salió con ${result.exitCode}`}`)
        .join('; ')
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  let finalRepository = null
  try {
    finalRepository = await readRepositoryState(REPO_ROOT)
    assertCommittedRepository(finalRepository, gitSha)
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error)
  }

  const finishedAt = new Date().toISOString()
  const receipt = {
    schemaVersion: 1,
    kind: 'verify-gate',
    source: { workflow: WORKFLOW_PATH, job: JOB_ID, blob: workflowBlob },
    status: failure ? 'fail' : 'pass',
    failure,
    startedAt,
    finishedAt,
    gitSha,
    repository: { initial: initialRepository, final: finalRepository },
    runtimes,
    runtimePins,
    totalDurationMs: Math.round(performance.now() - started),
    steps: results,
  }
  const receiptPath = await writeReceipt(receipt)

  printResults(results)
  console.log(`\n${failure ? 'FAIL' : 'PASS'} ${formatDuration(receipt.totalDurationMs)} ${gitSha}`)
  console.log(`Receipt: ${receiptPath}`)
  if (failure) {
    console.error(`\nverify:gate failed: ${failure}`)
    process.exitCode = 1
  }
}

try {
  await main()
} catch (error) {
  console.error(`\nverify:gate failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
