// ============================================================================
// El 429 que ven intake, subida, export, grants y webhooks habla español
// ============================================================================
// El cuerpo era el único texto de cara al usuario en inglés de las API
// (A9-H10). El código de estado y las cabeceras no cambian.
// ============================================================================

import { describe, expect, it } from 'vitest'

import { createRateLimitResponse } from '@/lib/utils/rate-limit'

describe('createRateLimitResponse', () => {
  it('responds in Spanish, with tuteo and the seconds to wait', async () => {
    const resetAt = new Date('2026-09-11T18:00:00.000Z')
    const response = createRateLimitResponse({
      success: false,
      remaining: 0,
      resetAt,
      retryAfterSec: 42,
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('42')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBe(
      String(Math.floor(resetAt.getTime() / 1000))
    )
    await expect(response.json()).resolves.toEqual({
      error: 'Demasiadas solicitudes',
      message: 'Demasiadas solicitudes. Inténtalo de nuevo en 42 segundos.',
      retryAfter: 42,
    })
  })
})
