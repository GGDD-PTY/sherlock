import { act, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Toaster } from '@/components/ui/sonner'

// `setup.ts` mockea sonner entero para el resto de la suite; aquí se prueba el
// viewport real, que es donde viven la duración y el offset.
vi.unmock('sonner')

vi.mock('@/components/providers/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

// El navbar global mide 4rem: un toast anclado arriba a la derecha con el
// offset por defecto de sonner (24px) le cae encima y tapa Notificaciones y
// Preferencias justo cuando el cliente acaba de subir un documento.
const ROOT_FONT_SIZE_PX = 16
const NAVBAR_HEIGHT_PX = 4 * ROOT_FONT_SIZE_PX

function toasterViewport(): HTMLElement {
  const viewport = document.querySelector('[data-sonner-toaster]')
  if (!(viewport instanceof HTMLElement)) throw new Error('sonner viewport not rendered')
  return viewport
}

// El viewport declara el offset como longitud CSS: se compara en píxeles para
// que un cambio de unidad no pase por encima del navbar sin que nadie lo note.
function offsetPx(value: string): number {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount)) throw new Error(`offset ilegible: "${value}"`)
  if (value.trim().endsWith('rem')) return amount * ROOT_FONT_SIZE_PX
  if (value.trim().endsWith('px')) return amount
  throw new Error(`unidad de offset no soportada: "${value}"`)
}

describe('Toaster viewport', () => {
  beforeEach(() => {
    toast.dismiss()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the toast clear of the global navbar on desktop and mobile', async () => {
    render(<Toaster richColors position="top-right" containerAriaLabel="Notificaciones" />)
    act(() => {
      toast.success('1 documento subido.')
    })
    await screen.findByText('1 documento subido.')

    const viewport = toasterViewport()
    expect(offsetPx(viewport.style.getPropertyValue('--offset-top'))).toBeGreaterThanOrEqual(
      NAVBAR_HEIGHT_PX
    )
    expect(offsetPx(viewport.style.getPropertyValue('--mobile-offset-top'))).toBeGreaterThanOrEqual(
      NAVBAR_HEIGHT_PX
    )
  })

  // sonner fija `z-index: 999999999` en el viewport y tapaba el menú Cuenta
  // abierto (AU-11). El viewport baja a 100: menús, popovers y selects (110)
  // quedan encima; diálogos, sheets (50) y el visor (60), debajo.
  it('stacks the viewport below open menus and above dialogs', async () => {
    render(<Toaster richColors position="top-right" containerAriaLabel="Notificaciones" />)
    act(() => {
      toast.success('Documento archivado')
    })
    await screen.findByText('Documento archivado')

    expect(toasterViewport().style.zIndex).toBe('100')
  })

  it('closes an upload confirmation on its own after four seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Toaster richColors position="top-right" containerAriaLabel="Notificaciones" />)

    act(() => {
      toast.success('1 documento subido.')
    })
    // `findByText` resuelve apenas el nodo entra al DOM, y sonner lo termina de
    // montar un tick después: bajo carga `toBeVisible` corría antes de tiempo y
    // el caso ponía rojo el gate (recibo verify-gate-20260912T093159Z-e2a6068d85c0).
    await screen.findByText('1 documento subido.')
    await waitFor(() => expect(screen.getByText('1 documento subido.')).toBeVisible())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    await waitFor(() => expect(screen.queryByText('1 documento subido.')).not.toBeInTheDocument())
  })
})
