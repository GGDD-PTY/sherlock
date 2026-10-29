// ============================================================================
// VISOR XLSX — ESQUELETO POR FASES
// ============================================================================
// El libro de SAMPLE_HYDRO tarda ~27,5 s en pintar (PR #490). Lo que se prueba aqui es
// que ese rato deja de ser mudo: cada marca del sidecar cambia el texto del
// esqueleto, `rendered` lo retira y `error` cae en el estado de error honesto.
//
// La prueba habla el protocolo real: se hace pasar por el sidecar, saluda con
// `mog:hello` desde el `contentWindow` del iframe y responde por el MessagePort
// que el host le transfiere. No hay stub del reductor.
// ============================================================================

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewerChromeProps } from '@/components/documents/viewers/ViewerChrome'
import { XlsxViewer } from '@/components/documents/viewers/XlsxViewer'
import esMessages from '@/messages/es.json'

const COPY = esMessages.vdr.viewer

const hostTheme = vi.hoisted(() => ({ theme: 'dark', resolvedTheme: 'dark' }))
vi.mock('@/components/providers/ThemeProvider', () => ({ useTheme: () => hostTheme }))

let grantSerial = 0

/** Cada test estrena URL: el hook de bytes deduplica por URL a nivel de modulo. */
function nextGrantUrl(): string {
  grantSerial += 1
  return `/api/documents/access/grant_${grantSerial}?token=t${grantSerial}`
}

type Sidecar = {
  port: MessagePort
  opened: { fileName: string; workbookId: string }
  /** Espia del `postMessage` del iframe: cuenta envios y guarda el targetOrigin. */
  send: ReturnType<typeof vi.spyOn>
  hello: (origin?: string) => void
  /** Cita otra hoja sobre el mismo grant, como haria el asistente de sala. */
  cite: (sheet: string) => Promise<void>
  unmount: () => void
}

/**
 * Espia del `postMessage` del iframe que respeta la semantica de structured
 * clone: un MessagePort ya transferido queda neutralizado y volver a
 * transferirlo lanza `DataCloneError`. Sin esta parte, la prueba del saludo
 * repetido pasaria contra un host roto.
 */
function spyOnSidecarPost(sidecarWindow: Window, capture: (port: MessagePort) => void) {
  const transferred = new WeakSet<MessagePort>()
  return vi
    .spyOn(sidecarWindow, 'postMessage')
    .mockImplementation((_message: unknown, _targetOrigin?: unknown, transfer?: unknown) => {
      for (const port of (transfer as MessagePort[] | undefined) ?? []) {
        if (transferred.has(port)) {
          throw new DOMException('port already transferred', 'DataCloneError')
        }
        transferred.add(port)
        capture(port)
      }
    })
}

/**
 * Drena microtareas y la cola del MessagePort. Se usa en vez de `waitFor` en
 * todo lo que el apreton de manos necesita: las pruebas del vigilante falsean
 * `setTimeout`, y con el reloj falso `waitFor` no avanza ni se rinde.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
  })
}

/**
 * Monta el visor y completa el apreton de manos como lo haria el sidecar.
 * Devuelve el puerto por el que la prueba publica las marcas.
 */
async function mountViewer(
  options: { chrome?: ViewerChromeProps; sheet?: string } = {}
): Promise<Sidecar> {
  // El grant se fija una vez: un `viewUrl` nuevo seria una apertura nueva, y lo
  // que se prueba aqui es citar otra hoja sobre el MISMO libro.
  const viewUrl = nextGrantUrl()
  const view = (sheet?: string) => (
    <XlsxViewer
      viewUrl={viewUrl}
      fileName="modelo-samplehydro.xlsx"
      workbookId="wb_samplehydro"
      chrome={options.chrome}
      sheet={sheet}
    />
  )
  const { rerender, unmount } = render(view(options.sheet))

  const frame = screen.getByTestId('document-viewer-mog-frame') as HTMLIFrameElement
  const sidecarWindow = frame.contentWindow as Window
  let port: MessagePort | null = null
  const send = spyOnSidecarPost(sidecarWindow, (transferred) => {
    port = transferred
  })

  const opened: { fileName: string; workbookId: string }[] = []
  const hello = (origin = window.location.origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mog:hello' },
        source: sidecarWindow,
        origin,
      })
    )
  }

  // El host solo escucha el saludo despues de tener los bytes: se repite igual
  // que lo hace el sidecar real hasta que el canal aparece.
  for (let attempt = 0; attempt < 20 && port === null; attempt += 1) {
    hello()
    await flush()
  }
  expect(port).not.toBeNull()

  const sidecarPort = port as unknown as MessagePort
  sidecarPort.onmessage = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type === 'open') opened.push(event.data)
  }
  sidecarPort.start()
  for (let attempt = 0; attempt < 20 && opened.length === 0; attempt += 1) await flush()
  expect(opened).toHaveLength(1)

  return {
    port: sidecarPort,
    opened: opened[0],
    send,
    hello,
    cite: async (sheet: string) => {
      rerender(view(sheet))
      await flush()
    },
    unmount,
  }
}

