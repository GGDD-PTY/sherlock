// ============================================================================
// ARCHITECTURE: ADMIN API STEP-UP BOUNDARY
// ============================================================================
// ES: Las páginas SSR bloquean a cualquier ADMIN sin re-autenticación fuerte
//     reciente (`requireRole` → cookie `sherlock_admin_step_up`). Las rutas de
//     API admin deben aplicar el mismo control vía `requireAdminApiAuth()` o
//     `requireAdminRouteUser()`, cuyo Effect delega al primero; comprobar
//     `user.role !== 'ADMIN'` a mano deja el step-up evitable.
// EN: Admin API routes must enforce the same step-up gate as SSR pages.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')
const ADMIN_API_ROOT = path.join(APP_ROOT, 'src', 'app', 'api', 'admin')
const MIXED_ROLE_ROUTES = [
  'src/app/api/vdr/export/route.ts',
]

function collectRouteFiles(dir: string, results: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      collectRouteFiles(fullPath, results)
      continue
    }

    if (entry.name === 'route.ts') {
      results.push(fullPath)
    }
  }

  return results
}

describe('admin api step-up boundary', () => {
  const adminRoutes = collectRouteFiles(ADMIN_API_ROOT)

  it('finds the admin API routes under audit', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(5)
  })

  it.each(adminRoutes)('%s requires admin auth with step-up', (routeFile) => {
    const source = fs.readFileSync(routeFile, 'utf8')

    expect(source).toMatch(/requireAdmin(?:ApiAuth|RouteUser)/)
    // El chequeo manual de rol no basta: no valida el step-up.
    expect(source).not.toMatch(/user\.role\s*!==\s*'ADMIN'/)
  })

  it.each(MIXED_ROLE_ROUTES)('%s requires step-up when the caller is an admin', (routeFile) => {
    const source = fs.readFileSync(path.join(APP_ROOT, routeFile), 'utf8')

    expect(source).toContain('requireAdminApiStepUp')
  })

  it('keeps the Effect route helper wired to requireAdminApiAuth', () => {
    const effectRouteSource = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'lib', 'api', 'effect-route.ts'),
      'utf8'
    )

    expect(effectRouteSource).toContain('requireAdminApiAuth')
    expect(effectRouteSource).toContain("Effect.fn('Route.requireAdmin')")
  })

  it('keeps the step-up helper wired to the signed cookie validator', () => {
    const withAuthSource = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'lib', 'api', 'with-auth.ts'),
      'utf8'
    )

    expect(withAuthSource).toContain('isRecentAdminStepUpCookie')
    expect(withAuthSource).toContain('ADMIN_STEP_UP_COOKIE_NAME')
    expect(withAuthSource).toContain('ADMIN_STEP_UP_REQUIRED')
  })
})
