// NOTE (tier b, 2026-07-24): this route used to also ping the 8 analysis/data
// Python microservices via src/config/api-services.ts.
// Those services no longer live in this repo (moved out in main's Fase 2a,
// 2026-07-23, ahead of this des-embedding branch) — pinging their old
// localhost/placeholder URLs from production only produced noise, never
// signal. api-services.ts, its only other consumer (lib/api/service-client.ts,
// itself unused outside this route), and the per-service X-Service-Secret
// detail-gating scheme were removed together. Detailed health (uptime/version/
// checks) is now only available outside production; there is no secret-gated
// detail path in production anymore because there is no secret-worthy data
// left in this response to gate — see canReadDetailedHealth().

import { Clock, DateTime, Effect } from 'effect'
import { NextResponse } from 'next/server'
import { requireRouteRateLimit, runRouteEffect } from '@/lib/api/effect-route'
import { externalCall } from '@/lib/effect/external'
import { createLogger } from '@/lib/logger'
import { getClientIp, RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'

const log = createLogger('API:Health')
const ROUTE = '/api/health'

const CHECK_TIMEOUT = '3 seconds'
const CACHE_TTL_MS = 10_000
const APP_VERSION = process.env.npm_package_version || process.env.APP_VERSION || '0.1.0'

type CheckStatus = 'up' | 'down'

interface ServiceCheck {
  status: CheckStatus
  latency?: number
  error?: string
}

interface HealthResponse {
  status: 'healthy' | 'unhealthy'
  timestamp: string
  uptime: number
  version: string
  // El commit que está sirviendo. Sin esto, "¿ya está desplegado mi cambio?"
  // solo se contesta abriendo el dashboard de Vercel; con esto lo contesta
  // `bun run estado` comparando contra `main`. Va también en la respuesta
  // pública porque producción NO devuelve la detallada.
  sha: string | null
  checks: Record<string, ServiceCheck>
}

type PublicHealthResponse = Pick<HealthResponse, 'status' | 'timestamp' | 'sha'>

let cachedResponse: { data: HealthResponse; httpStatus: number; ts: number } | null = null

const checkConvex = Effect.fn('Health.checkConvex')(function* () {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!convexUrl) {
    return { status: 'down', error: 'NEXT_PUBLIC_CONVEX_URL not configured' } satisfies ServiceCheck
  }

  const startedAt = yield* Clock.currentTimeMillis
  const outcome = yield* externalCall({
    service: 'Convex',
    operation: 'health',
    timeout: CHECK_TIMEOUT,
    retries: 0,
    run: (signal) => fetch(convexUrl, { method: 'HEAD', signal }),
  }).pipe(
    Effect.match({
      onSuccess: (response) => ({ ok: true as const, response }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
  const latency = (yield* Clock.currentTimeMillis) - startedAt

  if (!outcome.ok) {
    log.warn(`Convex check failed: ${outcome.error.message}`)
    return { status: 'down', latency, error: outcome.error.message } satisfies ServiceCheck
  }

  return {
    status: outcome.response.ok || outcome.response.status < 500 ? 'up' : 'down',
    latency,
  } satisfies ServiceCheck
})

// `VERCEL_GIT_COMMIT_SHA` la pone Vercel en build y en runtime cuando el
// deploy trae metadatos de git; el CLI los recoge del repo local antes de
// subir (`createGitMeta` en `packages/cli/src/commands/deploy/index.ts`). Si un
// deploy llega sin ellos, el valor correcto es `null`: aquí NO hay fallback a
// `git rev-parse`, porque el build de Vercel no tiene `.git` y un sha
// adivinado es peor que la ausencia del dato.
function deploySha(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? null
}

// Detailed health (uptime/version/checks breakdown) is only exposed outside
// production. There is no longer a secret-gated detail path in production —
// see the module docstring above.
function canReadDetailedHealth(): boolean {
  return process.env.NODE_ENV !== 'production'
}

function toPublicHealthResponse(data: HealthResponse): PublicHealthResponse {
  return { status: data.status, timestamp: data.timestamp, sha: data.sha }
}

// Ninguna variante se cachea fuera del proceso: la respuesta lleva cabeceras
// de correlación por petición y un caché compartido se las daría a otro
// cliente durante la ventana. Los 10 s de caché viven en `cachedResponse`.
const CACHE_CONTROL = 'private, no-store'

function selectHealthResponse(data: HealthResponse): HealthResponse | PublicHealthResponse {
  return canReadDetailedHealth() ? data : toPublicHealthResponse(data)
}

const getHealth = Effect.fn('Health.GET')(function* (request: Request) {
  const ip = getClientIp(request)
  yield* requireRouteRateLimit(request, `health:${ip}`, RATE_LIMIT_PRESETS.healthCheck)

  const now = yield* Clock.currentTimeMillis
  if (cachedResponse && now - cachedResponse.ts < CACHE_TTL_MS) {
    return NextResponse.json(selectHealthResponse(cachedResponse.data), {
      status: cachedResponse.httpStatus,
      headers: { 'Cache-Control': CACHE_CONTROL, 'X-Cache': 'HIT' },
    })
  }

  const convex = yield* checkConvex()
  const checks: Record<string, ServiceCheck> = { convex }
  const overallStatus: HealthResponse['status'] = convex.status === 'up' ? 'healthy' : 'unhealthy'
  const httpStatus = overallStatus === 'healthy' ? 200 : 503

  if (process.env.NODE_ENV === 'production') {
    for (const check of Object.values(checks)) {
      delete check.error
    }
  }

  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const data: HealthResponse = {
    status: overallStatus,
    timestamp,
    uptime: Math.round(process.uptime() * 1_000),
    version: APP_VERSION,
    sha: deploySha(),
    checks,
  }

  cachedResponse = { data, httpStatus, ts: now }
  log.info('Health check completed', { status: overallStatus })

  return NextResponse.json(selectHealthResponse(data), {
    status: httpStatus,
    headers: { 'Cache-Control': CACHE_CONTROL, 'X-Cache': 'MISS' },
  })
})

// El sobre (requestId, nosniff) lo pone `runRouteEffect` sobre toda respuesta,
// también sobre el 429 del rate limit.
export function GET(request: Request): Promise<Response> {
  return runRouteEffect(request, ROUTE, getHealth(request))
}
