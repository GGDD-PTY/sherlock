import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfViewer } from '@/components/documents/viewers/PdfViewer'

type MockTextContent = { items: { str?: string }[]; styles: Record<string, never>; lang: null }
type MockViewport = { width: number; height: number; scale: number; userUnit: number }

const {
  destroyTask,
  getDocument,
  getTextContent,
  pageRotate,
  PasswordException,
  PasswordResponses,
  pdfjsImported,
  renderCalls,
  resolveRender,
  TextLayer,
  textLayers,
  viewportCalls,
} = vi.hoisted(() => {
  const pdfjsImported = vi.fn()
  const destroyTask = vi.fn(() => Promise.resolve())
  const renderCalls: { canvas: HTMLCanvasElement; scale: number }[] = []
  let pending: (() => void)[] = []
  const resolveRender = () => {
    const waiting = pending
    pending = []
    for (const resolve of waiting) resolve()
  }
  const getTextContent = vi.fn((page: number): Promise<MockTextContent> =>
    Promise.resolve({ items: [{ str: `Texto de la página ${page}` }], styles: {}, lang: null })
  )
  // Cada `getViewport` que pide el visor, con la escala Y el angulo: girar el
  // lienzo y no la capa de texto es invisible para una asercion de escala.
  const viewportCalls: { scale: number; rotation: number }[] = []
  // El `/Rotate` de la hoja, el que trae el PDF. Un escaneo apaisado llega con
  // 90 y el visor tiene que respetarlo antes de que nadie toque un boton.
  const pageRotate = { value: 0 }
  const passwordResponses = { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 } as const
  class MockPasswordException extends Error {
    constructor(
      message: string,
      readonly code: number
    ) {
      super(message)
      this.name = 'PasswordException'
    }
  }
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: (page: number) =>
        Promise.resolve({
          rotate: pageRotate.value,
          getViewport: ({ scale, rotation }: { scale: number; rotation: number }): MockViewport => {
            viewportCalls.push({ scale, rotation })
            // pdf.js intercambia ancho y alto en los cuartos de giro impares.
            const quarterTurn = rotation % 180 !== 0
            return {
              width: (quarterTurn ? 800 : 600) * scale,
              height: (quarterTurn ? 600 : 800) * scale,
              scale,
              userUnit: 1,
            }
          },
          render: ({
            canvas,
            viewport,
          }: {
            canvas: HTMLCanvasElement
            viewport: { width: number }
          }) => {
            renderCalls.push({ canvas, scale: viewport.width / 600 })
            return {
              promise: new Promise<void>((resolve) => pending.push(resolve)),
              cancel: () => undefined,
            }
          },
          getTextContent: () => getTextContent(page),
        }),
    }),
    destroy: destroyTask,
  }))
  // Doble de `TextLayer` de pdf.js: un <span> por corrida de texto dentro del
  // contenedor, como el real, sin medir fuentes ni calcular posiciones. Lo que
  // se registra es lo que el visor le entrega: contenedor y escala.
  const textLayers: { container: HTMLElement; scale: number }[] = []
  class TextLayer {
    readonly #source: MockTextContent
    readonly #container: HTMLElement
    constructor({
      textContentSource,
      container,
      viewport,
    }: {
      textContentSource: MockTextContent
      container: HTMLElement
      viewport: MockViewport
    }) {
      this.#source = textContentSource
      this.#container = container
      textLayers.push({ container, scale: viewport.scale })
    }
    render() {
      for (const item of this.#source.items) {
        if (item.str === undefined) continue
        const span = document.createElement('span')
        span.setAttribute('role', 'presentation')
        span.textContent = item.str
        this.#container.append(span)
      }
      return Promise.resolve()
    }
    cancel() {}
  }
  return {
    destroyTask,
    getDocument,
    getTextContent,
    pageRotate,
    PasswordException: MockPasswordException,
    PasswordResponses: passwordResponses,
    pdfjsImported,
    renderCalls,
    resolveRender,
    TextLayer,
    textLayers,
    viewportCalls,
  }
})

