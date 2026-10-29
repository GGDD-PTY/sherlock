import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider, useTheme } from '@/components/providers/ThemeProvider'
import { THEME_BOOT_SCRIPT } from '@/lib/theme/boot-script'

// ============================================================================
// CONTRATO DEL TEMA POR DEFECTO
// ============================================================================
// El default vive en DOS lugares que tienen que decir lo mismo:
//   1. THEME_BOOT_SCRIPT (`@/lib/theme/boot-script`) — decide el primer paint,
//      antes de que exista React, en las tres superficies con <html> propio.
//   2. DEFAULT_THEME en `ThemeProvider` — decide el estado de React al hidratar.
// Si divergen, el boot pinta un tema y React hidrata creyendo otro: flash y el
// toggle marcando la opción equivocada. Estas pruebas ejecutan el string real
// que se envía al navegador, no una copia.
// ============================================================================

function runBootScript({
  stored,
  systemPrefersDark,
}: {
  stored: string | null
  systemPrefersDark: boolean
}): { className: string; colorScheme: string } {
  window.localStorage.clear()
  if (stored !== null) window.localStorage.setItem('theme', stored)

  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark') ? systemPrefersDark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )

  document.documentElement.className = ''
  document.documentElement.style.colorScheme = ''
  new Function(THEME_BOOT_SCRIPT)()

  return {
    className: document.documentElement.className,
    colorScheme: document.documentElement.style.colorScheme,
  }
}

describe('THEME_BOOT_SCRIPT (primer paint)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  // [F] 2026-09-14: sin preferencia guardada el tema sigue al sistema (restaura
  // la orden del 2026-09-03 y supersede la crema por defecto del 2026-09-11).
  it('sigue al sistema cuando no hay preferencia guardada', () => {
    expect(runBootScript({ stored: null, systemPrefersDark: true }).className).toBe('dark')
    expect(runBootScript({ stored: null, systemPrefersDark: false }).className).toBe('light')
  })

  it('sigue al sistema cuando el valor guardado es inválido', () => {
    expect(runBootScript({ stored: 'sepia', systemPrefersDark: true }).className).toBe('dark')
    expect(runBootScript({ stored: 'sepia', systemPrefersDark: false }).className).toBe('light')
  })

  it('respeta la preferencia explícita por encima del sistema', () => {
    expect(runBootScript({ stored: 'light', systemPrefersDark: true }).className).toBe('light')
    expect(runBootScript({ stored: 'dark', systemPrefersDark: false }).className).toBe('dark')
  })

  it('sigue al sistema con "system" explícito', () => {
    expect(runBootScript({ stored: 'system', systemPrefersDark: true }).className).toBe('dark')
    expect(runBootScript({ stored: 'system', systemPrefersDark: false }).className).toBe('light')
  })

  it('mantiene color-scheme alineado con la clase', () => {
    const { className, colorScheme } = runBootScript({ stored: null, systemPrefersDark: true })
    expect(colorScheme).toBe(className)
  })
})

function ThemeProbe() {
  const { theme } = useTheme()
  return <span data-testid="theme">{theme}</span>
}

describe('ThemeProvider (estado al hidratar)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  // El mismo default que el boot script: sin preferencia guardada, 'system'.
  it('arranca en "system" cuando no hay preferencia guardada', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('system')
  })

  it('respeta la preferencia guardada', () => {
    window.localStorage.setItem('theme', 'dark')

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('dark')
  })

  // Candado: el default del provider y el del boot script cambian juntos o no
  // cambian; un 'light' que vuelva solo aquí flashea el tema equivocado.
  it('fija el default del sistema en el código fuente del provider', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/providers/ThemeProvider.tsx'),
      'utf8'
    )

    expect(source).toMatch(/const DEFAULT_THEME: Theme = 'system'/)
  })
})

// Contrato de cobertura: toda superficie que renderiza su propio <html> tiene
// que arrancar el tema, porque ninguna hereda el layout raíz. Sin esto, un
// usuario en modo oscuro que cae en un 404 o en un error global ve blanco.
describe('superficies con <html> propio', () => {
  const SURFACES = [
    'src/app/[locale]/layout.tsx',
    'src/app/global-error.tsx',
    'src/app/global-not-found.tsx',
  ] as const

  it.each(SURFACES)('%s inyecta el boot script de tema', (surface) => {
    const source = readFileSync(join(process.cwd(), surface), 'utf8')

    expect(source).toContain("from '@/lib/theme/boot-script'")
    expect(source).toContain('THEME_BOOT_SCRIPT')
    // Nadie vuelve a copiar el script: la única definición vive en el módulo.
    expect(source).not.toMatch(/const THEME_BOOT_SCRIPT\s*=/)
  })
})
