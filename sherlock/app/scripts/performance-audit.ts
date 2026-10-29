#!/usr/bin/env bun

// ============================================================================
// PERFORMANCE AUDIT SCRIPT
// ============================================================================
// Generates a comprehensive performance report including:
// - Bundle size analysis
// - Lighthouse metrics
// - Web Vitals comparison
// - Recommendations
//
// Los dos procesos externos (`ls` sobre el build y el CLI de Lighthouse) pasan
// por `externalCall`, así que el fallo llega tipado y con cota de tiempo en vez
// de como `execSync` que tira. El JSON de Lighthouse y el reporte anterior se
// decodifican con `Schema`: antes entraban por `JSON.parse` a un `any` y
// `report?.audits` podía ser cualquier cosa. Los dos archivos se escriben con
// `acquireRelease`, que cierra el descriptor pase lo que pase.
// ============================================================================

import { exec } from 'node:child_process'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { Duration, Effect, Schema } from 'effect'

import type { ExternalServiceError } from '@/lib/effect/errors'
import { decodeBoundary, externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

interface BundleStats {
  timestamp: string
  chunks: Array<{
    name: string
    size: number
    sizeHuman: string
  }>
  totalSize: number
  totalSizeHuman: string
}

interface PerformanceMetrics {
  lcp: number // Largest Contentful Paint (ms)
  fcp: number // First Contentful Paint (ms)
  tti: number // Time to Interactive (ms)
  tbt: number // Total Blocking Time (ms)
  cls: number // Cumulative Layout Shift (score)
  speedIndex: number // Speed Index (ms)
}

interface AuditReport {
  timestamp: string
  bundleStats: BundleStats
  performanceMetrics: PerformanceMetrics | null
  performanceMetricsSource: 'lighthouse' | 'unavailable'
  comparison?: {
    bundleSizeDiff: number
    bundleSizePercent: number
  }
  recommendations: string[]
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const OUTPUT_DIR = join(process.cwd(), 'performance-reports')
const PREVIOUS_REPORT_PATH = join(OUTPUT_DIR, 'latest.json')
const LIGHTHOUSE_BASE_URL = process.env.PERF_AUDIT_BASE_URL
const TARGETS = {
  lcp: 2500,
  fcp: 1800,
  tti: 3800,
  tbt: 300,
  cls: 0.1,
  mainBundle: 200 * 1024, // 200KB
}

// Lighthouse arranca Chrome y navega la página: minutos, no segundos.
const COMMAND_TIMEOUT = Duration.minutes(10)

class PerformanceAuditError extends Schema.TaggedError<PerformanceAuditError>()(
  'PerformanceAuditError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

const LighthouseReportSchema = Schema.StructWithRest(
  Schema.Struct({
    audits: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.StructWithRest(Schema.Struct({ numericValue: Schema.optionalKey(Schema.Unknown) }), [
          JsonRecordSchema,
        ])
      )
    ),
  }),
  [JsonRecordSchema]
)

const PreviousReportSchema = Schema.StructWithRest(
  Schema.Struct({
    bundleStats: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ totalSize: Schema.Finite }), [JsonRecordSchema])
    ),
  }),
  [JsonRecordSchema]
)

// ============================================================================
// UTILITIES
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

type ShellResult = { stdout: string; stderr: string }