/**
 * Espera a que los bytes se resuelvan y el efecto del canal quede montado. Sin
 * esto, un saludo enviado antes del listener "pasa" la prueba sin probar nada.
 */
async function whenHandshakeListenerIsLive() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const label = () => screen.getByTestId('document-viewer-frame-loading-label').textContent

describe('XlsxViewer — progreso por fases', () => {
  it('transmite oscuro al iniciar y sigue claro/sistema sin reabrir el libro', async () => {
    const sidecar = await mountViewer()
    expect(sidecar.send.mock.calls[0]?.[0]).toEqual({
      type: 'mog:init',
      theme: { colorScheme: 'dark', resolvedColorScheme: 'dark' },
    })
    const messages: unknown[] = []
    sidecar.port.addEventListener('message', (event: MessageEvent) => {
      messages.push(event.data)
    })
    hostTheme.theme = 'light'
    hostTheme.resolvedTheme = 'light'
    await sidecar.cite('Supuestos')
    hostTheme.theme = 'system'
    hostTheme.resolvedTheme = 'dark'
    await sidecar.cite('Balance')
    hostTheme.resolvedTheme = 'light'
    await sidecar.cite('Resultados')
    expect(messages).toEqual([
      { type: 'theme', theme: { colorScheme: 'light', resolvedColorScheme: 'light' } },
      { type: 'theme', theme: { colorScheme: 'system', resolvedColorScheme: 'dark' } },
      { type: 'theme', theme: { colorScheme: 'system', resolvedColorScheme: 'light' } },
    ])
    expect(sidecar.send).toHaveBeenCalledTimes(1)
    sidecar.port.close()
    sidecar.unmount()
  })

  beforeEach(() => {
    hostTheme.theme = 'dark'
    hostTheme.resolvedTheme = 'dark'
    vi.stubEnv('NEXT_PUBLIC_XLSX_PHASE_MARKS', 'true')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4])))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /**
   * Solo `setTimeout`: el vigilante es lo unico que se adelanta. El reloj del
   * contador (`setInterval`) y la entrega del MessagePort siguen siendo reales,
   * asi que la prueba adelanta el silencio sin congelar el protocolo.
   */
  const withFakeWatchdogClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  it('recibe los bytes por el puerto privado, nunca la URL del grant', async () => {
    const sidecar = await mountViewer()

    expect(sidecar.opened).toMatchObject({ fileName: 'modelo-samplehydro.xlsx', workbookId: 'wb_samplehydro' })
    expect(screen.getByTestId('document-viewer-mog-frame')).toHaveAttribute(
      'src',
      '/mog/index.html'
    )
  })

  it('transfiere el puerto solo al origen del host, nunca con comodin', async () => {
    const sidecar = await mountViewer()

    expect(sidecar.send).toHaveBeenCalledTimes(1)
    const [message, targetOrigin, transfer] = sidecar.send.mock.calls[0]
    expect(message).toEqual({
      type: 'mog:init',
      theme: { colorScheme: 'dark', resolvedColorScheme: 'dark' },
    })
    expect(targetOrigin).toBe(window.location.origin)
    expect(targetOrigin).not.toBe('*')
    expect(transfer).toHaveLength(1)
  })

  it('ignora el saludo repetido del sidecar en vez de retransferir el puerto', async () => {
    const sidecar = await mountViewer()

    // El sidecar repite `mog:hello` cada 250 ms hasta que llega el puerto, y
    // ese aviso sigue en vuelo despues del apreton. Retransferir el puerto ya
    // neutralizado lanza DataCloneError y el esqueleto se queda para siempre.
    sidecar.hello()
    sidecar.hello()

    expect(sidecar.send).toHaveBeenCalledTimes(1)

    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 900 })
    await waitFor(() =>
      expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    )
  })

  it('rechaza un saludo con origen opaco aunque venga de la ventana del iframe', async () => {
    render(<XlsxViewer viewUrl={nextGrantUrl()} fileName="modelo.xlsx" workbookId="wb_opaque" />)
    const frame = screen.getByTestId('document-viewer-mog-frame') as HTMLIFrameElement
    const sidecarWindow = frame.contentWindow as Window
    const send = spyOnSidecarPost(sidecarWindow, () => undefined)
    await whenHandshakeListenerIsLive()

    const helloFrom = (origin: string) =>
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'mog:hello' }, source: sidecarWindow, origin })
      )

    // El sandbox declara `allow-same-origin` (spike R0): el sidecar NUNCA se
    // presenta con origen opaco, asi que uno opaco no es este iframe.
    for (const origin of ['null', '', 'https://evil.example']) helloFrom(origin)
    expect(send).not.toHaveBeenCalled()

    // Y el listener estaba vivo: el origen propio si abre el canal.
    helloFrom(window.location.origin)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('cambia el texto con cada marca y retira el esqueleto en rendered', async () => {
    const sidecar = await mountViewer()
    const seen: string[] = [label() as string]

    for (const [phase, at] of [
      ['boot', 10],
      ['bytes-received', 40],
      ['wasm-ready', 700],
      ['parsing', 701],
      ['first-sheet', 24_400],
    ] as const) {
      sidecar.port.postMessage({ type: 'phase', phase, at })
      await waitFor(() => expect(label()).not.toBe(seen.at(-1)))
      seen.push(label() as string)
    }

    expect(seen).toEqual([
      COPY.loadingSheets,
      COPY.phaseBoot,
      COPY.phaseBytesReceived,
      COPY.phaseWasmReady,
      COPY.phaseParsing,
      COPY.phaseFirstSheet,
    ])
    // El norte del item B3a: al menos dos cambios de texto durante la apertura.
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3)

    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 27_500 })
    await waitFor(() =>
      expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    )

    expect(screen.getByTestId('document-viewer-mog-frame')).toHaveAttribute(
      'data-xlsx-marks',
      'boot:10 bytes-received:40 wasm-ready:700 parsing:701 first-sheet:24400 rendered:27500'
    )
  })

  it('no publica los ganchos de tiempo cuando la bandera de specs esta apagada', async () => {
    vi.stubEnv('NEXT_PUBLIC_XLSX_PHASE_MARKS', '')
    const sidecar = await mountViewer()
    sidecar.port.postMessage({ type: 'phase', phase: 'parsing', at: 50 })
    await waitFor(() => expect(label()).toBe(COPY.phaseParsing))

    const frame = screen.getByTestId('document-viewer-mog-frame')
    expect(frame).not.toHaveAttribute('data-xlsx-marks')
    expect(frame).not.toHaveAttribute('data-xlsx-phase')
  })

  it('no mueve el texto con una marca desconocida o repetida', async () => {
    const sidecar = await mountViewer()

    sidecar.port.postMessage({ type: 'phase', phase: 'parsing', at: 50 })
    await waitFor(() => expect(label()).toBe(COPY.phaseParsing))

    for (const noise of [
      { type: 'phase', phase: 'compilando-todo', at: 60 },
      { type: 'phase', phase: 'boot', at: 61 },
      { type: 'phase', phase: 'parsing', at: 62 },
      { type: 'ready' },
    ]) {
      sidecar.port.postMessage(noise)
    }
    sidecar.port.postMessage({ type: 'phase', phase: 'first-sheet', at: 900 })

    await waitFor(() => expect(label()).toBe(COPY.phaseFirstSheet))
    expect(screen.getByTestId('document-viewer-mog-frame')).toHaveAttribute(
      'data-xlsx-marks',
      'parsing:50 first-sheet:900'
    )
  })

  it('cae en el error del visor cuando el sidecar reporta un fallo', async () => {
    const sidecar = await mountViewer()

    sidecar.port.postMessage({ type: 'phase', phase: 'parsing', at: 50 })
    await waitFor(() => expect(label()).toBe(COPY.phaseParsing))

    sidecar.port.postMessage({ type: 'error', message: 'boom', at: 60 })

    await waitFor(() => expect(screen.getByTestId('document-viewer-error')).toBeInTheDocument())
    expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    // Mensaje generico: el detalle del sidecar no llega al cliente.
    expect(screen.getByTestId('document-viewer-error').textContent).not.toContain('boom')
  })

  it('conserva la hoja abierta cuando el fallo llega despues de rendered', async () => {
    const sidecar = await mountViewer({ sheet: 'EEFF' })

    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 27_500 })
    await waitFor(() =>
      expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('document-viewer-indicator')).toHaveTextContent('EEFF')

    // Citar una celda que no existe cae en `applyNavigation(...).catch` y el
    // sidecar publica `error` con la hoja pintada. Desmontarla cambiaria un
    // libro que funciona por una pantalla de error.
    sidecar.port.postMessage({ type: 'error', message: 'sheet not found', at: 28_000 })

    await waitFor(() =>
      expect(screen.getByTestId('document-viewer-notice')).toHaveTextContent(COPY.partialError)
    )
    // Region viva: el cambio se anuncia sin robarle el foco a la hoja.
    expect(screen.getByTestId('document-viewer-notice')).toHaveAttribute('role', 'status')
    expect(screen.queryByTestId('document-viewer-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-viewer-mog-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    // El indicador nombraba la hoja citada; con la cita fallida ya no sabe si
    // es la que esta en pantalla, asi que se calla en vez de mentir.
    expect(screen.queryByTestId('document-viewer-indicator')).not.toBeInTheDocument()
  })

  it('retira el aviso cuando el asistente cita otra hoja', async () => {
    const sidecar = await mountViewer({ sheet: 'EEFF' })

    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 27_500 })
    await waitFor(() =>
      expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    )
    sidecar.port.postMessage({ type: 'error', message: 'sheet not found', at: 28_000 })
    await waitFor(() => expect(screen.getByTestId('document-viewer-notice')).toBeInTheDocument())

    // El aviso describe el ULTIMO intento. Si el cliente cita otra celda, el
    // visor no puede seguir diciendo que algo fallo hasta que se desmonte.
    await sidecar.cite('Deuda')

    expect(screen.queryByTestId('document-viewer-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-viewer-indicator')).toHaveTextContent('Deuda')
    expect(screen.getByTestId('document-viewer-mog-frame')).toBeInTheDocument()
  })

  it('no vigila al sidecar despues de que el libro abrio', async () => {
    withFakeWatchdogClock()
    const sidecar = await mountViewer()

    sidecar.port.postMessage({ type: 'phase', phase: 'first-sheet', at: 24_400 })
    await flush()
    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 27_500 })
    await flush()

    // El plazo que armo `first-sheet` tiene que morir con `rendered`. Si
    // sobrevive, noventa segundos despues avisa de un fallo sobre una hoja
    // perfectamente sana.
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })

    expect(screen.queryByTestId('document-viewer-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-viewer-mog-frame')).toBeInTheDocument()
  })

  it('no deja el plazo vivo cuando el visor se desmonta', async () => {
    withFakeWatchdogClock()
    const sidecar = await mountViewer()

    sidecar.port.postMessage({ type: 'phase', phase: 'parsing', at: 50 })
    await flush()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    // Cerrar el visor a media apertura no puede dejar un plazo retenido sobre
    // el canal, el iframe y la copia de los bytes.
    sidecar.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('no anuncia nada mientras la apertura va bien', async () => {
    const sidecar = await mountViewer()

    sidecar.port.postMessage({ type: 'phase', phase: 'rendered', at: 900 })
    await waitFor(() =>
      expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    )

    expect(screen.queryByTestId('document-viewer-notice')).not.toBeInTheDocument()
  })

  it('ofrece reintento cuando el sidecar se cuelga despues del apreton', async () => {
    withFakeWatchdogClock()
    const onRetry = vi.fn()
    const sidecar = await mountViewer({
      chrome: { fileName: 'modelo-samplehydro.xlsx', kind: 'xlsx', onRetry },
    })

    sidecar.port.postMessage({ type: 'phase', phase: 'first-sheet', at: 24_400 })
    await flush()
    expect(label()).toBe(COPY.phaseFirstSheet)

    // El WASM se atasca o el `rendered` se pierde: el sidecar calla y el
    // esqueleto se quedaria ahi para siempre con el contador subiendo.
    await act(async () => {
      vi.advanceTimersByTime(90_000)
    })

    expect(screen.getByTestId('document-viewer-error')).toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-frame-loading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: COPY.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('cae en error si el sidecar nunca saluda', async () => {
    withFakeWatchdogClock()
    render(<XlsxViewer viewUrl={nextGrantUrl()} fileName="modelo.xlsx" workbookId="wb_missing" />)
    await flush()

    // Un build sin `public/mog/` sirve el 404 de Next dentro del iframe: no hay
    // saludo, no hay puerto y nada mas va a llegar.
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(screen.getByTestId('document-viewer-error')).toBeInTheDocument()
  })

  it('no corta un libro lento que sigue publicando marcas', async () => {
    withFakeWatchdogClock()
    const sidecar = await mountViewer()

    // Cuatro minutos de apertura con tramos de 60 s: el vigilante mide el
    // SILENCIO del sidecar, no cuanto tarda el libro en abrir.
    for (const [phase, at, copy] of [
      ['bytes-received', 60_000, COPY.phaseBytesReceived],
      ['wasm-ready', 120_000, COPY.phaseWasmReady],
      ['parsing', 180_000, COPY.phaseParsing],
      ['first-sheet', 240_000, COPY.phaseFirstSheet],
    ] as const) {
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      sidecar.port.postMessage({ type: 'phase', phase, at })
      await flush()
      expect(label()).toBe(copy)
    }

    expect(screen.queryByTestId('document-viewer-error')).not.toBeInTheDocument()
  })

  it('ignora un saludo que no viene de la ventana del iframe', async () => {
    render(<XlsxViewer viewUrl={nextGrantUrl()} fileName="modelo.xlsx" workbookId="wb_other" />)
    const frame = screen.getByTestId('document-viewer-mog-frame') as HTMLIFrameElement
    const sidecarWindow = frame.contentWindow as Window
    const send = spyOnSidecarPost(sidecarWindow, () => undefined)
    await whenHandshakeListenerIsLive()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mog:hello' },
        source: window,
        origin: window.location.origin,
      })
    )

    expect(send).not.toHaveBeenCalled()
    expect(label()).toBe(COPY.loadingSheets)
  })

  it('no muestra el contador antes del primer segundo', async () => {
    render(<XlsxViewer viewUrl={nextGrantUrl()} fileName="modelo.xlsx" workbookId="wb_zero" />)

    expect(label()).toBe(COPY.loadingSheets)
    expect(screen.queryByTestId('document-viewer-frame-loading-detail')).not.toBeInTheDocument()

    // La descarga de bytes se resuelve despues de las aserciones: se drena aqui
    // para no dejar un setState fuera de `act`.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it('muestra los segundos transcurridos en mono, fuera del arbol accesible', async () => {
    const sidecar = await mountViewer()
    sidecar.port.postMessage({ type: 'phase', phase: 'parsing', at: 50 })
    await waitFor(() => expect(label()).toBe(COPY.phaseParsing))

    // Reloj real: el contador vive en un `setInterval` de 1 s y falsear el
    // tiempo aqui congelaria tambien la entrega del MessagePort.
    const detail = await screen.findByTestId(
      'document-viewer-frame-loading-detail',
      {},
      { timeout: 6_000 }
    )

    expect(detail.textContent).toMatch(/^\d+ s$/)
    expect(detail).toHaveAttribute('aria-hidden', 'true')
    expect(detail.className).toContain('font-mono')
    expect(detail.className).toContain('tabular-nums')
    // La escala de docs/design-system.md es 12/14/16: 12px es metadata, y un
    // tamano arbitrario fuera de la escala es una violacion del contrato.
    expect(detail.className).toContain('text-xs')
    expect(detail.className).not.toMatch(/text-\[/)
    // La region viva anuncia la fase, no el contador.
    expect(screen.getByTestId('document-viewer-frame-loading')).toHaveAttribute(
      'aria-label',
      COPY.phaseParsing
    )
  })
})
