import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewerError, ViewerFrame } from '@/components/documents/viewers/ViewerChrome'

describe('ViewerFrame mobile focus model', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: '(max-width: 639.98px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('moves focus parent-to-iframe and iframe-to-parent through fullscreen guards', () => {
    render(
      <ViewerFrame chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', onClose: vi.fn<() => void>() }}>
        <iframe title="Mog workbook" />
      </ViewerFrame>
    )

    const close = screen.getByRole('button', { name: 'Cerrar' })
    const iframe = screen.getByTitle('Mog workbook')
    const before = screen.getByTestId('viewer-focus-before-content')
    const after = screen.getByTestId('viewer-focus-after-content')

    close.focus()
    expect(close).toHaveFocus()

    // Forward Tab from the parent reaches the leading guard, which moves into
    // the real iframe rather than relying on an event bubbling from it.
    before.focus()
    expect(iframe).toHaveFocus()

    // When browser focus exits the iframe forward, the trailing guard owns the
    // handoff back to the first parent control.
    after.focus()
    expect(close).toHaveFocus()

    // Reverse exit lands on the leading guard and wraps to the last parent
    // control without requiring iframe key events to bubble.
    iframe.focus()
    before.focus()
    expect(close).toHaveFocus()
  })
})

// El boton de pantalla completa es ADITIVO: apagado, el marco de escritorio
// tiene que ser el panel de siempre. Por eso cada caso mide contra la cadena
// `sm:static ...`, que es la que devuelve el marco a panel, y contra la
// ausencia del rol de dialogo.
describe('ViewerFrame fullscreen toggle on desktop', () => {
  const PANEL_CLASSES = 'sm:static'

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((media: string) => ({
        matches: false,
        media,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('leaves the desktop frame exactly as it is today while the toggle is off', () => {
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    const frame = screen.getByTestId('document-viewer-frame')
    expect(frame).not.toHaveAttribute('role')
    expect(frame).not.toHaveAttribute('aria-modal')
    expect(frame.className).toContain(PANEL_CLASSES)

    const toggle = screen.getByTestId('document-viewer-fullscreen')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAccessibleName('Pantalla completa')
  })

  // Agrandar a media carga era una promesa que el marco no podia sostener: el
  // renderer sigue montando su contenido. El boton no se ofrece hasta que el
  // documento esta en pantalla.
  it('keeps the toggle off until the renderer reports the document on screen', async () => {
    const { rerender } = render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx' }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    const toggle = screen.getByTestId('document-viewer-fullscreen')
    expect(toggle).toBeDisabled()

    await userEvent.click(toggle)
    expect(screen.getByTestId('document-viewer-frame')).not.toHaveAttribute('role')

    rerender(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    expect(screen.getByTestId('document-viewer-fullscreen')).toBeEnabled()
    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
    expect(screen.getByTestId('document-viewer-frame')).toHaveAttribute('role', 'dialog')
  })

  it('turns the same node into the modal frame without dropping it and remounting it', async () => {
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    const frame = screen.getByTestId('document-viewer-frame')
    const content = screen.getByText('contenido')

    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))

    expect(screen.getByTestId('document-viewer-fullscreen')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('document-viewer-fullscreen')).toHaveAccessibleName(
      'Salir de pantalla completa'
    )
    // El MISMO nodo: si el marco se remontara, el PDF perderia pagina y zoom y
    // el libro de Mog volveria a arrancar el motor.
    expect(screen.getByTestId('document-viewer-frame')).toBe(frame)
    expect(screen.getByText('contenido')).toBe(content)
    expect(frame).toHaveAttribute('role', 'dialog')
    expect(frame).toHaveAttribute('aria-modal', 'true')
    expect(frame).toHaveAttribute('aria-label', 'Modelo.xlsx')
    expect(frame.className).not.toContain(PANEL_CLASSES)
    expect(frame.className).toContain('fixed inset-0')
  })

  it('spends the first Escape on leaving fullscreen and only then closes the viewer', async () => {
    const onClose = vi.fn<() => void>()
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true, onClose }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
    expect(screen.getByTestId('document-viewer-frame')).toHaveAttribute('role', 'dialog')

    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-viewer-fullscreen')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('document-viewer-frame')).not.toHaveAttribute('role')

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // El marco corre primero POR CONSTRUCCION (captura sobre `window`), asi que
  // no puede mirar `defaultPrevented` para cederle la tecla a nadie. Una capa de
  // Radix abierta dentro del marco —el desplegable de zoom del PDF— portea su
  // contenido a `document.body` y escucha Esc en captura sobre `document`: si el
  // marco cortara ahi toda pulsacion, el desplegable se quedaria abierto, con su
  // foco atrapado, y lo que se cerraria seria la pantalla completa.
  it('leaves Escape to a layer that Radix rendered outside the frame', async () => {
    const onClose = vi.fn<() => void>()
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true, onClose }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
    expect(screen.getByTestId('document-viewer-frame')).toHaveAttribute('role', 'dialog')

    // El contenido portado de la capa, con el foco atrapado adentro, y el mismo
    // listener que le pone `DismissableLayer`: captura sobre `document` y, al
    // descartarse, `preventDefault()`.
    const layer = document.createElement('div')
    layer.tabIndex = -1
    document.body.append(layer)
    const dismissLayer = vi.fn((event: KeyboardEvent) => event.preventDefault())
    document.addEventListener('keydown', dismissLayer, true)
    layer.focus()

    await userEvent.keyboard('{Escape}')

    // La capa se lleva su Esc: el marco sigue expandido y el visor no se cierra.
    expect(dismissLayer).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('document-viewer-frame')).toHaveAttribute('role', 'dialog')
    expect(onClose).not.toHaveBeenCalled()

    document.removeEventListener('keydown', dismissLayer, true)
    layer.remove()

    // Cerrada la capa, el foco vuelve al marco y el Esc siguiente es suyo.
    screen.getByTestId('document-viewer-frame').focus()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('document-viewer-frame')).not.toHaveAttribute('role')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('returns focus to the toggle when it leaves fullscreen', async () => {
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    const toggle = screen.getByTestId('document-viewer-fullscreen')
    await userEvent.click(toggle)
    expect(screen.getByTestId('document-viewer-frame')).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('document-viewer-fullscreen')).toHaveFocus()
  })

  it('tells the host both when it takes the window and when it gives it back', async () => {
    const onExpandedChange = vi.fn<(expanded: boolean) => void>()
    render(
      <ViewerFrame
        testId="document-viewer-frame"
        chrome={{ fileName: 'Modelo.xlsx', kind: 'xlsx', ready: true, onExpandedChange }}
      >
        <div>contenido</div>
      </ViewerFrame>
    )

    // Nada que anunciar mientras el marco sea el panel de siempre.
    expect(onExpandedChange).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
    expect(onExpandedChange).toHaveBeenLastCalledWith(true)

    await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))
    expect(onExpandedChange).toHaveBeenLastCalledWith(false)
  })

  // A pantalla completa el marco tapa la fila de la sala, que es donde viven el
  // nombre, «Descargar» y «Cerrar visor». Sin esto, en pantalla completa no hay
  // como bajar el documento.
  describe('the room row the expanded frame covers', () => {
    const onDownload = vi.fn<() => void>()

    function renderFrame() {
      render(
        <ViewerFrame
          testId="document-viewer-frame"
          chrome={{
            fileName: 'Modelo.xlsx',
            kind: 'xlsx',
            ready: true,
            onDownload,
            onClose: vi.fn<() => void>(),
          }}
        >
          <div>contenido</div>
        </ViewerFrame>
      )
      return {
        nameRow: screen.getByText('Modelo.xlsx').parentElement,
        toolbar: screen.getByTestId('document-viewer-kind').parentElement,
      }
    }

    beforeEach(() => onDownload.mockClear())

    it('leaves the panel alone while the room keeps showing name and download', () => {
      const { nameRow, toolbar } = renderFrame()

      expect(nameRow?.className).toContain('sm:hidden')
      expect(toolbar?.className).toContain('sm:order-first')
      // Mientras la fila de la sala se vea, el marco no la repite.
      expect(screen.queryByTestId('document-viewer-download')).toBeNull()
    })

    it('keeps the bar download of a viewer mounted without the room row', () => {
      render(
        <ViewerFrame
          testId="document-viewer-frame-url"
          chrome={{
            fileName: 'Modelo.xlsx',
            kind: 'xlsx',
            ready: true,
            downloadUrl: '/grant/original',
          }}
        >
          <div>contenido</div>
        </ViewerFrame>
      )

      const anchor = screen.getByTestId('document-viewer-download')
      expect(anchor).toHaveAttribute('href', '/grant/original')
      expect(anchor.className).toContain('sm:inline-flex')
    })

    it('raises the name above the bar and carries the same download into it', async () => {
      const { nameRow, toolbar } = renderFrame()

      await userEvent.click(screen.getByTestId('document-viewer-fullscreen'))

      // El nombre deja de esconderse y la barra suelta el orden que la subia
      // por encima de el: en el DOM la fila del nombre ya venia primero.
      expect(nameRow?.className).not.toContain('sm:hidden')
      expect(toolbar?.className).not.toContain('sm:order-first')
      expect(toolbar?.className).not.toContain('order-last')

      // Uno solo, y dentro de la fila del nombre: el de la barra se apaga.
      const download = screen.getAllByTestId('document-viewer-download')
      expect(download).toHaveLength(1)
      expect(nameRow?.contains(download[0])).toBe(true)

      await userEvent.click(download[0])
      expect(onDownload).toHaveBeenCalledTimes(1)

      // La X es del movil: en escritorio expandido se sale por la barra y con
      // Esc, y un control oculto seria una parada muerta en la trampa de foco.
      expect(screen.queryByTestId('document-viewer-close')).toBeNull()
    })
  })
})

// `ready` lo declara quien monta el visor con el PRIMER `onReady`, y un renderer
// puede fallar despues de haber pintado: la pagina 1 de un PDF rasteriza y la 2
// revienta. El marco de error no puede heredar ese `ready` y ofrecer agrandar
// una tarjeta de fallo, que ademas tapa el «Cerrar visor» de la sala.
describe('ViewerError on desktop', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((media: string) => ({
        matches: false,
        media,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('never offers fullscreen over the failure card, even after the document had painted', () => {
    render(
      <ViewerError
        testId="document-viewer-error"
        chrome={{ fileName: 'Estados.pdf', kind: 'pdf', ready: true, onClose: vi.fn<() => void>() }}
      />
    )

    expect(screen.getByTestId('document-viewer-error')).toBeInTheDocument()
    expect(screen.getByTestId('document-viewer-fullscreen')).toBeDisabled()
  })
})
