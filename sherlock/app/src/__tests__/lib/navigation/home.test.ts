// ============================================================================
// CASA POR ROL
// ============================================================================
// Hereda el contrato que vivía en `/dashboard/route.ts` y en la page de
// `/data-room`: las dos rutas se borraron porque solo redirigían ([F]
// 2026-09-07 09:00, «si la página no existe, no debería existir y redirigir»).
// El destino por rol sigue siendo el mismo; ahora lo resuelve quien navega.
// ============================================================================

import { describe, expect, it } from 'vitest'

import { homePathForRole } from '@/lib/navigation/home'

describe('homePathForRole', () => {
  it('manda a la empresa a su Data Room', () => {
    expect(homePathForRole('COMPANY')).toBe('/my-company/documents')
  })

  it('manda al equipo a su panel', () => {
    expect(homePathForRole('ADMIN')).toBe('/admin')
  })

  // INVESTOR está dormante y una sesión cuyo perfil de Convex todavía no llega
  // no tiene sala: el home público es el único destino que existe.
  it('cae al home público para el rol dormante y para un rol sin resolver', () => {
    expect(homePathForRole('INVESTOR')).toBe('/')
    expect(homePathForRole(null)).toBe('/')
    expect(homePathForRole(undefined)).toBe('/')
    expect(homePathForRole('')).toBe('/')
  })

  it('nunca devuelve una ruta que solo redirige', () => {
    for (const role of ['COMPANY', 'ADMIN', 'INVESTOR', 'GUEST', null, undefined]) {
      const href = homePathForRole(role)
      expect(href).not.toBe('/dashboard')
      expect(href).not.toBe('/data-room')
    }
  })
})
