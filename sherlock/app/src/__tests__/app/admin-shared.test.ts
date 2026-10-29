import { describe, expect, it, vi } from 'vitest'

// next-intl/server real lanza en jsdom; `_shared.ts` lo importa para las
// traducciones del panel y aquí solo se prueba el candado de rutas.
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))

import { adminRoute } from '@/app/[locale]/(app)/admin/_shared'
import { PRODUCT_ROUTES } from '@/lib/product/architecture'

const adminPaths = PRODUCT_ROUTES.filter((route) => route.surface === 'ADMIN').flatMap(
  (route) => route.paths
)
const otherPaths = PRODUCT_ROUTES.filter((route) => route.surface !== 'ADMIN').flatMap(
  (route) => route.paths
)

describe('adminRoute (candado de rutas del panel)', () => {
  it('acepta cada ruta del catálogo con superficie ADMIN', () => {
    // D2 ([F] 2026-09-11) podó el panel a ocho rutas; la cola de solicitudes
    // por transacción salió con su subsistema ([F] 2026-09-17) y `/admin/nda`,
    // sin página desde la salida de INVESTOR, salió del catálogo el mismo día
    // ([F] 2026-09-17, «nada de código dormante»). Quedan seis. El número es
    // el contrato.
    expect(adminPaths).toHaveLength(6)
    for (const path of adminPaths) {
      expect(adminRoute(path)).toBe(path)
    }
  })

  // A1-06: el schema tomaba el catálogo entero, así que una página del panel
  // podía declararse con la ruta de la sala del cliente sin que nada reventara.
  it('rechaza las rutas de las demás superficies y los typos', () => {
    expect(otherPaths.length).toBeGreaterThan(0)
    for (const path of otherPaths) {
      expect(() => adminRoute(path)).toThrow(/Expected "\/admin"/)
    }
    expect(() => adminRoute('/admin/usuarios')).toThrow(/Expected "\/admin"/)
  })
})