function runShell(command: string, signal: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: 'utf-8', signal }, (error, stdout, stderr) => {
      // `exec` no cuelga el stderr del error; `execCommand` lo necesita para
      // reproducir el stderr heredado que emitía la versión síncrona.
      if (error) reject(Object.assign(error, { stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * Igual que el `execSync` que había: el stderr del comando sale por el stderr
 * del proceso, y un fallo se reporta y devuelve texto vacío.
 */
const execCommand = Effect.fn('performanceAudit.execCommand')(function* (
  command: string
): Effect.fn.Return<string> {
  const outcome = yield* externalCall({
    service: 'shell',
    operation: command.split(' ')[0] ?? 'exec',
    run: (signal) => runShell(command, signal),
    timeout: COMMAND_TIMEOUT,
    retries: 0,
  }).pipe(
    Effect.match({
      onSuccess: (result: ShellResult) => ({ ok: true as const, result }),
      onFailure: (error: ExternalServiceError) => ({ ok: false as const, error }),
    })
  )

  if (outcome.ok) {
    if (outcome.result.stderr) process.stderr.write(outcome.result.stderr)
    return outcome.result.stdout
  }

  const stderr = (outcome.error.cause as { stderr?: unknown } | undefined)?.stderr
  if (typeof stderr === 'string' && stderr) process.stderr.write(stderr)
  console.error(`Error executing command: ${command}`)
  console.error(outcome.error.message)
  return ''
})

const pathExists = Effect.fn('performanceAudit.pathExists')(function* (
  path: string
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise(() => stat(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
})

/** El descriptor se cierra por scope, pase lo que pase con la escritura. */
const writeReport = Effect.fn('performanceAudit.writeReport')(function* (
  filePath: string,
  body: string
): Effect.fn.Return<void, PerformanceAuditError> {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.promise(() => open(filePath, 'w')),
        (file) => Effect.promise(() => file.close())
      )
      yield* Effect.promise(() => handle.writeFile(body, 'utf8'))
    })
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(new PerformanceAuditError({ message: `Could not write ${filePath}`, cause }))
    )
  )
})

// ============================================================================
// BUNDLE ANALYSIS
// ============================================================================

const analyzeBundleSize = Effect.fn('performanceAudit.analyzeBundleSize')(
  function* (): Effect.fn.Return<BundleStats, PerformanceAuditError> {
    console.log('\n📦 Analyzing bundle size...')

    const nextDir = join(process.cwd(), '.next', 'static', 'chunks')

    if (!(yield* pathExists(nextDir))) {
      return yield* Effect.fail(
        new PerformanceAuditError({
          message: ".next directory not found. Run 'bun run build' first.",
        })
      )
    }

    // Get all JS chunks
    const lsOutput = yield* execCommand(`ls -l ${nextDir}/*.js 2>/dev/null`)

    const chunks = lsOutput
      .split('\n')
      .filter((line) => line.includes('.js'))
      .map((line) => {
        const parts = line.split(/\s+/)
        const size = parseInt(parts[4], 10)
        const name = parts[8].split('/').pop() ?? 'unknown'
        return {
          name,
          size,
          sizeHuman: formatBytes(size),
        }
      })
      .sort((a, b) => b.size - a.size)

    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0)

    return {
      timestamp: new Date().toISOString(),
      chunks,
      totalSize,
      totalSizeHuman: formatBytes(totalSize),
    }
  }
)

// ============================================================================
// LIGHTHOUSE AUDIT
// ============================================================================

const runLighthouseAudit = Effect.fn('performanceAudit.runLighthouseAudit')(
  function* (): Effect.fn.Return<{
    metrics: PerformanceMetrics | null
    source: 'lighthouse' | 'unavailable'
  }> {
    console.log('\n🔍 Running Lighthouse audit...')

    if (!LIGHTHOUSE_BASE_URL) {
      console.log('⚠️  PERF_AUDIT_BASE_URL not set. Skipping Lighthouse metrics.')
      return { metrics: null, source: 'unavailable' }
    }

    const command = [
      'lighthouse',
      LIGHTHOUSE_BASE_URL,
      '--quiet',
      '--chrome-flags="--headless=new"',
      '--output=json',
      '--output-path=stdout',
      '--only-categories=performance',
    ].join(' ')

    const output = yield* execCommand(command)
    if (!output) {
      console.log('⚠️  Lighthouse CLI unavailable or failed. Skipping metrics.')
      return { metrics: null, source: 'unavailable' }
    }

    const parsed = yield* Effect.try(() => JSON.parse(output) as unknown).pipe(
      Effect.match({
        onSuccess: (value: unknown) => ({ parsed: true as const, value }),
        onFailure: () => ({ parsed: false as const, value: null }),
      })
    )
    if (!parsed.parsed) {
      console.log('⚠️  Could not parse Lighthouse JSON output. Skipping metrics.')
      return { metrics: null, source: 'unavailable' }
    }

    // Un reporte con otra forma no aporta métricas: cae al mismo camino que un
    // reporte sin ellas.
    const report = yield* decodeBoundary(
      'lighthouseReport',
      LighthouseReportSchema,
      parsed.value
    ).pipe(Effect.orElseSucceed(() => null))
    const audits = report?.audits ?? {}
    const metrics: PerformanceMetrics = {
      lcp: Number(audits['largest-contentful-paint']?.numericValue ?? 0),
      fcp: Number(audits['first-contentful-paint']?.numericValue ?? 0),
      tti: Number(audits['interactive']?.numericValue ?? 0),
      tbt: Number(audits['total-blocking-time']?.numericValue ?? 0),
      cls: Number(audits['cumulative-layout-shift']?.numericValue ?? 0),
      speedIndex: Number(audits['speed-index']?.numericValue ?? 0),
    }

    const hasInvalidMetric = Object.entries(metrics).some(
      ([key, value]) =>
        !Number.isFinite(value) || value < 0 || (key.toUpperCase() !== 'CLS' && value <= 0)
    )
    if (hasInvalidMetric) {
      console.log('⚠️  Lighthouse report missing required metrics. Skipping.')
      return { metrics: null, source: 'unavailable' }
    }

    return { metrics, source: 'lighthouse' }
  }
)

