import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseLocale = vi.hoisted(() => vi.fn())

// The hand-written dictionary omitted 'label', which the component does render:
// a missing key returned undefined in silence. Resolve against the real catalog
// and throw instead.
vi.mock('next-intl', async () => {
  const catalog = (await import('@/messages/es.json')).default as {
    common: { controls: { theme: Record<string, string> } }
  }

  return {
    useLocale: mockUseLocale,
    useTranslations: (namespace: string) => (key: string) => {
      const theme = catalog.common.controls.theme
      const message = namespace === 'common.controls.theme' ? theme[key] : undefined

      if (typeof message !== 'string') {
        throw new Error(`Missing message in src/messages/es.json: ${namespace}.${key}`)
      }

      return message
    },
  }
})

describe('ThemeToggle', () => {
  beforeEach(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  // El caso hermano probaba las etiquetas en inglés. Sin catálogo `en` lo que
  // queda por pinnear es lo que el mock existe para atrapar: una clave ausente
  // revienta en vez de renderizar `undefined` en silencio.
  it('throws instead of rendering a message the catalog does not carry', async () => {
    mockUseLocale.mockReturnValue('es')
    const catalog = (await import('@/messages/es.json')).default as {
      common: { controls: { theme: Record<string, string> } }
    }

    expect(catalog.common.controls.theme.toggle).toBe('Cambiar tema')
    expect(catalog.common.controls.theme.missingOnPurpose).toBeUndefined()
  })

  it('renders the Spanish theme labels', async () => {
    mockUseLocale.mockReturnValue('es')
    const { ThemeProvider } = await import('@/components/providers/ThemeProvider')
    const { ThemeToggle } = await import('@/components/ui/theme-toggle')

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Cambiar tema' }))

    expect(screen.getByText('Claro')).toBeInTheDocument()
    expect(screen.getByText('Oscuro')).toBeInTheDocument()
    expect(screen.getByText('Sistema')).toBeInTheDocument()
  })
})
