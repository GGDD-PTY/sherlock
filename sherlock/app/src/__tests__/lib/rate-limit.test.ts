// ============================================================================
// TESTS: src/lib/utils/rate-limit.ts
// ============================================================================
// Tests unitarios para rate limiting.
// ============================================================================

import { describe, it, expect } from 'vitest'
import {
  checkRateLimit,
  checkRateLimitDistributed,
  isRedisRateLimitEnabled,
  getClientIp,
  createRateLimitResponse,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
const getUniqueId = () => `test-${Date.now()}-${Math.random()}`

// ============================================================================
// RATE_LIMIT_PRESETS - Configuraciones predefinidas
// ============================================================================
describe('RATE_LIMIT_PRESETS', () => {
  it('tiene preset para auth', () => {
    expect(RATE_LIMIT_PRESETS.auth).toEqual({ limit: 5, windowSec: 60 })
  })

  it('tiene preset para api', () => {
    expect(RATE_LIMIT_PRESETS.api).toEqual({ limit: 30, windowSec: 60 })
  })

  it('tiene preset para upload', () => {
    expect(RATE_LIMIT_PRESETS.upload).toEqual({ limit: 20, windowSec: 300 })
  })

  it('tiene preset para webhook', () => {
    expect(RATE_LIMIT_PRESETS.webhook).toEqual({ limit: 100, windowSec: 60 })
  })

  it('tiene preset para subidas MCP: 10 por hora', () => {
    expect(RATE_LIMIT_PRESETS.mcpUpload).toEqual({ limit: 10, windowSec: 3600 })
  })
})

// ============================================================================
// isRedisRateLimitEnabled() - Provider detection
// ============================================================================
describe('isRedisRateLimitEnabled()', () => {
  it('returns false when Upstash env vars are not set', () => {
    expect(isRedisRateLimitEnabled()).toBe(false)
  })
})

// ============================================================================
// checkRateLimit() - Verificación de rate limit
// ============================================================================
describe('checkRateLimit()', () => {
  // Generar identificador único para cada test para evitar interferencia
  const getUniqueId = () => `test-${Date.now()}-${Math.random()}`

  describe('primera solicitud', () => {
    it('permite la primera solicitud', () => {
      const id = getUniqueId()
      const result = checkRateLimit(id, { limit: 5, windowSec: 60 })

      expect(result.success).toBe(true)
      expect(result.remaining).toBe(4) // 5 - 1 = 4
      expect(result.retryAfterSec).toBe(0)
    })

    it('retorna fecha de reset futura', () => {
      const id = getUniqueId()
      const now = Date.now()
      const result = checkRateLimit(id, { limit: 5, windowSec: 60 })

      expect(result.resetAt.getTime()).toBeGreaterThan(now)
      expect(result.resetAt.getTime()).toBeLessThanOrEqual(now + 61000) // ~60 segundos
    })
  })

  describe('múltiples solicitudes', () => {
    it('decrementa remaining con cada solicitud', () => {
      const id = getUniqueId()

      const r1 = checkRateLimit(id, { limit: 5, windowSec: 60 })
      expect(r1.remaining).toBe(4)

      const r2 = checkRateLimit(id, { limit: 5, windowSec: 60 })
      expect(r2.remaining).toBe(3)

      const r3 = checkRateLimit(id, { limit: 5, windowSec: 60 })
      expect(r3.remaining).toBe(2)
    })

    it('permite exactamente N solicitudes', () => {
      const id = getUniqueId()
      const limit = 3

      // Las primeras N solicitudes deben ser exitosas
      for (let i = 0; i < limit; i++) {
        const result = checkRateLimit(id, { limit, windowSec: 60 })
        expect(result.success).toBe(true)
      }

      // La solicitud N+1 debe ser rechazada
      const result = checkRateLimit(id, { limit, windowSec: 60 })
      expect(result.success).toBe(false)
    })
  })

  describe('límite excedido', () => {
    it('retorna success=false cuando se excede el límite', () => {
      const id = getUniqueId()

      // Agotar el límite
      for (let i = 0; i < 5; i++) {
        checkRateLimit(id, { limit: 5, windowSec: 60 })
      }

      // La siguiente solicitud debe fallar
      const result = checkRateLimit(id, { limit: 5, windowSec: 60 })
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterSec).toBeGreaterThan(0)
    })

    it('retorna retryAfterSec positivo', () => {
      const id = getUniqueId()

      // Agotar el límite
      for (let i = 0; i < 3; i++) {
        checkRateLimit(id, { limit: 3, windowSec: 60 })
      }

      const result = checkRateLimit(id, { limit: 3, windowSec: 60 })
      expect(result.retryAfterSec).toBeGreaterThan(0)
      expect(result.retryAfterSec).toBeLessThanOrEqual(60)
    })
  })

  describe('usa preset por defecto', () => {
    it('usa preset api cuando no se especifica config', () => {
      const id = getUniqueId()
      const result = checkRateLimit(id)

      // api preset tiene limit: 30
      expect(result.remaining).toBe(29) // 30 - 1
    })
  })
})

