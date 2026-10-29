// ============================================================================
// E2E — REPORTE DE CONFIABILIDAD
// ============================================================================
// Lee el JSON del reporter de Playwright y el JSONL del logger de
// confiabilidad, y computa el gate de SLO. Ninguno de los dos formatos lo
// controla este repo: las dos entradas se decodifican con `Schema` en vez de
// castearse con `as`, así que un campo con la forma equivocada cuenta 0 en vez
// de colarse como número. El resumen se escribe con `acquireRelease`, que
// cierra el descriptor aunque la escritura falle.
// ============================================================================

import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

import { Effect, Schema } from 'effect'

import { decodeBoundary } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

type PlaywrightStats = {
  expected: number
  unexpected: number
  flaky: number
  skipped: number
  duration_ms?: number
}

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

// Solo se decodifica `stats`: el resto del reporte es el árbol de suites, que
// el camino de respaldo recorre tal cual.
const PlaywrightReportSchema = Schema.StructWithRest(
  Schema.Struct({ stats: Schema.optionalKey(JsonRecordSchema) }),
  [JsonRecordSchema]
)

// Un evento sin nombre no es un evento (el filtro histórico ya lo descartaba);
// el resto de las claves que escriba el logger pasan sin tocarse.
const ReliabilityEventSchema = Schema.StructWithRest(
  Schema.Struct({
    event: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    level: Schema.String,
    run_id: Schema.optionalKey(Schema.String),
  }),
  [JsonRecordSchema]
)

type ReliabilityEvent = typeof ReliabilityEventSchema.Type

/** Lee JSON de disco sin opinar sobre su forma: null si no hay o no parsea. */
const readJsonFile = Effect.fn('e2eReliability.readJsonFile')(function* (filePath: string) {
  const raw = yield* Effect.tryPromise(() => readFile(filePath, 'utf8')).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (raw === null) return null
  return yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(Effect.orElseSucceed(() => null))
})

/** Un contador del reporter solo cuenta si es un número finito. */
const statCount = Effect.fn('e2eReliability.statCount')(function* (
  stats: Record<string, unknown>,
  key: string
) {
  return yield* decodeBoundary(`playwrightReport.stats.${key}`, Schema.Finite, stats[key]).pipe(
    Effect.orElseSucceed(() => 0)
  )
})

/** Respaldo para payloads de reporter alternos: cuenta `outcome` en el árbol. */
function countOutcomes(report: unknown): PlaywrightStats {
  const counters = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }
  const queue: unknown[] = [report]

  while (queue.length > 0) {
    const node = queue.pop()
    if (!node || typeof node !== 'object') continue
    const value = node as Record<string, unknown>

    const outcome = value.outcome
    if (typeof outcome === 'string') {
      if (outcome in counters) {
        counters[outcome as keyof typeof counters] += 1
      }
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) queue.push(item)
      } else if (child && typeof child === 'object') {
        queue.push(child)
      }
    }
  }

  return counters
}

const parsePlaywrightStats = Effect.fn('e2eReliability.parsePlaywrightStats')(function* (
  report: unknown
): Effect.fn.Return<PlaywrightStats> {
  if (!report) {
    return { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }
  }

  const decoded = yield* decodeBoundary('playwrightReport', PlaywrightReportSchema, report).pipe(
    Effect.orElseSucceed(() => null)
  )
  const stats = decoded?.stats ?? {}
  const fromStats: PlaywrightStats = {
    expected: yield* statCount(stats, 'expected'),
    unexpected: yield* statCount(stats, 'unexpected'),
    flaky: yield* statCount(stats, 'flaky'),
    skipped: yield* statCount(stats, 'skipped'),
    duration_ms: yield* statCount(stats, 'duration'),
  }

  if (fromStats.expected + fromStats.unexpected + fromStats.flaky + fromStats.skipped > 0) {
    return fromStats
  }

  return countOutcomes(report)
})

const readReliabilityEvents = Effect.fn('e2eReliability.readEvents')(function* (
  filePath: string
): Effect.fn.Return<ReliabilityEvent[]> {
  const raw = yield* Effect.tryPromise(() => readFile(filePath, 'utf8')).pipe(
    Effect.orElseSucceed(() => null)
  )
  const content = raw?.trim() ?? ''
  if (!content) return []

  // Una línea que no parsea invalida el archivo entero: un JSONL cortado a la
  // mitad no describe una corrida.
  const lines = yield* Effect.forEach(content.split('\n'), (line) =>
    Effect.try(() => JSON.parse(line) as unknown)
  ).pipe(Effect.orElseSucceed(() => null))
  if (lines === null) return []

  const decoded = yield* Effect.forEach(lines, (line) =>
    decodeBoundary('reliabilityEvent', ReliabilityEventSchema, line).pipe(
      Effect.map((event): ReliabilityEvent | null => event),
      Effect.orElseSucceed(() => null)
    )
  )
  return decoded.filter((event): event is ReliabilityEvent => event !== null)
})

function incrementCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** El descriptor se cierra por scope, pase lo que pase con la escritura. */
const writeSummary = Effect.fn('e2eReliability.writeSummary')(function* (
  filePath: string,
  body: string
) {
  yield* Effect.promise(() => mkdir(path.dirname(filePath), { recursive: true }))
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.promise(() => open(filePath, 'w')),
        (file) => Effect.promise(() => file.close())
      )
      yield* Effect.promise(() => handle.writeFile(body, 'utf8'))
    })
  )
})

const main = Effect.fn('e2eReliability.main')(function* () {
  const playwrightJsonPath = process.env.PLAYWRIGHT_RESULTS_JSON_PATH
    ? path.resolve(process.env.PLAYWRIGHT_RESULTS_JSON_PATH)
    : path.resolve('test-results/playwright/results.json')

  const reliabilityEventsPath = process.env.E2E_RELIABILITY_LOG_FILE
    ? path.resolve(process.env.E2E_RELIABILITY_LOG_FILE)
    : path.resolve('test-results/reliability/events.jsonl')

  const outputPath = process.env.E2E_RELIABILITY_SUMMARY_PATH
    ? path.resolve(process.env.E2E_RELIABILITY_SUMMARY_PATH)
    : path.resolve('test-results/reliability/summary.json')

  const sloTarget = Number(process.env.E2E_RELIABILITY_SLO_TARGET ?? '0.95')

  const playwrightReport = yield* readJsonFile(playwrightJsonPath)
  const stats = yield* parsePlaywrightStats(playwrightReport)
  const events = yield* readReliabilityEvents(reliabilityEventsPath)

  const executed = stats.expected + stats.unexpected + stats.flaky
  const stablePassRate = executed > 0 ? stats.expected / executed : 0

  const byEvent: Record<string, number> = {}
  const byLevel: Record<string, number> = {}
  const rootCauses: Record<string, number> = {}

  for (const event of events) {
    incrementCount(byEvent, event.event)
    incrementCount(byLevel, event.level)
    if (event.level === 'error' || event.level === 'warn') {
      incrementCount(rootCauses, event.event)
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    run_id:
      process.env.E2E_RELIABILITY_RUN_ID ??
      events[0]?.run_id ??
      `local-${new Date().toISOString()}-${process.pid}`,
    slo_target: sloTarget,
    metrics: {
      tests: {
        expected: stats.expected,
        unexpected: stats.unexpected,
        flaky: stats.flaky,
        skipped: stats.skipped,
        executed,
        stable_pass_rate: Number(stablePassRate.toFixed(4)),
        meets_slo: stablePassRate >= sloTarget,
        duration_ms: stats.duration_ms ?? null,
      },
      reliability_events: {
        total: events.length,
        by_level: byLevel,
        by_event: byEvent,
      },
      root_causes: Object.entries(rootCauses)
        .sort((a, b) => b[1] - a[1])
        .map(([event, count]) => ({ event, count })),
    },
  }

  yield* writeSummary(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

  const percent = (stablePassRate * 100).toFixed(2)
  const gate = stablePassRate >= sloTarget ? 'PASS' : 'FAIL'
  console.log(`[e2e-reliability] SLO gate: ${gate}`)
  console.log(
    `[e2e-reliability] Stable pass rate: ${percent}% (target ${(sloTarget * 100).toFixed(2)}%)`
  )
  console.log(`[e2e-reliability] Summary: ${outputPath}`)

  if (gate === 'FAIL') {
    // Enforced by default: a computed FAIL exits non-zero so CI goes red instead
    // of a mute green. Set E2E_RELIABILITY_ENFORCE_SLO=false to run advisory
    // (e.g. flaky-triage days) — the FAIL still surfaces as a GitHub annotation.
    const enforce = process.env.E2E_RELIABILITY_ENFORCE_SLO !== 'false'
    const message = `E2E reliability SLO gate FAIL: stable pass rate ${percent}% < target ${(sloTarget * 100).toFixed(2)}%`
    if (enforce) {
      console.error(`::error title=E2E reliability SLO::${message}`)
      process.exitCode = 1
    } else {
      console.warn(
        `::warning title=E2E reliability SLO (advisory)::${message} — E2E_RELIABILITY_ENFORCE_SLO=false, not failing the job`
      )
    }
  }
})

void runServerEffect(main())
