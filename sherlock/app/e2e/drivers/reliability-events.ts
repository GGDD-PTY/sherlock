import fs from 'fs'
import path from 'path'

export type ReliabilityEventLevel = 'debug' | 'info' | 'warn' | 'error'

interface ReliabilityEventRecord {
  ts: string
  run_id: string
  level: ReliabilityEventLevel
  event: string
  driver: string
  data?: Record<string, unknown>
}

const RELIABILITY_LOG_ENV = 'E2E_RELIABILITY_LOG_FILE'
const RELIABILITY_LOG_ENABLED_ENV = 'E2E_RELIABILITY_LOG_ENABLED'
const DEFAULT_LOG_FILE = path.join(process.cwd(), 'test-results', 'reliability', 'events.jsonl')

function isLoggingEnabled(): boolean {
  return process.env[RELIABILITY_LOG_ENABLED_ENV] !== 'false'
}

function getRunId(): string {
  if (process.env.E2E_RELIABILITY_RUN_ID) {
    return process.env.E2E_RELIABILITY_RUN_ID
  }

  if (process.env.GITHUB_RUN_ID) {
    return `gh-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
  }

  return `local-${new Date().toISOString()}-${process.pid}`
}

function getReliabilityLogFilePath(): string {
  return process.env[RELIABILITY_LOG_ENV] || DEFAULT_LOG_FILE
}

export function emitReliabilityEvent(
  event: string,
  level: ReliabilityEventLevel,
  data?: Record<string, unknown>
): void {
  if (!isLoggingEnabled()) {
    return
  }

  const payload: ReliabilityEventRecord = {
    ts: new Date().toISOString(),
    run_id: getRunId(),
    level,
    event,
    driver: process.env.E2E_DRIVER ?? 'playwright',
    data,
  }

  const destination = getReliabilityLogFilePath()

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.appendFileSync(destination, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch (error) {
    // Never fail the browser run because telemetry couldn't be written.
    console.warn(
      `[e2e-reliability] failed to write event "${event}" to ${destination}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