function compareWithPrevious(current: BundleStats, previousTotalSize: number | undefined) {
  if (previousTotalSize === undefined) return undefined

  const bundleSizeDiff = current.totalSize - previousTotalSize
  const bundleSizePercent = previousTotalSize > 0 ? (bundleSizeDiff / previousTotalSize) * 100 : 0
  const bundleSizePercentFormatted = bundleSizePercent.toFixed(2)

  console.log('\n📊 Comparison with previous audit:')
  console.log(
    `Bundle size: ${current.totalSizeHuman} (${bundleSizeDiff > 0 ? '+' : ''}${formatBytes(bundleSizeDiff)} / ${bundleSizePercentFormatted}%)`
  )

  return {
    bundleSizeDiff,
    bundleSizePercent,
  }
}

// ============================================================================
// RECOMMENDATIONS
// ============================================================================

function generateRecommendations(
  bundleStats: BundleStats,
  metrics: PerformanceMetrics | null
): string[] {
  const recommendations: string[] = []

  // Bundle size recommendations
  const largeChunks = bundleStats.chunks.filter((c) => c.size > TARGETS.mainBundle)
  if (largeChunks.length > 0) {
    recommendations.push(`⚠️ ${largeChunks.length} chunk(s) exceed 200KB target. Consider:`)
    largeChunks.slice(0, 3).forEach((chunk) => {
      recommendations.push(`   - ${chunk.name}: ${chunk.sizeHuman}`)
    })
    recommendations.push('   → Use dynamic imports for heavy components')
    recommendations.push('   → Enable tree-shaking for large dependencies')
  }

  if (metrics) {
    if (metrics.lcp > TARGETS.lcp) {
      recommendations.push(`⚠️ LCP (${metrics.lcp}ms) exceeds target (${TARGETS.lcp}ms)`)
      recommendations.push('   → Optimize hero images with priority loading')
      recommendations.push('   → Reduce server response time')
      recommendations.push('   → Eliminate render-blocking resources')
    }

    if (metrics.fcp > TARGETS.fcp) {
      recommendations.push(`⚠️ FCP (${metrics.fcp}ms) exceeds target (${TARGETS.fcp}ms)`)
      recommendations.push('   → Minimize CSS and JavaScript')
      recommendations.push('   → Remove unused CSS')
      recommendations.push('   → Defer non-critical CSS')
    }

    if (metrics.tti > TARGETS.tti) {
      recommendations.push(`⚠️ TTI (${metrics.tti}ms) exceeds target (${TARGETS.tti}ms)`)
      recommendations.push('   → Reduce JavaScript execution time')
      recommendations.push('   → Split code and defer unused JS')
      recommendations.push('   → Implement progressive hydration')
    }

    if (metrics.tbt > TARGETS.tbt) {
      recommendations.push(`⚠️ TBT (${metrics.tbt}ms) exceeds target (${TARGETS.tbt}ms)`)
      recommendations.push('   → Break up long tasks (>50ms)')
      recommendations.push('   → Use web workers for heavy computations')
    }
  } else {
    recommendations.push(
      'ℹ️ Lighthouse metrics unavailable. Set PERF_AUDIT_BASE_URL and install `lighthouse` CLI for real Web Vitals.'
    )
  }

  // Success message if all targets met
  if (recommendations.length === 0) {
    recommendations.push('✅ All performance targets met!')
  }

  return recommendations
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

const previousTotalSize = Effect.fn('performanceAudit.previousTotalSize')(
  function* (): Effect.fn.Return<number | undefined> {
    if (!(yield* pathExists(PREVIOUS_REPORT_PATH))) return undefined

    const parsed = yield* Effect.tryPromise(() => readFile(PREVIOUS_REPORT_PATH, 'utf-8')).pipe(
      Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as unknown)),
      Effect.match({
        onSuccess: (value: unknown) => ({ ok: true as const, value }),
        onFailure: () => ({ ok: false as const, value: null }),
      })
    )
    if (!parsed.ok) {
      console.warn('Could not load previous report')
      return undefined
    }

    const previous = yield* decodeBoundary(
      'previousAuditReport',
      PreviousReportSchema,
      parsed.value
    ).pipe(Effect.orElseSucceed(() => null))
    return previous?.bundleStats?.totalSize
  }
)

