// ============================================================================
// RATE LIMITING UTILITY
// ============================================================================
// Dual-provider rate limiting: Redis (Upstash) when configured, otherwise
// in-memory. Redis is preferred in production for consistency across
// multiple server instances.
// ============================================================================

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { Clock, Effect } from 'effect'

import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

// ===== PROVIDER DETECTION =====

/**
 * Returns true when Upstash Redis credentials are configured.
 * When true, `checkRateLimitDistributed` uses Redis for cross-instance
 * consistency. When false, all rate limiting falls back to in-memory.
 *
 * Feature flag: set `RATE_LIMIT_PROVIDER=memory` to force in-memory even
 * when Redis credentials are present (useful for debugging).
 */
export function isRedisRateLimitEnabled(): boolean {
  if (process.env.RATE_LIMIT_PROVIDER === 'memory') return false
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

// Lazily-initialised Redis ratelimiter (one per window configuration).
// We cache instances by `limit:windowSec` key so we don't recreate on
// every call.
const redisLimiterCache = new Map<string, Ratelimit>()

function getRedisLimiter(config: RateLimitConfig): Ratelimit {
  const cacheKey = `${config.limit}:${config.windowSec}`
  let limiter = redisLimiterCache.get(cacheKey)
  if (!limiter) {
    limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(config.limit, `${config.windowSec} s`),
      prefix: 'sherlock:rl',
    })
    redisLimiterCache.set(cacheKey, limiter)
  }
  return limiter
}

let inMemoryFallbackWarned = false

// Ventana de reintento que se responde cuando Redis está caído y el modo es
// fail-closed: corta para no castigar de más a usuarios legítimos durante el
// outage, pero suficiente para frenar ráfagas de solicitudes de autenticación.
const REDIS_OUTAGE_RETRY_SEC = 30

/**
 * Modo de fallo cuando Redis está configurado pero inalcanzable.
 * Default: 'closed' en producción (negar), 'open' en dev/test (memoria).
 * Override explícito via RATE_LIMIT_FAIL_MODE=open|closed.
 */
function redisFailMode(): 'open' | 'closed' {
  const mode = process.env.RATE_LIMIT_FAIL_MODE
  if (mode === 'open' || mode === 'closed') return mode
  return process.env.NODE_ENV === 'production' ? 'closed' : 'open'
}

// ===== CONFIGURACIÓN =====
interface RateLimitConfig {
  // Máximo de requests permitidos en la ventana de tiempo
  limit: number
  // Ventana de tiempo en segundos
  windowSec: number
}

// ===== PRESETS DE CONFIGURACIÓN =====
// Diferentes límites para diferentes tipos de endpoints
export const RATE_LIMIT_PRESETS = {
  // Auth endpoints (login, signup) - más estrictos para prevenir brute force
  auth: { limit: 5, windowSec: 60 } as RateLimitConfig,

  // API endpoints normales
  api: { limit: 30, windowSec: 60 } as RateLimitConfig,

  // Uploads - muy limitado por costo de storage
  upload: { limit: 20, windowSec: 300 } as RateLimitConfig,

  // Subidas MCP del cliente: 10 por hora por principal (O4-05)
  mcpUpload: { limit: 10, windowSec: 3_600 },

  // Webhooks - más permisivo porque vienen de servicios confiables
  webhook: { limit: 100, windowSec: 60 } as RateLimitConfig,

  // Mutaciones o cambios de estado
  mutation: { limit: 20, windowSec: 60 } as RateLimitConfig,

  // Health checks - muy permisivo para evitar falsos positivos
  healthCheck: { limit: 1000, windowSec: 60 } as RateLimitConfig,
}

// ===== ALMACENAMIENTO EN MEMORIA =====
// Mapa de IP/identificador -> { count, resetAt }
// NOTA: En producción con múltiples instancias, usar Redis
interface RateLimitEntry {
  count: number
  resetAt: number // timestamp en ms
}

const rateLimitStore = new Map<string, RateLimitEntry>()

// ===== LIMPIEZA PERIÓDICA =====
// Limpiar entradas expiradas cada 5 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutos

let cleanupScheduled = false

function scheduleCleanup() {
  if (cleanupScheduled) return
  cleanupScheduled = true

  setTimeout(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt < now) {
        rateLimitStore.delete(key)
      }
    }
    cleanupScheduled = false
  }, CLEANUP_INTERVAL)
}

// ===== FUNCIÓN PRINCIPAL DE RATE LIMITING =====
export interface RateLimitResult {
  success: boolean
  remaining: number
  resetAt: Date
  retryAfterSec: number
}

