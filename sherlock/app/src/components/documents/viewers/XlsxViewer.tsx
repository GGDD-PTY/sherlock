'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Schema } from 'effect'

import {
  ViewerError,
  ViewerFrame,
  ViewerLoading,
  type ViewerChromeProps,
  type ViewerStatus,
} from './ViewerChrome'
import { useDocumentBytes } from './useDocumentBytes'
import {
  reduceXlsxPhase,
  serializeXlsxTimeline,
  XLSX_PHASE_INITIAL,
  xlsxMarksExposed,
  xlsxPhaseMessageKey,
  type XlsxPhaseState,
} from './xlsxPhases'

// El sidecar es un build de Vite servido como estatico (public/mog/). Vive en
// su propia URL, fuera del bundle de Next, porque el runtime de Mog pesa 19 MB
// de JS + 41 MB de WASM.
const MOG_SIDECAR_URL = '/mog/index.html'

// Spike R0 (2026-08-24): `sandbox="allow-scripts"` SIN `allow-same-origin` no
// funciona. Falla dos veces: (1) el origen opaco manda `Origin: null`, asi que
// el modulo ES y su CSS de /mog/assets/* mueren por CORS; (2) aun abriendo CORS,
// el DocumentManager de Mog necesita IndexedDB y en un origen opaco eso lanza
// SecurityError. Por eso el sandbox declara same-origin: NO es una frontera de
// seguridad (Chromium avisa que ese par puede escapar del sandbox) sino la
// frontera de CSP y de presupuesto — Mog se trata como dependencia pineada.
//
// La frontera que SI se sostiene es la de datos: el iframe nunca recibe la URL
// del grant ni credenciales. Los bytes llegan por un MessagePort privado y el
// canal se cierra al desmontar.
const MOG_SANDBOX = 'allow-scripts allow-same-origin'

/**
 * El contador aparece cuando la espera ya es espera. Antes del primer segundo
 * solo agregaria un "0 s" parpadeando a una pantalla que ya cambio de estado.
 */
const ELAPSED_VISIBLE_AFTER_SECONDS = 1

/**
 * Plazo para probar que el sidecar existe. Sin `public/mog/` el iframe sirve el
 * 404 de Next y el saludo no llega nunca.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * Techo de tiempo sin AVANZAR, no de la apertura completa: el vigilante se
 * rearma con cada fase aceptada, asi que un libro grande lo empuja hacia
 * adelante todo lo que haga falta. Que avance y no que hable, a proposito: un
 * sidecar que republica `parsing` cada cinco segundos esta igual de atascado
 * que uno callado. El tramo mas largo medido es `parsing` -> `first-sheet`,
 * 23,7 s en el libro del fundador (PR #490); noventa segundos sin avanzar no
 * es un libro pesado, y ahi el cliente merece el reintento en vez de un
 * esqueleto eterno.
 */
const PHASE_STALL_TIMEOUT_MS = 90_000

/**
 * Identidad del emisor del saludo.
 *
 * La comprobacion fuerte es la VENTANA: solo el `contentWindow` de ESTE iframe
 * puede ser `event.source`, y eso no lo falsifica un tercero por mucho que
 * imite la forma del mensaje. El origen es el segundo cerrojo y admite un solo
 * valor, el propio: el spike R0 dejo `allow-same-origin` en el sandbox porque
 * sin el mueren CORS e IndexedDB, asi que el sidecar NUNCA se presenta con
 * origen opaco. Un `'null'` o una cadena vacia significan que ese documento ya
 * no es el sidecar, y ahi no va ni el puerto ni el libro.
 */
const SidecarHello = Schema.Struct({ type: Schema.Literal('mog:hello') })

/** El saludo, sin castear a mano lo que llega por `postMessage`. */
const isSidecarHello = Schema.is(SidecarHello)

function isSidecarHandshake(event: MessageEvent, frame: HTMLIFrameElement): boolean {
  if (event.source !== frame.contentWindow) return false
  if (event.origin !== window.location.origin) return false
  return isSidecarHello(event.data)
}

export interface XlsxViewerProps {
  viewUrl: string
  fileName: string
  /** Identidad estable del libro dentro del sidecar. */
  workbookId: string
  sheet?: string
  range?: string
  chrome?: ViewerChromeProps
}