describe('checkRateLimitDistributed()', () => {
  it('falls back to in-memory when Redis is not configured', async () => {
    const result = await checkRateLimitDistributed('legacy-alias', { limit: 1, windowSec: 60 })
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(0)
  })
})

describe('diferentes identificadores', () => {
  it('trata diferentes IPs de forma independiente', () => {
    const ip1 = getUniqueId()
    const ip2 = getUniqueId()

    // Agotar límite de ip1
    for (let i = 0; i < 3; i++) {
      checkRateLimit(ip1, { limit: 3, windowSec: 60 })
    }

    // ip1 debe estar bloqueado
    expect(checkRateLimit(ip1, { limit: 3, windowSec: 60 }).success).toBe(false)

    // ip2 debe poder hacer solicitudes
    expect(checkRateLimit(ip2, { limit: 3, windowSec: 60 }).success).toBe(true)
  })
})

describe('expiración de ventana', () => {
  it('resetea el límite después de que expira la ventana', async () => {
    const id = `test-reset-${Date.now()}`
    const limit = 2
    const windowSec = 1 // Ventana corta de 1 segundo

    // Agotar el límite
    expect(checkRateLimit(id, { limit, windowSec }).success).toBe(true)
    expect(checkRateLimit(id, { limit, windowSec }).success).toBe(true)

    // La tercera debe fallar
    expect(checkRateLimit(id, { limit, windowSec }).success).toBe(false)

    // Esperar a que la ventana expire (> 1 segundo)
    await new Promise((resolve) => setTimeout(resolve, 1100))

    // La siguiente solicitud debe tener éxito
    const result = checkRateLimit(id, { limit, windowSec })
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(limit - 1)
  })
})