const generateReport = Effect.fn('performanceAudit.generateReport')(function* (): Effect.fn.Return<
  AuditReport,
  PerformanceAuditError
> {
  const bundleStats = yield* analyzeBundleSize()
  const lighthouse = yield* runLighthouseAudit()

  // Load previous report if exists
  const comparison = compareWithPrevious(bundleStats, yield* previousTotalSize())
  const recommendations = generateRecommendations(bundleStats, lighthouse.metrics)

  return {
    timestamp: new Date().toISOString(),
    bundleStats,
    performanceMetrics: lighthouse.metrics,
    performanceMetricsSource: lighthouse.source,
    comparison,
    recommendations,
  }
})

// ============================================================================
// MAIN
// ============================================================================

const main = Effect.fn('performanceAudit.main')(function* (): Effect.fn.Return<
  void,
  PerformanceAuditError
> {
  console.log('🚀 Sherlock Performance Audit')
  console.log('================================\n')

  // Ensure output directory exists
  if (!(yield* pathExists(OUTPUT_DIR))) {
    yield* Effect.tryPromise({
      try: () => mkdir(OUTPUT_DIR, { recursive: true }),
      catch: (cause) =>
        new PerformanceAuditError({ message: `Could not create ${OUTPUT_DIR}`, cause }),
    })
  }

  // Generate report
  const report = yield* generateReport()

  // Save report
  const reportPath = join(OUTPUT_DIR, `audit-${Date.now()}.json`)
  const body = JSON.stringify(report, null, 2)
  yield* writeReport(reportPath, body)
  yield* writeReport(PREVIOUS_REPORT_PATH, body)

  // Print summary
  console.log('\n📈 Performance Summary:')
  console.log('================================')
  console.log(`Total bundle size: ${report.bundleStats.totalSizeHuman}`)
  console.log(`Largest chunk: ${report.bundleStats.chunks[0].sizeHuman}`)
  console.log(`\nWeb Vitals source: ${report.performanceMetricsSource}`)
  if (report.performanceMetrics) {
    console.log(`  LCP: ${report.performanceMetrics.lcp}ms`)
    console.log(`  FCP: ${report.performanceMetrics.fcp}ms`)
    console.log(`  TTI: ${report.performanceMetrics.tti}ms`)
    console.log(`  TBT: ${report.performanceMetrics.tbt}ms`)
    console.log(`  CLS: ${report.performanceMetrics.cls}`)
  }

  console.log('\n💡 Recommendations:')
  console.log('================================')
  report.recommendations.forEach((rec) => console.log(rec))

  console.log(`\n✅ Report saved to: ${reportPath}`)
  console.log(`📊 View full report: cat ${reportPath} | bunx jq`)
})

void runServerEffect(
  main().pipe(
    Effect.catchTag('PerformanceAuditError', (error) =>
      Effect.sync(() => {
        console.error(error.message)
        process.exitCode = 1
      })
    )
  )
)