vi.mock('pdfjs-dist', () => {
  // La fabrica corre cuando el visor hace su `import('pdfjs-dist')`: asi se ve
  // CUANDO empieza a cargar pdf.js, no solo que lo hace.
  pdfjsImported()
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument,
    PasswordException,
    PasswordResponses,
    TextLayer,
  }
})

const drawImage = vi.fn()

describe('PdfViewer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    )
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ clearRect: () => undefined, drawImage }),
    })
  })

  afterEach(async () => {
    // Primero se desmonta y DESPUÉS se resuelve lo pendiente: los hooks corren
    // en pila (vitest `sequence.hooks: 'stack'`), así que el cleanup automático
    // de RTL llega detrás de este afterEach. Sin este orden, un render que un
    // test dejó pendiente se resolvía montado, y su cola asíncrona (drawImage,
    // getTextContent, `new TextLayer`) escribía en los registros ya limpios
    // del test siguiente (gate 7927418d1: dos capas donde había una).
    cleanup()
    resolveRender()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    vi.unstubAllGlobals()
    pdfjsImported.mockClear()
    destroyTask.mockClear()
    getDocument.mockClear()
    getTextContent.mockClear()
    drawImage.mockClear()
    renderCalls.length = 0
    textLayers.length = 0
    viewportCalls.length = 0
    pageRotate.value = 0
  })

  // En frio, pdf.js (chunk de 130 KB + worker de 1,2 MB) solo empezaba a bajar
  // cuando los bytes del PDF ya habian llegado: 0,4 s en serie detras de un
  // informe de 5 MB a 20 Mbps (hillclimb 2026-09-03). El visor arranca ambos al
  // montar, en paralelo con la descarga del grant.
  it('starts loading pdf.js and warming its worker before the bytes arrive', async () => {
    // Grant que nunca llega: lo unico que puede haber pasado es lo de antes.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )
    vi.resetModules()
    const { PdfViewer: FreshPdfViewer } = await import('@/components/documents/viewers/PdfViewer')
    const linksBefore = document.head.querySelectorAll(
      'link[rel="prefetch"][href="/pdfjs/pdf.worker.min.mjs"]'
    ).length

    render(<FreshPdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    await waitFor(() => expect(pdfjsImported).toHaveBeenCalled())
    expect(
      document.head.querySelectorAll('link[rel="prefetch"][href="/pdfjs/pdf.worker.min.mjs"]')
    ).toHaveLength(linksBefore + 1)
    expect(getDocument).not.toHaveBeenCalled()
  })

  it('destroys the loading task on unmount instead of crashing the room', async () => {
    const { unmount, findByTestId } = render(
      <PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />
    )
    await findByTestId('document-viewer-pdf-pagination')
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1))

    expect(() => unmount()).not.toThrow()
    expect(destroyTask).toHaveBeenCalledTimes(1)
  })

  it('explains a password-protected PDF without offering a useless retry', async () => {
    getDocument.mockImplementationOnce(() => ({
      promise: Promise.reject(
        new PasswordException('Password required', PasswordResponses.NEED_PASSWORD)
      ),
      destroy: destroyTask,
    }))
    const onRetry = vi.fn()

    render(
      <PdfViewer
        viewUrl="/api/documents/access/grant?token=t"
        fileName="informe.pdf"
        chrome={{ fileName: 'informe.pdf', kind: 'PDF', onRetry }}
      />
    )

    expect(await screen.findByText('Este PDF tiene contraseña')).toBeInTheDocument()
    expect(
      screen.getByText('No podemos abrirlo aquí. Quítale la contraseña y vuelve a subirlo.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Intentar de nuevo' })).not.toBeInTheDocument()
  })

  it('makes the scrollable document area reachable and named for keyboard users', async () => {
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const documentArea = await screen.findByRole('region', { name: 'Área del documento' })

    expect(documentArea).toHaveAttribute('tabindex', '0')
  })

  // El parpadeo del zoom venía de redimensionar el lienzo visible ANTES de
  // pintarlo: `canvas.width = n` lo borra, y hasta que pdf.js terminaba de
  // rasterizar quedaba un fotograma en blanco. Se rasteriza fuera de pantalla y
  // el lienzo visible se toca una sola vez, ya con la página lista.
  it('never clears the visible canvas before the page is rasterized', async () => {
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const canvas = await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))

    // pdf.js rasteriza en un lienzo que no es el que se está mirando, y el
    // visible sigue sin dimensiones propias mientras tanto.
    expect(renderCalls[0]!.canvas).not.toBe(canvas)
    expect(canvas.getAttribute('width')).toBeNull()
    expect((canvas as HTMLCanvasElement).style.width).toBe('')
    expect(drawImage).not.toHaveBeenCalled()

    resolveRender()

    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1))
    expect(drawImage.mock.calls[0]![0]).toBe(renderCalls[0]!.canvas)
    expect((canvas as HTMLCanvasElement).style.width).not.toBe('')
  })

  it('bounds a high-zoom DPR 3 backing canvas without changing its CSS dimensions', async () => {
    vi.stubGlobal('devicePixelRatio', 3)
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const canvas = (await screen.findByTestId('document-viewer-pdf-canvas')) as HTMLCanvasElement
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('document-viewer-pdf-zoom'))
    await userEvent.click(screen.getByRole('option', { name: '200%' }))
    await waitFor(() => expect(renderCalls).toHaveLength(2))

    const backingCanvas = renderCalls[1]!.canvas
    expect(backingCanvas.width * backingCanvas.height).toBeLessThanOrEqual(8_000_000)

    resolveRender()
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2))
    expect(Number.parseFloat(canvas.style.width)).toBeCloseTo(1_600, 5)
    expect(Number.parseFloat(canvas.style.height)).toBeCloseTo(6_400 / 3, 5)
  })

  it('offers fit-to-width plus real page percentages, and re-renders at the chosen one', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()

    await userEvent.click(screen.getByTestId('document-viewer-pdf-zoom'))
    // `vdr.viewer.zoomFit` en es.json: el modo ajustar-al-ancho se anuncia con su
    // texto, no con la ruta de la clave.
    expect(await screen.findByRole('option', { name: 'Ajustar' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: '150%' }))

    await waitFor(() => expect(renderCalls).toHaveLength(2))
    // 150% de tamaño real: 1.5 × (96/72), sin depender del ancho del panel.
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    expect(renderCalls[1]!.scale).toBeCloseTo(1.5 * (96 / 72) * dpr, 5)
  })

  // Hasta aquí la hoja era una imagen: para el lector de pantalla, para Ctrl+F
  // y para seleccionar, el PDF no tenía texto (auditoría 2026-09-06, F10).
  // pdf.js pone un <span> transparente por corrida encima del lienzo; el
  // lienzo sale del árbol de accesibilidad y el nombre del archivo sigue
  // dentro del área del documento.
  it('lays a selectable text layer over the canvas once the page is painted', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const canvas = await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    // El texto se pide DESPUÉS de pintar, nunca antes: la hoja visible manda.
    expect(getTextContent).not.toHaveBeenCalled()
    expect(canvas).toHaveAttribute('aria-label', 'Visor del documento informe.pdf')

    resolveRender()

    const layer = screen.getByTestId('document-viewer-pdf-text-layer')
    await waitFor(() => expect(layer).toHaveTextContent('Texto de la página 1'))
    await waitFor(() => expect(canvas).toHaveAttribute('aria-hidden', 'true'))
    expect(canvas).not.toHaveAttribute('aria-label')
    expect(screen.getByRole('region', { name: 'Área del documento' })).toContainElement(layer)
    expect(screen.getByRole('document', { name: 'Visor del documento informe.pdf' })).toBe(layer)
    expect(getTextContent).toHaveBeenCalledWith(1)

    // La capa calza con la escala CSS de la hoja (900 px de ancho útil / 600 pt),
    // no con la del raster, que ya multiplica el DPR.
    expect(textLayers).toHaveLength(1)
    expect(textLayers[0]!.container).toBe(layer)
    expect(textLayers[0]!.scale).toBeCloseTo(1.5, 5)
    expect(renderCalls[0]!.scale).toBeCloseTo(3, 5)
    expect(layer.style.getPropertyValue('--scale-factor')).toBe('1.5')
  })

  it('replaces the text layer when the page changes', async () => {
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    const layer = screen.getByTestId('document-viewer-pdf-text-layer')
    await waitFor(() => expect(layer).toHaveTextContent('Texto de la página 1'))

    await userEvent.click(screen.getByTestId('document-viewer-pdf-next'))
    await waitFor(() => expect(renderCalls).toHaveLength(2))
    resolveRender()

    await waitFor(() => expect(layer).toHaveTextContent('Texto de la página 2'))
    expect(layer).not.toHaveTextContent('Texto de la página 1')
    expect(getTextContent).toHaveBeenNthCalledWith(2, 2)
    await waitFor(() =>
      expect(screen.getByTestId('document-viewer-pdf-canvas')).toHaveAttribute(
        'aria-hidden',
        'true'
      )
    )
  })

  // La capa se monta exactamente una vez por (página, escala CSS). Otro zoom
  // la rehace (otra escala) sin volver a pedir el texto al worker; un ancho
  // nuevo con el zoom fijo repinta el lienzo a la misma escala y la capa
  // montada se queda: las posiciones van en % de la hoja y el tamaño por
  // `--scale-factor`, así que sigue calzando.
  it('lays the text once per page and css scale: zoom rebuilds it, a same-scale repaint keeps it', async () => {
    // ResizeObserver que se dispara a mano, como el del navegador al cambiar
    // el ancho del marco.
    const observer: { resize: ((entries: { contentRect: { width: number } }[]) => void) | null } = {
      resize: null,
    }
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
          observer.resize = callback
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    const layer = screen.getByTestId('document-viewer-pdf-text-layer')
    await waitFor(() => expect(textLayers).toHaveLength(1))

    await userEvent.click(screen.getByTestId('document-viewer-pdf-zoom'))
    await userEvent.click(screen.getByRole('option', { name: '150%' }))
    await waitFor(() => expect(renderCalls).toHaveLength(2))
    resolveRender()

    await waitFor(() => expect(textLayers).toHaveLength(2))
    expect(textLayers[1]!.scale).toBeCloseTo(1.5 * (96 / 72), 5)
    expect(layer).toHaveTextContent('Texto de la página 1')
    expect(layer.querySelectorAll('span')).toHaveLength(1)
    expect(getTextContent).toHaveBeenCalledTimes(1)

    // Ancho nuevo con el zoom en 150 %: el lienzo se repinta a la misma escala
    // CSS y la capa no se toca.
    expect(observer.resize).not.toBeNull()
    act(() => observer.resize?.([{ contentRect: { width: 700 } }]))
    await waitFor(() => expect(renderCalls).toHaveLength(3))
    expect(renderCalls[2]!.scale).toBeCloseTo(renderCalls[1]!.scale, 5)
    resolveRender()
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(3))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(textLayers).toHaveLength(2)
    expect(layer.querySelectorAll('span')).toHaveLength(1)
    expect(layer).toHaveTextContent('Texto de la página 1')
    expect(getTextContent).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('document-viewer-pdf-canvas')).toHaveAttribute('aria-hidden', 'true')
  })

  // Un PDF escaneado no tiene texto que extraer, y pdf.js puede rechazar la
  // extracción: el lienzo se queda solo, conserva su etiqueta y no hay aviso.
  it('leaves the canvas alone, without an error, when the text cannot be extracted', async () => {
    getTextContent.mockRejectedValueOnce(new Error('sin texto'))
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const canvas = await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getTextContent).toHaveBeenCalledTimes(1))
    // El rechazo se procesa en microtareas: se deja pasar un turno antes de mirar.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(screen.getByTestId('document-viewer-pdf-text-layer')).toBeEmptyDOMElement()
    expect(textLayers).toHaveLength(0)
    expect(canvas).toHaveAttribute('aria-label', 'Visor del documento informe.pdf')
    expect(canvas).not.toHaveAttribute('aria-hidden')
    expect(screen.queryByTestId('document-viewer-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-viewer-pdf-pagination')).toBeInTheDocument()
  })

  // El giro es de la sesion del visor y tiene que llegar a TODOS los viewports:
  // el base que decide el ajuste al ancho, el del raster y el de la capa de
  // texto. Girar el lienzo y dejar la capa sin girar deja el texto
  // seleccionable cruzado sobre la hoja, que es peor que no poder girar.
  //
  // Y el angulo del visor se COMPONE con el `/Rotate` de la hoja: esta pagina
  // llega apaisada del propio PDF (90) y tiene que verse asi antes de que nadie
  // pulse nada. Pasar `rotation: 0` la enderezaba y la mostraba de costado.
  //
  // Se gira con el zoom FIJO en 150 % a proposito: asi la escala CSS no cambia
  // con el giro y lo unico que puede rehacer la capa de texto es el angulo.
  it('composes the viewer angle with the page own rotation across every viewport', async () => {
    pageRotate.value = 90
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    await waitFor(() => expect(textLayers).toHaveLength(1))
    // Sin un solo clic: la hoja se pinta con su propio angulo.
    expect(viewportCalls.length).toBeGreaterThan(0)
    expect(viewportCalls.every((call) => call.rotation === 90)).toBe(true)

    await userEvent.click(screen.getByTestId('document-viewer-pdf-zoom'))
    await userEvent.click(screen.getByRole('option', { name: '150%' }))
    await waitFor(() => expect(renderCalls).toHaveLength(2))
    resolveRender()
    await waitFor(() => expect(textLayers).toHaveLength(2))
    expect(viewportCalls.every((call) => call.rotation === 90)).toBe(true)

    expect(screen.getByRole('button', { name: 'Girar a la izquierda' })).toBe(
      screen.getByTestId('document-viewer-pdf-rotate-left')
    )
    const before = viewportCalls.length

    await userEvent.click(screen.getByRole('button', { name: 'Girar a la derecha' }))
    await waitFor(() => expect(renderCalls).toHaveLength(3))
    resolveRender()
    await waitFor(() => expect(textLayers).toHaveLength(3))

    // 90 de la hoja + 90 del cuarto de giro, en TODOS los viewports del
    // repintado: el del ajuste, el del raster y el de la capa de texto.
    const afterRotate = viewportCalls.slice(before)
    expect(afterRotate.length).toBeGreaterThan(0)
    expect(afterRotate.every((call) => call.rotation === 180)).toBe(true)
    // La capa se rehace sobre la hoja girada, con la MISMA escala CSS de antes
    // del giro, y el texto no se le vuelve a pedir al worker.
    expect(textLayers[2]!.scale).toBeCloseTo(textLayers[1]!.scale, 5)
    expect(getTextContent).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('document-viewer-pdf-text-layer')).toHaveTextContent(
      'Texto de la página 1'
    )
  })

  it('keeps the canvas described by its label when the page has only whitespace', async () => {
    getTextContent.mockResolvedValueOnce({ items: [{ str: '  ' }, {}], styles: {}, lang: null })
    render(<PdfViewer viewUrl="/api/documents/access/grant?token=t" fileName="informe.pdf" />)

    const canvas = await screen.findByTestId('document-viewer-pdf-canvas')
    await waitFor(() => expect(renderCalls).toHaveLength(1))
    resolveRender()
    await waitFor(() => expect(getTextContent).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(textLayers).toHaveLength(0)
    expect(screen.getByTestId('document-viewer-pdf-text-layer')).toBeEmptyDOMElement()
    expect(canvas).toHaveAttribute('aria-label', 'Visor del documento informe.pdf')
    expect(canvas).not.toHaveAttribute('aria-hidden')
  })
})