// ============================================================================
// getClientIp() - Extracción de IP del cliente
// ============================================================================
describe('getClientIp()', () => {
  it('extrae IP de x-real-ip', () => {
    const headers = new Headers({ 'x-real-ip': '192.168.1.100' })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('192.168.1.100')
  })

  it('extrae IP de x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.1' })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('10.0.0.1')
  })

  // Anti rate-limit-bypass: en `x-forwarded-for` el elemento MÁS A LA IZQUIERDA
  // es el que inyecta el cliente; el hop más cercano al edge (el de confianza)
  // es el MÁS A LA DERECHA. Un cliente que rota `X-Forwarded-For: 10.0.0.<n>`
  // abriría un bucket de rate limit nuevo por request si tomáramos `[0]`.
  it('toma la última IP (hop de confianza) de x-forwarded-for cuando hay múltiples', () => {
    const headers = new Headers({
      'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('10.0.0.3')
  })

  it('ignora los hops inyectados a la izquierda en x-forwarded-for', () => {
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('5.6.7.8')
  })

  it('extrae IP de cf-connecting-ip (Cloudflare)', () => {
    const headers = new Headers({ 'cf-connecting-ip': '172.16.0.1' })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('172.16.0.1')
  })

  it('extrae IP de x-vercel-forwarded-for', () => {
    const headers = new Headers({ 'x-vercel-forwarded-for': '8.8.8.8' })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('8.8.8.8')
  })

  it('prioriza x-real-ip sobre x-forwarded-for', () => {
    const headers = new Headers({
      'x-real-ip': '1.1.1.1',
      'x-forwarded-for': '2.2.2.2',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('1.1.1.1')
  })

  it('retorna "unknown" si no hay headers de IP', () => {
    const request = new Request('http://test.com')

    expect(getClientIp(request)).toBe('unknown')
  })

  it('maneja espacios en headers', () => {
    const headers = new Headers({ 'x-forwarded-for': '  10.0.0.1  ' })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('10.0.0.1')
  })

  // Anti rate-limit-bypass: los headers que puede inyectar el cliente NUNCA
  // deben ganarle al header que setea la plataforma. Si ganaran, cualquiera
  // rotaría `X-Real-IP` y abriría un bucket nuevo por request.
  it('no deja que un x-real-ip inyectado gane sobre x-vercel-forwarded-for', () => {
    const headers = new Headers({
      'x-real-ip': '10.0.0.1',
      'x-vercel-forwarded-for': '8.8.8.8',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('8.8.8.8')
  })

  it('no deja que un x-forwarded-for inyectado gane sobre x-vercel-forwarded-for', () => {
    const headers = new Headers({
      'x-forwarded-for': '10.0.0.2, 10.0.0.3',
      'x-vercel-forwarded-for': '8.8.8.8',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('8.8.8.8')
  })

  it('prioriza cf-connecting-ip sobre headers genéricos de proxy', () => {
    const headers = new Headers({
      'x-real-ip': '10.0.0.1',
      'x-forwarded-for': '10.0.0.2',
      'cf-connecting-ip': '172.16.0.1',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('172.16.0.1')
  })

  it('devuelve la misma IP para requests que rotan headers spoofeables', () => {
    const attempts = ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map((spoofed) => {
      const headers = new Headers({
        'x-real-ip': spoofed,
        'x-forwarded-for': spoofed,
        'x-vercel-forwarded-for': '203.0.113.7',
      })
      return getClientIp(new Request('http://test.com', { headers }))
    })

    expect(new Set(attempts)).toEqual(new Set(['203.0.113.7']))
  })

  it('cae al siguiente header cuando el de plataforma viene vacío', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '   ',
      'x-real-ip': '1.1.1.1',
    })
    const request = new Request('http://test.com', { headers })

    expect(getClientIp(request)).toBe('1.1.1.1')
  })
})

// ============================================================================
// createRateLimitResponse() - Respuesta de rate limit
// ============================================================================
describe('createRateLimitResponse()', () => {
  it('retorna status 429', () => {
    const result = {
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30000),
      retryAfterSec: 30,
    }

    const response = createRateLimitResponse(result)
    expect(response.status).toBe(429)
  })

  it('incluye header Retry-After', () => {
    const result = {
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 45000),
      retryAfterSec: 45,
    }

    const response = createRateLimitResponse(result)
    expect(response.headers.get('Retry-After')).toBe('45')
  })

  it('incluye headers X-RateLimit-*', () => {
    const result = {
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30000),
      retryAfterSec: 30,
    }

    const response = createRateLimitResponse(result)
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })

  it('tiene Content-Type application/json', () => {
    const result = {
      success: false,
      remaining: 0,
      resetAt: new Date(),
      retryAfterSec: 10,
    }

    const response = createRateLimitResponse(result)
    expect(response.headers.get('Content-Type')).toBe('application/json')
  })

  it('body contiene mensaje de error', async () => {
    const result = {
      success: false,
      remaining: 0,
      resetAt: new Date(),
      retryAfterSec: 20,
    }

    const response = createRateLimitResponse(result)
    const body = await response.json()

    expect(body.error).toBe('Demasiadas solicitudes')
    expect(body.message).toContain('20 segundos')
    expect(body.retryAfter).toBe(20)
  })
})
