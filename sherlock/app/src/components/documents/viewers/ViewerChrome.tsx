'use client'

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { CircleAlert, Download, FileText, Maximize2, Minimize2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Los tres estados que el marco sabe pintar, escritos UNA vez.
 *
 * Es el vocabulario del chrome, no el de cada renderer: `loading` es el
 * esqueleto, `ready` es el documento en pantalla y `error` reemplaza el
 * contenido por `ViewerError`. Cada visor deriva su estado de sus propios
 * bytes, pero lo que le entrega al marco es siempre uno de estos tres, y por
 * eso la lista vive aqui y no repetida en cada archivo.
 *
 * Union escrita directa, no `Schema.Literals`: aqui no entra ningun estado de
 * fuera que haya que validar ni ninguna lista que recorrer, asi que un schema
 * seria un valor muerto en el bundle.
 */
export type ViewerStatus = 'loading' | 'ready' | 'error'

// Debajo de `sm` el visor ocupa toda la ventana: ahi deja de ser un panel y se
// comporta como un dialogo (etiqueta, foco inicial, Esc, foco devuelto) y el
// documento de fondo no debe seguir desplazandose.
const FULLSCREEN_QUERY = '(max-width: 639.98px)'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'

/**
 * Las dos teclas que el marco reconoce del `KeyboardEvent` nativo. El
 * navegador puede emitir cualquier string en `event.key` (nombres largos,
 * teclas muertas, entrada de un lector de pantalla o de un dispositivo raro):
 * es la entrada de fuera que este archivo SI decodifica, en vez de comparar
 * contra un literal suelto en cada handler.
 */
const ViewerDismissKeySchema = Schema.Literals(['Escape'])
const isViewerDismissKey = Schema.is(ViewerDismissKeySchema)

const FocusTrapKeySchema = Schema.Literals(['Tab'])
const isFocusTrapKey = Schema.is(FocusTrapKeySchema)

/**
 * El segundo dato que entra de fuera: el `FocusEvent` puede traer un target o
 * un `relatedTarget` que TypeScript tipa como el elemento esperado, pero que
 * en runtime es lo que el navegador haya decidido enfocar al burbujear —
 * incluido un iframe embebido, que es la frontera que `handleBeforeContentFocus`
 * y `handleFocusCapture` necesitan distinguir de verdad.
 */
// `HTMLIFrameElement` solo existe en el navegador. Este componente es
// 'use client', pero Next lo renderiza también en el servidor, y ahí un
// `Schema.instanceOf(HTMLIFrameElement)` a nivel de módulo revienta la carga
// del chunk entero (ReferenceError en prod, React #419 en el cliente). El
// schema se arma en la primera llamada, que siempre viene de un evento del DOM.
function isFocusTargetIframe(value: unknown): value is HTMLIFrameElement {
  if (typeof HTMLIFrameElement === 'undefined') return false
  return Schema.is(Schema.instanceOf(HTMLIFrameElement))(value)
}

function subscribeFullscreen(onChange: () => void) {
  const query = window.matchMedia(FULLSCREEN_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function useViewerIsFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => window.matchMedia(FULLSCREEN_QUERY).matches,
    () => false
  )
}

/**
 * Carga con esqueleto que imita la pagina que viene (barra + hoja), no un
 * spinner. La etiqueta queda para lectores de pantalla y como texto discreto.
 *
 * `paper` pinta la hoja del color que va a tener el documento cargado (blanco
 * en PDF, DOCX y el libro del sidecar): el esqueleto tiene que espejar la
 * estructura Y la superficie finales, si no el cambio se percibe como un flash.
 *
 * `detail` es la cifra de la espera (segundos transcurridos), en mono y fuera
 * del arbol de accesibilidad: la region viva anuncia el CAMBIO DE FASE, que es
 * informacion; un contador que cambia cada segundo dentro de un `role=status`
 * seria un lector de pantalla hablando sin parar.
 */
export function ViewerLoading({
  label,
  detail,
  testId,
  paper = false,
}: {
  label: string
  detail?: ReactNode
  testId: string
  paper?: boolean
}) {
  return (
    <div
      data-testid={testId}
      role="status"
      aria-label={label}
      className="bg-background flex h-full min-h-64 flex-col overflow-hidden"
    >
      <div className="bg-muted flex-1 overflow-hidden p-4 sm:p-6">
        <div className="mb-3 space-y-1 text-center">
          <p data-testid={`${testId}-label`} className="text-muted-foreground text-xs">
            {label}
          </p>
          {detail ? (
            <p
              data-testid={`${testId}-detail`}
              aria-hidden="true"
              className="text-muted-foreground font-mono text-xs leading-4 tabular-nums"
            >
              {detail}
            </p>
          ) : null}
        </div>
        <div
          className={cn(
            'border-border mx-auto h-full w-full max-w-3xl space-y-4 border p-8 sm:p-12',
            paper ? 'bg-[var(--paper)]' : 'bg-card'
          )}
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <div className="space-y-2 pt-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Error del renderer DENTRO del marco: el sello de tipo y el nombre del archivo
 * siguen ahi, y el reintento lo entrega quien monta el visor (`chrome.onRetry`)
 * porque el permiso es de un solo uso y hay que pedir uno nuevo.
 */
export function ViewerError({ testId, chrome }: { testId: string; chrome?: ViewerChromeProps }) {
  const t = useTranslations('vdr.viewer')
  const onRetry = chrome?.onRetry

  return (
    // `ready` lo declara quien monta el visor a partir del PRIMER `onReady`, y
    // un renderer puede fallar despues de haber pintado (la pagina 2 de un PDF
    // cuyo raster revienta): sin apagarlo aqui, el marco de error ofreceria
    // agrandar una tarjeta de fallo. En el error no hay documento en pantalla.
    <ViewerFrame chrome={chrome && { ...chrome, ready: false }}>
      <div
        data-testid={testId}
        role="alert"
        className="bg-card flex h-full min-h-64 flex-col items-center justify-center px-6 py-12 text-center"
      >
        <CircleAlert className="text-destructive mb-4 h-6 w-6" aria-hidden="true" />
        <p className="text-foreground text-base font-semibold">{t('errorTitle')}</p>
        <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">
          {t('errorDescription')}
        </p>
        {onRetry ? (
          <Button className="mt-5 min-h-11" variant="outline" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    </ViewerFrame>
  )
}

/**
 * Ultimo recurso del despacho: el formato no se previsualiza. Se ofrece el
 * original, nunca una conversion silenciosa.
 */
export function ViewerDownloadFallback({
  fileName,
  downloadUrl,
}: {
  fileName: string
  downloadUrl: string | null
}) {
  const t = useTranslations('vdr.viewer')

  return (
    <div
      data-testid="document-viewer-nopreview"
      className="border-border bg-card flex h-full min-h-64 flex-col items-center justify-center border px-6 py-12 text-center"
    >
      <FileText className="text-muted-foreground mb-4 h-6 w-6" aria-hidden="true" />
      <p className="text-foreground text-base font-semibold">{t('noPreviewTitle')}</p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">{t('noPreview')}</p>
      {downloadUrl ? (
        <Button asChild className="mt-5 min-h-11">
          <a href={downloadUrl} download={fileName}>
            <Download aria-hidden="true" />
            {t('download')}
          </a>
        </Button>
      ) : null}
    </div>
  )
}

/** Lo que el despacho sabe del documento y que todo renderer muestra igual. */
export type ViewerChromeProps = {
  fileName: string
  /** Sello de tipo en mono (PDF, XLSX, DOCX...). */
  kind: string
  /** URL de descarga del original, o `null` si el acceso no la autoriza. */
  downloadUrl?: string | null
  /**
   * Descarga del original PIDIENDO un permiso nuevo. Es la puerta de la sala:
   * el grant de la vista es de un solo uso y ya se gasto en la previsualizacion,
   * asi que la descarga no puede colgar de esa URL. Quien monta el visor la
   * entrega porque solo el puede emitir el grant DOWNLOAD (y dejar su fila de
   * auditoria). Sin ella, el marco cae a `downloadUrl`.
   */
  onDownload?: () => void
  onClose?: () => void
  onReady?: () => void
  /**
   * El documento ya esta en pantalla. Lo declara quien monta el visor a partir
   * del `onReady` de abajo —el mismo que emiten los seis renderers—, y el marco
   * lo usa para no ofrecer la pantalla completa antes de tiempo.
   */
  ready?: boolean
  /**
   * Reintento del error: lo resuelve quien monta el visor porque el grant es de
   * un solo uso y hay que emitir uno nuevo, no reusar la URL quemada.
   */
  onRetry?: () => void
  /**
   * El marco avisa cuando el boton de pantalla completa de la barra cambia de
   * estado. Solo le interesa a quien monta el visor DENTRO de un contenedor
   * con `transform` —el `DialogContent` de Radix lleva `translate-x/-y`—:
   * ese transform es el bloque contenedor de cualquier `position: fixed` de
   * adentro, asi que el marco expandido llena el dialogo y no la ventana
   * mientras el dialogo no se agrande tambien.
   */
  onExpandedChange?: (expanded: boolean) => void
}

/**
 * Marco comun de los renderers: una barra con el sello de tipo, el indicador
 * (pagina u hoja, en mono) y las acciones. En pantallas pequenas el visor
 * ocupa toda la ventana: nombre y cierre arriba, indicador y navegacion abajo,
 * y ahi el marco es un dialogo modal de verdad.
 * Esc cierra cuando el que monta el visor entrega `onClose`.
 *
 * `notice` avisa de un fallo que NO invalida el documento, como el libro
 * abierto al que le fallo una cita. Va en su propia franja y no en la barra
 * porque ahi el texto se trunca, y un error no se trunca (design-system).
 */
export function ViewerFrame({
  chrome,
  indicator,
  controls,
  notice,
  testId,
  className,
  children,
}: {
  chrome?: ViewerChromeProps
  /** Pagina u hoja actual; se muestra en mono. */
  indicator?: ReactNode
  /** Controles del renderer (paginar, zoom). */
  controls?: ReactNode
  /** Aviso de un fallo parcial: el documento sigue en pantalla. */
  notice?: ReactNode
  testId?: string
  className?: string
  children: ReactNode
}) {
  const t = useTranslations('vdr.viewer')
  const onClose = chrome?.onClose
  const onExpandedChange = chrome?.onExpandedChange
  // Debajo de `sm` el marco YA ocupa la ventana. En escritorio lo hace mientras
  // el boton de la barra este prendido: la MISMA variable manda en el rol, el
  // foco inicial, la trampa de Tab, las guardas y el overflow de la pagina, asi
  // que el modo expandido no es un segundo comportamiento sino la segunda
  // fuente del que ya existia.
  const smallScreen = useViewerIsFullscreen()
  const [expanded, setExpanded] = useState(false)
  const fullscreen = smallScreen || expanded
  // Expandido POR DECISION del cliente, no por el tamano de la pantalla. Debajo
  // de `sm` el marco ya llena la ventana con su propia disposicion (nombre y
  // cierre arriba, controles abajo) y ahi no cambia nada.
  const desktopExpanded = expanded && !smallScreen
  const frameRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const iframeFocusRef = useRef(false)

  // El aviso va en un efecto y no en el handler para que un desmontaje con el
  // marco expandido (un error del renderer, el cierre del dialogo) tambien
  // devuelva al contenedor su tamano de siempre.
  useEffect(() => {
    if (!expanded || !onExpandedChange) return
    onExpandedChange(true)
    return () => onExpandedChange(false)
  }, [expanded, onExpandedChange])

  // Esc en dos pasos: expandido, la primera pulsacion solo devuelve el marco a
  // su tamano. Va en CAPTURA sobre `window`, que es el primer nodo del camino
  // del evento, asi que corre antes del `useEscapeKeydown` de Radix (captura
  // sobre `document`, que cierra el `DocumentViewerDialog`) y antes del cierre
  // de aqui abajo, que escucha en burbuja. `stopPropagation` corta el camino
  // antes de que el evento llegue a ninguno de los dos.
  useEffect(() => {
    if (!expanded) return
    const handleKey = (event: KeyboardEvent) => {
      if (!isViewerDismissKey(event.key)) return
      // Correr primero POR CONSTRUCCION tiene su precio: aqui `defaultPrevented`
      // siempre es `false`, asi que el marco no puede cederle la tecla a nadie
      // mirandolo, como si hace el cierre de aqui abajo. Sin esta guarda, una
      // capa de Radix ABIERTA sobre el marco —el desplegable de zoom del PDF—
      // se quedaria abierta, con su foco atrapado, mientras lo que se cierra es
      // la pantalla completa: justo al reves.
      //
      // La tecla es del marco cuando nace ADENTRO o en un ancestro suyo: el
      // `body` cuando no hay foco en nada, el contenedor del dialogo cuando
      // Radix le devuelve el foco. Lo que se deja pasar es la capa HERMANA, que
      // es como Radix monta la suya: otro nodo bajo `document.body`, que ni
      // contiene al marco ni esta contenido por el.
      const node = frameRef.current
      const target = event.target
      if (node && target instanceof Node && !node.contains(target) && !target.contains(node)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setExpanded(false)
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [expanded])

  useEffect(() => {
    if (!onClose) return
    const handleKey = (event: KeyboardEvent) => {
      if (isViewerDismissKey(event.key) && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // A pantalla completa el visor es el unico contenido operable: toma el foco,
  // congela el scroll de la pagina y lo devuelve todo al cerrarse.
  useEffect(() => {
    if (!fullscreen) return
    // `document.activeElement` es un `Element`: el `as HTMLElement` de antes le
    // mentía al compilador y por eso hacía falta el `?.focus?.()` de abajo, que
    // tapaba el caso en silencio. Con el `instanceof` el foco se devuelve
    // cuando de verdad hay adónde devolverlo.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    frameRef.current?.focus()
    return () => {
      root.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [fullscreen])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!fullscreen || !isFocusTrapKey(event.key)) return
    const node = frameRef.current
    if (!node) return
    const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const parentFocusables = () => {
    const frame = frameRef.current
    if (!frame) return []
    return Array.from(frame.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) =>
        element.dataset.viewerFocusGuard !== 'true' && !contentRef.current?.contains(element)
    )
  }

  const handleBeforeContentFocus = (event: ReactFocusEvent<HTMLSpanElement>) => {
    if (!fullscreen) return
    if (iframeFocusRef.current || isFocusTargetIframe(event.relatedTarget)) {
      iframeFocusRef.current = false
      parentFocusables().at(-1)?.focus()
      return
    }
    contentRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }

  const handleAfterContentFocus = () => {
    if (!fullscreen) return
    iframeFocusRef.current = false
    parentFocusables()[0]?.focus()
  }

  const handleFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    // Mismo motivo que arriba: `event.target` es un `EventTarget` y el casteo a
    // `HTMLElement` daba por hecho un `dataset` que un nodo que no sea HTML no
    // tiene.
    const target = event.target
    if (isFocusTargetIframe(target)) {
      iframeFocusRef.current = true
      return
    }
    if (!(target instanceof HTMLElement)) return
    if (target.dataset.viewerFocusGuard !== 'true' && !contentRef.current?.contains(target)) {
      iframeFocusRef.current = false
    }
  }

  /**
   * El ancla al original ya autorizado, la descarga de siempre de la barra.
   * Es una funcion del sitio porque expandido se muda a la fila del nombre, y
   * nunca se pinta en los dos lados a la vez.
   */
  const downloadAnchor = (buttonClassName: string) =>
    chrome?.downloadUrl ? (
      <Button asChild variant="ghost" size="sm" className={buttonClassName}>
        <a
          href={chrome.downloadUrl}
          download={chrome.fileName}
          data-testid="document-viewer-download"
        >
          <Download aria-hidden="true" />
          {t('download')}
        </a>
      </Button>
    ) : null

  /**
   * La descarga de la vista expandida, por la puerta que el que monta el visor
   * haya abierto: su handler (pide un grant nuevo) si lo hay, y si no el ancla
   * de arriba. El marco no inventa una segunda ruta.
   *
   * Solo existe expandido: el handler es el boton que la sala ya tiene sobre el
   * visor, y mientras se vea no hay que repetirlo aqui.
   */
  const expandedDownload = chrome?.onDownload ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="shrink-0"
      onClick={chrome.onDownload}
      data-testid="document-viewer-download"
    >
      <Download aria-hidden="true" />
      {t('download')}
    </Button>
  ) : (
    downloadAnchor('shrink-0')
  )

  const toolbar = (
    <div
      className={cn(
        'border-border bg-background flex min-h-11 shrink-0 items-center gap-3 border-t px-3 py-1.5 sm:border-t-0 sm:border-b sm:px-4',
        // Expandido el nombre manda arriba, asi que la barra suelta sus dos
        // ordenes —ultima en movil, primera en el panel de escritorio— y queda
        // donde el DOM la pone: debajo de la fila del nombre.
        desktopExpanded ? null : 'order-last sm:order-first'
      )}
    >
      {chrome ? (
        <span
          data-testid="document-viewer-kind"
          className="border-border text-muted-foreground hidden shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] leading-4 tracking-wide uppercase sm:inline-block"
        >
          {chrome.kind}
        </span>
      ) : null}
      {indicator ? (
        <span
          data-testid="document-viewer-indicator"
          className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate font-mono text-xs tabular-nums"
        >
          {indicator}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {controls}
        {/* Expandido, la descarga sube a la fila del nombre: aqui se apaga para
            no ofrecer el mismo boton dos veces en la misma vista. */}
        {desktopExpanded ? null : downloadAnchor('hidden sm:inline-flex')}
        {chrome?.downloadUrl ? (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-11 sm:hidden"
            aria-label={t('download')}
          >
            <a href={chrome.downloadUrl} download={chrome.fileName}>
              <Download aria-hidden="true" />
            </a>
          </Button>
        ) : null}
        {/* Solo escritorio, y no solo por CSS: debajo de `sm` el marco ya ocupa
            la ventana y el boton no tendria nada que hacer, pero ademas un
            control en `display: none` dentro del anillo de foco del dialogo
            movil seria una parada muerta al tabular. La clase cubre el tramo
            entre el primer pintado y la hidratacion, cuando la consulta de
            medios todavia no respondio.

            Apagado hasta que el documento este en pantalla: agrandar a media
            carga es una promesa que el marco no puede sostener (el renderer
            todavia esta montando su contenido), asi que el boton no se ofrece
            antes de tiempo. El marco de error apaga `ready` al entrar (ver
            `ViewerError`): ahi tampoco hay nada que agrandar. */}
        {smallScreen ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex"
            onClick={() => setExpanded((current) => !current)}
            disabled={!chrome?.ready}
            aria-pressed={expanded}
            aria-label={t(expanded ? 'exitFullscreen' : 'enterFullscreen')}
            title={t(expanded ? 'exitFullscreen' : 'enterFullscreen')}
            data-testid="document-viewer-fullscreen"
          >
            {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <div
      ref={frameRef}
      data-testid={testId}
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
      {...(fullscreen
        ? {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': chrome?.fileName ?? t('documentArea'),
            tabIndex: -1,
          }
        : {})}
      className={cn(
        // Movil: pantalla completa, por encima de cualquier banner fijo de la
        // pagina (el de cookies es z-50 y tapaba toda la barra de controles).
        'bg-background fixed inset-0 z-[60] flex flex-col outline-none',
        // Expandido es exactamente esto mismo en escritorio: se deja de aplicar
        // la cadena que en `sm` devuelve el marco a panel. Es CSS sobre el
        // MISMO nodo — ni portal ni `key` nueva — asi que el PDF conserva
        // pagina y zoom y el libro de Mog no vuelve a arrancar el motor.
        expanded
          ? null
          : 'sm:border-border sm:static sm:z-auto sm:h-full sm:max-h-[min(84dvh,64rem)] sm:min-h-64 sm:border',
        className
      )}
    >
      {chrome ? (
        <div
          className={cn(
            'border-border flex shrink-0 items-center gap-2 border-b px-3 py-2',
            desktopExpanded ? null : 'sm:hidden'
          )}
        >
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{chrome.fileName}</p>
          {/* Expandido, el marco tapa la fila de la sala —nombre, «Descargar» y
              «Cerrar visor»—, asi que la descarga se ofrece aqui, junto al
              nombre, que es donde estaba. Salir no hace falta: se sale por el
              boton de la barra y con Esc. */}
          {desktopExpanded ? expandedDownload : null}
          {/* La X de esta fila es del movil. En escritorio expandido se sale
              por el boton de la barra, y dejarla oculta con `sm:hidden` la
              convertiria en el primer destino —invisible— de la trampa de
              foco: no se renderiza. */}
          {onClose && !desktopExpanded ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={onClose}
              aria-label={t('close')}
              data-testid="document-viewer-close"
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
      {toolbar}
      {notice ? (
        <div
          data-testid="document-viewer-notice"
          role="status"
          className="border-border text-muted-foreground flex shrink-0 items-start gap-2 border-b px-3 py-2 text-sm leading-5 sm:px-4"
        >
          <CircleAlert className="text-destructive mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{notice}</span>
        </div>
      ) : null}
      <span
        tabIndex={fullscreen ? 0 : -1}
        aria-hidden="true"
        data-testid="viewer-focus-before-content"
        data-viewer-focus-guard="true"
        onFocus={handleBeforeContentFocus}
        className="sr-only"
      />
      {/* Cada renderer decide su propio scroll: aqui solo se acota la altura. */}
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden">
        {children}
      </div>
      <span
        tabIndex={fullscreen ? 0 : -1}
        aria-hidden="true"
        data-testid="viewer-focus-after-content"
        data-viewer-focus-guard="true"
        onFocus={handleAfterContentFocus}
        className="sr-only"
      />
    </div>
  )
}
