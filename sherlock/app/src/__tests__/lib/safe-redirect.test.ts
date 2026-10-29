// ============================================================================
// TESTS: src/lib/utils/safe-redirect.ts
// ============================================================================
// Tests unitarios para las funciones de redirect seguro.
// Previenen vulnerabilidades de open-redirect.
// ============================================================================

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

let isSafeRedirectUrl: typeof import('@/lib/utils/safe-redirect').isSafeRedirectUrl

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
  vi.stubEnv('NEXT_PUBLIC_ALLOWED_REDIRECT_HOSTS', '')
  vi.resetModules()
  ;({ isSafeRedirectUrl } = await import('@/lib/utils/safe-redirect'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// ============================================================================
// isSafeRedirectUrl() - Validación de URLs seguras
// ============================================================================
describe('isSafeRedirectUrl()', () => {
  // ===== RUTAS RELATIVAS (SEGURAS) =====
  describe('rutas relativas seguras', () => {
    it('acepta rutas que empiezan con /', () => {
      expect(isSafeRedirectUrl('/my-company/documents')).toBe(true)
      expect(isSafeRedirectUrl('/settings')).toBe(true)
      expect(isSafeRedirectUrl('/my-company/documents')).toBe(true)
    })

    it('acepta rutas con query params', () => {
      expect(isSafeRedirectUrl('/search?q=test')).toBe(true)
      expect(isSafeRedirectUrl('/settings?tab=privacy')).toBe(true)
    })

    it('acepta rutas con hash', () => {
      expect(isSafeRedirectUrl('/docs#section1')).toBe(true)
    })

    it('acepta la ruta raíz', () => {
      expect(isSafeRedirectUrl('/')).toBe(true)
    })
  })

  // ===== PROTOCOL-RELATIVE URLs (INSEGURAS) =====
  describe('protocol-relative URLs (inseguras)', () => {
    it('rechaza URLs que empiezan con //', () => {
      expect(isSafeRedirectUrl('//evil.com')).toBe(false)
      expect(isSafeRedirectUrl('//google.com/search')).toBe(false)
    })

    it('rechaza URLs codificadas que intentan burlar la seguridad', () => {
      expect(isSafeRedirectUrl('%2F%2Fevil.com')).toBe(false)
      expect(isSafeRedirectUrl('/%2e%2e%2fevil.com')).toBe(false)
    })

    it('rechaza variantes con backslash', () => {
      expect(isSafeRedirectUrl('/\\/evil.com')).toBe(false)
      expect(isSafeRedirectUrl('/\\evil.com')).toBe(false)
    })

    // El parser de URL de WHATWG borra tab, LF y CR de CUALQUIER posicion antes
    // de resolver el destino, asi que estas cuatro rutas le parecian internas a
    // la validacion y el navegador las resolvia a https://evil.com/. Medido con
    // `new URL(vector, 'https://sherlock.capital/x')`.
    it('rechaza los caracteres que el parser de URL borra antes de resolver', () => {
      expect(isSafeRedirectUrl('/\t/evil.com')).toBe(false)
      expect(isSafeRedirectUrl('/\n//evil.com')).toBe(false)
      expect(isSafeRedirectUrl('/\r/evil.com')).toBe(false)
      expect(isSafeRedirectUrl('/\t\\evil.com')).toBe(false)
    })

    it('rechaza el mismo salto escondido detras de un porcentaje', () => {
      expect(isSafeRedirectUrl('/%09/evil.com')).toBe(false)
      expect(isSafeRedirectUrl('/%0A//evil.com')).toBe(false)
    })
  })

  // ===== DOMINIOS PERMITIDOS =====
  describe('dominios permitidos', () => {
    it('acepta localhost', () => {
      expect(isSafeRedirectUrl('http://localhost/test')).toBe(true)
      expect(isSafeRedirectUrl('http://localhost:3000/test')).toBe(true)
      expect(isSafeRedirectUrl('https://localhost/test')).toBe(true)
    })

    it('acepta el dominio configurado de esta instalación', () => {
      expect(isSafeRedirectUrl('https://app.example.com/my-company/documents')).toBe(true)
      expect(isSafeRedirectUrl('https://www.app.example.com/ayuda')).toBe(true)
    })

    it('acepta subdominios del dominio configurado', () => {
      expect(isSafeRedirectUrl('https://api.app.example.com/webhook')).toBe(true)
      expect(isSafeRedirectUrl('https://room.app.example.com/')).toBe(true)
    })

    it('rechaza smuggling de credenciales', () => {
      expect(isSafeRedirectUrl('https://fixture-66183172@example.com')).toBe(false)
      // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- test vector for URL credential smuggling
      expect(isSafeRedirectUrl('https://user:fixture-b014f0ea@example.com')).toBe(false)
    })
  })

  it('rechaza los dominios del autor salvo configuración explícita', async () => {
    for (const host of ['sherlock.capital', 'www.sherlock.capital', 'app.sherlock.capital']) {
      expect(isSafeRedirectUrl(`https://${host}/my-company/documents`)).toBe(false)
    }
    vi.stubEnv('NEXT_PUBLIC_ALLOWED_REDIRECT_HOSTS', 'sherlock.capital')
    vi.resetModules()
    const configured = await import('@/lib/utils/safe-redirect')
    expect(configured.isSafeRedirectUrl('https://sherlock.capital/ayuda')).toBe(true)
    expect(configured.isSafeRedirectUrl('https://sherlock.capital.evil.com')).toBe(false)
  })

  it('sin configuración usa localhost y no el dominio del autor', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.resetModules()
    const local = await import('@/lib/utils/safe-redirect')
    expect(local.isSafeRedirectUrl('http://localhost:3000/ayuda')).toBe(true)
    expect(local.isSafeRedirectUrl('https://sherlock.capital/ayuda')).toBe(false)
  })

  // ===== DOMINIOS NO PERMITIDOS =====
  describe('dominios no permitidos', () => {
    it('rechaza dominios externos', () => {
      expect(isSafeRedirectUrl('https://evil.com')).toBe(false)
      expect(isSafeRedirectUrl('https://phishing.site/fake-login')).toBe(false)
      expect(isSafeRedirectUrl('https://google.com')).toBe(false)
    })

    it('rechaza dominios que contienen el dominio permitido pero no son subdominios', () => {
      expect(isSafeRedirectUrl('https://evilapp.example.com')).toBe(false)
      expect(isSafeRedirectUrl('https://app.example.com.evil.com')).toBe(false)
    })

    it('rechaza el dominio legacy Sherlock si no está configurado explícitamente', () => {
      expect(isSafeRedirectUrl('https://sherlock.lat/my-company/documents')).toBe(false)
      expect(isSafeRedirectUrl('https://www.sherlock.lat/deals')).toBe(false)
      expect(isSafeRedirectUrl('https://app.sherlock.lat/')).toBe(false)
    })

    it('rechaza esquemas malformados o mezclados', () => {
      expect(isSafeRedirectUrl('http:///evil.com')).toBe(false)
      expect(isSafeRedirectUrl('https:///evil.com')).toBe(false)
    })
  })

  // ===== PROTOCOLOS INVÁLIDOS =====
  describe('protocolos inválidos', () => {
    it('rechaza javascript:', () => {
      expect(isSafeRedirectUrl('javascript:alert(1)')).toBe(false)
    })

    it('rechaza variantes de javascript: con mayúsculas y caracteres de control', () => {
      expect(isSafeRedirectUrl('JavaScript:alert(1)')).toBe(false)
      expect(isSafeRedirectUrl('java\tscript:alert(1)')).toBe(false)
      expect(isSafeRedirectUrl('java\nscript:alert(1)')).toBe(false)
    })

    it('rechaza data:', () => {
      expect(isSafeRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
      expect(isSafeRedirectUrl('dAtA:text/html,...')).toBe(false)
    })

    it('rechaza file:', () => {
      expect(isSafeRedirectUrl('file:///etc/passwd')).toBe(false)
      expect(isSafeRedirectUrl('FiLe:///etc/passwd')).toBe(false)
    })

    it('rechaza ftp:', () => {
      expect(isSafeRedirectUrl('ftp://files.example.com')).toBe(false)
    })
  })

  // ===== CASOS EDGE =====
  describe('casos edge', () => {
    it('rechaza null', () => {
      expect(isSafeRedirectUrl(null as unknown as string)).toBe(false)
    })

    it('rechaza undefined', () => {
      expect(isSafeRedirectUrl(undefined as unknown as string)).toBe(false)
    })

    it('rechaza string vacío', () => {
      expect(isSafeRedirectUrl('')).toBe(false)
    })

    it('rechaza solo espacios', () => {
      expect(isSafeRedirectUrl('   ')).toBe(false)
    })

    it('maneja URLs con espacios al inicio/final', () => {
      expect(isSafeRedirectUrl('  /my-company/documents  ')).toBe(true)
    })

    it('rechaza valores no-string', () => {
      expect(isSafeRedirectUrl(123 as unknown as string)).toBe(false)
      expect(isSafeRedirectUrl({} as unknown as string)).toBe(false)
      expect(isSafeRedirectUrl([] as unknown as string)).toBe(false)
    })

    it('rechaza URLs malformadas', () => {
      expect(isSafeRedirectUrl('not-a-valid-url')).toBe(false)
      expect(isSafeRedirectUrl('http://')).toBe(false)
    })
  })
})

// ============================================================================
// safeRedirect() y safeRouterPush() - Navegación segura
// ============================================================================
// Nota: Estas funciones usan window.location y router.push
// que son difíciles de testear sin mocks de DOM/router.
// Los tests de isSafeRedirectUrl() cubren la lógica de validación.
// En un entorno de integración/E2E se probarían estas funciones.
