// ============================================================================
// ARCHITECTURE: CSRF EN RUTAS MUTANTES
// ============================================================================
// Contrato ejecutable: toda ruta API mutante orientada a browser debe validar
// el Origin con rejectInvalidOrigin() de src/lib/api/csrf.ts. Los webhooks
// quedan fuera (no llevan Origin; van firmados) y los GET no mutan.
// Si añades una ruta mutante nueva, añádela aquí y protégela.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_ROOT = join(process.cwd(), 'src', 'app', 'api')

// Rutas mutantes que DEBEN validar Origin (path relativo a src/app/api)
const CSRF_PROTECTED_ROUTES = [
  'admin/make-admin/route.ts',
  'documents/upload/route.ts',
  'upload/route.ts',
  'workos/admin-portal/route.ts',
]

describe('CSRF: rutas API mutantes validan Origin', () => {
  for (const route of CSRF_PROTECTED_ROUTES) {
    it(`${route} importa y llama rejectInvalidOrigin`, () => {
      const source = readFileSync(join(API_ROOT, route), 'utf8')
      expect(source).toMatch(
        /import\s*\{[^}]*rejectInvalidOrigin[^}]*\}\s*from\s*'@\/lib\/api\/csrf'/
      )
      expect(source).toMatch(/rejectInvalidOrigin\(request\)/)
    })
  }

  it('documents/[id] uses the stricter exact-origin guard before minting an admin bearer', () => {
    const source = readFileSync(join(API_ROOT, 'documents/[id]/route.ts'), 'utf8')
    expect(source).toMatch(
      /import\s*\{[^}]*rejectNonExactSameOrigin[^}]*\}\s*from\s*'@\/lib\/api\/exact-same-origin'/
    )
    expect(source).toMatch(/rejectNonExactSameOrigin\(request\)/)
    expect(source.indexOf('rejectNonExactSameOrigin(request)')).toBeLessThan(
      source.lastIndexOf('issueAdminVdrCapability')
    )
  })

  it('el webhook de WorkOS NO lleva CSRF por Origin (va firmado)', () => {
    const source = readFileSync(join(API_ROOT, 'webhooks/workos/route.ts'), 'utf8')
    expect(source).not.toContain('rejectInvalidOrigin')
  })
})