/**
 * Verifica si una request debe ser limitada.
 *
 * @param identifier - Identificador único (IP, userId, etc.)
 * @param config - Configuración de límites
 * @returns Resultado con success=true si permitido, false si limitado
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = RATE_LIMIT_PRESETS.api
): RateLimitResult {
  const now = Date.now()
  const windowMs = config.windowSec * 1000

  // Programar limpieza periódica
  scheduleCleanup()

  // Buscar entrada existente
  const entry = rateLimitStore.get(identifier)

  // Si no hay entrada o expiró, crear nueva
  if (!entry || entry.resetAt < now) {
    const resetAt = now + windowMs
    rateLimitStore.set(identifier, { count: 1, resetAt })

    return {
      success: true,
      remaining: config.limit - 1,
      resetAt: new Date(resetAt),
      retryAfterSec: 0,
    }
  }

  // Incrementar contador
  entry.count++

  // Verificar límite
  if (entry.count > config.limit) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)

    return {
      success: false,
      remaining: 0,
      resetAt: new Date(entry.resetAt),
      retryAfterSec,
    }
  }

  return {
    success: true,
    remaining: config.limit - entry.count,
    resetAt: new Date(entry.resetAt),
    retryAfterSec: 0,
  }
}

// ===== HELPER PARA OBTENER IP DEL REQUEST =====
// Orden de precedencia: primero los headers que inyecta la plataforma de
// despliegue (y que el cliente NO puede sobreescribir), después los headers
// genéricos de proxy que un cliente sí puede falsificar. Al revés, cualquiera
// podía mandar `X-Real-IP: 10.0.0.<n>` rotando el valor y abrir un bucket de
// rate limit nuevo por request, anulando todos los límites por IP.
const CLIENT_IP_HEADERS = [
  'x-vercel-forwarded-for', // Vercel: no sobreescribible por el cliente
  'cf-connecting-ip', // Cloudflare: seteado por el edge
  'x-real-ip', // Proxy genérico (spoofable si no hay proxy delante)
  'x-forwarded-for', // Proxy genérico (spoofable si no hay proxy delante)
] as const

/**
 * Extrae la IP del cliente de los headers del request.
 * Maneja proxies (Vercel, Cloudflare, etc.)
 *
 * @param request - Next.js Request object
 * @returns IP del cliente o 'unknown'
 */
export function getClientIp(request: Request): string {
  for (const header of CLIENT_IP_HEADERS) {
    const value = request.headers.get(header)
    if (value) {
      // Los headers spoofables (x-forwarded-for, x-real-ip) pueden traer una
      // lista `client, proxy1, proxy2`; el elemento MÁS A LA IZQUIERDA es el que
      // inyecta el cliente y el MÁS A LA DERECHA es el hop de confianza (el más
      // cercano al edge). Tomar `.pop()` evita que un cliente rote el valor y abra
      // un bucket de rate limit nuevo por request. Espeja getDocumentAccessIp.
      // Para headers de plataforma (x-vercel-forwarded-for, cf-connecting-ip) que
      // traen un único valor, pop() también es seguro.
      const trusted = value.split(',').pop()?.trim()
      if (trusted) {
        return trusted
      }
    }
  }

  return 'unknown'
}

// ===== RESPONSE HELPERS =====
/**
 * Crea una respuesta de rate limit exceeded.
 * Incluye headers estándar de rate limiting.
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'Demasiadas solicitudes',
      message: `Demasiadas solicitudes. Inténtalo de nuevo en ${result.retryAfterSec} segundos.`,
      retryAfter: result.retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfterSec),
        'X-RateLimit-Limit': String(result.remaining + 1), // Aproximado
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
      },
    }
  )
}

/**
 * Distributed rate limiter — uses Redis (Upstash) when configured, otherwise
 * falls back to in-memory with a warning. Prefer this over `checkRateLimit`
 * in API routes that may run on multiple instances.
 *
 * Returns a Promise so callers must `await` it.
 */
export const checkRateLimitDistributedEffect = Effect.fn('RateLimit.checkDistributed')(function* (
  identifier: string,
  config: RateLimitConfig = RATE_LIMIT_PRESETS.api
): Effect.fn.Return<RateLimitResult> {
  if (isRedisRateLimitEnabled()) {
    const outcome = yield* externalCall({
      service: 'Upstash',
      operation: 'rateLimit',
      timeout: '3 seconds',
      retries: 0,
      run: () => getRedisLimiter(config).limit(identifier),
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )

    if (outcome.ok) {
      const now = yield* Clock.currentTimeMillis
      return {
        success: outcome.result.success,
        remaining: outcome.result.remaining,
        resetAt: new Date(outcome.result.reset),
        retryAfterSec: outcome.result.success ? 0 : Math.ceil((outcome.result.reset - now) / 1000),
      }
    }

    yield* Effect.logError('[rate-limit] Redis rate limiter error:', outcome.error)
    // Con Redis configurado pero caído, degradar a memoria significa un
    // contador por instancia → bypass del cap en multi-instancia. En
    // producción el default es negar (fail-closed) con un retry corto;
    // RATE_LIMIT_FAIL_MODE=open|closed fuerza cualquiera de los dos modos.
    if (redisFailMode() === 'closed') {
      const now = yield* Clock.currentTimeMillis
      return {
        success: false,
        remaining: 0,
        resetAt: new Date(now + REDIS_OUTAGE_RETRY_SEC * 1000),
        retryAfterSec: REDIS_OUTAGE_RETRY_SEC,
      }
    }
  } else if (!inMemoryFallbackWarned) {
    inMemoryFallbackWarned = true
    yield* Effect.logWarning(
      '[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
        'using in-memory rate limiting. This does not persist across server instances.'
    )
  }

  return checkRateLimit(identifier, config)
})

export function checkRateLimitDistributed(
  identifier: string,
  config: RateLimitConfig = RATE_LIMIT_PRESETS.api
): Promise<RateLimitResult> {
  return runServerEffect(checkRateLimitDistributedEffect(identifier, config))
}