export function XlsxViewer({
  viewUrl,
  fileName,
  workbookId,
  sheet,
  range,
  chrome,
}: XlsxViewerProps) {
  const t = useTranslations('vdr.viewer')
  const { theme: colorScheme, resolvedTheme: resolvedColorScheme } = useTheme()
  const currentTheme = useEffectEvent(() => ({ colorScheme, resolvedColorScheme }))
  const marksExposed = xlsxMarksExposed()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  // El efecto del canal es el dueno del estado de fases; esta referencia deja
  // que el efecto de navegacion entre por la MISMA puerta en vez de tocar el
  // estado de React por un lado.
  const applyRef = useRef<((message: unknown) => void) | null>(null)
  const bytes = useDocumentBytes(viewUrl)
  const [phases, setPhases] = useState<XlsxPhaseState>(XLSX_PHASE_INITIAL)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [openedUrl, setOpenedUrl] = useState(viewUrl)

  // Un grant nuevo (el reintento emite uno) es una apertura nueva: ni el
  // timeline ni el reloj se heredan. El ajuste va EN RENDER y no en un efecto:
  // llamar setState dentro del cuerpo de un efecto encadena renders y la regla
  // `react-hooks/set-state-in-effect` lo prohibe.
  if (openedUrl !== viewUrl) {
    setOpenedUrl(viewUrl)
    setPhases(XLSX_PHASE_INITIAL)
    setElapsedSeconds(0)
  }

  // El fallo de la descarga se DERIVA del hook; del sidecar solo manda lo que
  // pasa por el reductor de fases. Asi ningun efecto hace setState sincrono.
  const status: ViewerStatus =
    bytes.status === 'error' || phases.status === 'error'
      ? 'error'
      : phases.status === 'rendered' || phases.status === 'degraded'
        ? 'ready'
        : 'loading'

  useEffect(() => {
    if (bytes.status !== 'ready') return
    const frame = frameRef.current
    if (!frame) return

    const channel = new MessageChannel()
    let handshaken = false
    let watchdog = 0
    // Copia autoritativa del estado dentro del efecto: el reductor se aplica
    // aqui y React solo espeja el resultado. Asi una marca repetida no dispara
    // un render y el timeout no depende de leer estado de React ya obsoleto.
    let phaseState = XLSX_PHASE_INITIAL

    // Solo se arma mientras la apertura sigue en curso, asi que cuando vence el
    // estado es `opening` y el error entra por la misma puerta que los del
    // sidecar.
    function armWatchdog(delay: number) {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(() => applySidecarMessage({ type: 'error' }), delay)
    }

    const applySidecarMessage = (message: unknown) => {
      const next = reduceXlsxPhase(phaseState, message)
      if (next === phaseState) return
      phaseState = next
      setPhases(next)
      if (next.status === 'opening') armWatchdog(PHASE_STALL_TIMEOUT_MS)
      else window.clearTimeout(watchdog)
    }

    channel.port1.onmessage = (event: MessageEvent) => applySidecarMessage(event.data)
    channel.port1.start()
    portRef.current = channel.port1
    applyRef.current = applySidecarMessage

    const handleHandshake = (event: MessageEvent) => {
      // El saludo se repite cada 250 ms hasta que el sidecar recibe el puerto, y
      // los avisos en vuelo siguen llegando despues del apreton. Un segundo
      // envio retransferiria un puerto ya neutralizado: `DataCloneError` dentro
      // del listener, canal a medio armar y esqueleto para siempre.
      if (handshaken) return
      if (!isSidecarHandshake(event, frame)) return

      handshaken = true
      // Origen explicito, jamas `'*'`: si el iframe navego o alguien le cambio
      // el `src`, el puerto (y con el, el libro) no aterriza en ese documento.
      frame.contentWindow?.postMessage(
        { type: 'mog:init', theme: currentTheme() },
        window.location.origin,
        [channel.port2]
      )
      // `bytes.bytes` se copia: el ArrayBuffer se transfiere y queda inutilizable
      // en esta ventana, y el estado del hook debe sobrevivir a un remount.
      const transferable = bytes.bytes.slice(0)
      channel.port1.postMessage({ type: 'open', bytes: transferable, fileName, workbookId }, [
        transferable,
      ])
      // Desde aqui el reloj lo lleva el sidecar: un libro grande tarda mucho
      // mas de 30 s en hidratar, pero tiene que seguir avanzando mientras lo
      // hace. Un saludo que llega tarde, con el plazo del apreton ya vencido,
      // no rearma nada sobre un estado que ya termino.
      if (phaseState.status === 'opening') armWatchdog(PHASE_STALL_TIMEOUT_MS)
    }

    window.addEventListener('message', handleHandshake)
    armWatchdog(HANDSHAKE_TIMEOUT_MS)

    return () => {
      window.removeEventListener('message', handleHandshake)
      window.clearTimeout(watchdog)
      channel.port1.onmessage = null
      channel.port1.close()
      portRef.current = null
      applyRef.current = null
    }
  }, [bytes, fileName, workbookId])

  useEffect(() => {
    portRef.current?.postMessage({
      type: 'theme',
      theme: { colorScheme, resolvedColorScheme },
    })
  }, [colorScheme, resolvedColorScheme])

  // El reloj de la espera. Solo corre mientras hay esqueleto: no hay timer vivo
  // detras de un libro ya abierto.
  useEffect(() => {
    if (status !== 'loading') return
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1_000)))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [status])

  // La navegacion tiene que funcionar tambien cuando cambia con el visor ya
  // montado: es como el asistente cita una celda de una sala abierta.
  useEffect(() => {
    if (status !== 'ready' || (!sheet && !range)) return
    // El aviso describe el ULTIMO intento, no el libro: una cita nueva lo
    // retira y el sidecar volvera a fallar si tambien falla esta.
    applyRef.current?.({ type: 'navigation-retry' })
    portRef.current?.postMessage({ type: 'navigate', sheet, range })
  }, [range, sheet, status])

  const onReady = chrome?.onReady
  useEffect(() => {
    if (status === 'ready') onReady?.()
  }, [onReady, status])

  if (status === 'error') return <ViewerError testId="document-viewer-error" chrome={chrome} />

  // El sidecar trae su propia barra de hojas; aqui solo se nombra la hoja
  // citada cuando hay una, sin inventar un indicador que el puerto no reporta.
  // Degradado se calla: si la cita fallo, el visor no sabe si la hoja en
  // pantalla es la que nombra el indicador, y un rotulo que puede mentir sobre
  // lo que se esta viendo es peor que no tener rotulo.
  const citedSheet = phases.status === 'degraded' ? undefined : sheet
  return (
    <ViewerFrame
      testId="document-viewer-xlsx"
      chrome={chrome}
      indicator={citedSheet ? t('sheet', { name: citedSheet }) : undefined}
      notice={phases.status === 'degraded' ? t('partialError') : undefined}
    >
      {status === 'loading' ? (
        // Opaco a proposito: el sidecar pinta su propio estado de carga debajo
        // y no deben verse dos mensajes superpuestos.
        <div className="bg-background absolute inset-0 z-10">
          <ViewerLoading
            testId="document-viewer-frame-loading"
            label={t(xlsxPhaseMessageKey(phases.phase))}
            detail={
              elapsedSeconds >= ELAPSED_VISIBLE_AFTER_SECONDS
                ? t('elapsedSeconds', { seconds: elapsedSeconds })
                : undefined
            }
            paper
          />
        </div>
      ) : null}
      {/* MOG adapta su interfaz; los colores del documento se conservan. */}
      <div className="bg-muted h-full min-h-64 p-1.5">
        <iframe
          ref={frameRef}
          src={MOG_SIDECAR_URL}
          title={t('iframeTitle', { name: fileName })}
          sandbox={MOG_SANDBOX}
          referrerPolicy="no-referrer"
          data-testid="document-viewer-mog-frame"
          // Instrumentacion fuera de produccion: la fase vigente y el timeline
          // completo (`fase:ms fase:ms ...`) sobreviven al render final, asi que
          // `e2e/xlsx-viewer-phases.spec.ts` puede repartir el tiempo por fase
          // sin instrumentar el navegador. En produccion no se emite nada.
          data-xlsx-phase={marksExposed ? (phases.phase ?? 'pending') : undefined}
          data-xlsx-marks={marksExposed ? serializeXlsxTimeline(phases.timeline) : undefined}
          className="border-border block h-full min-h-64 w-full border"
        />
      </div>
    </ViewerFrame>
  )
}
