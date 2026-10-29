// Product analytics for the complete Sherlock journey. The SDK records
// structure and interactions while masking text, inputs and document surfaces.

'use client'

import type { PostHog } from 'posthog-js'
import { createContext, useEffect, useState } from 'react'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'
import { registerExceptionSink } from '@/lib/observability/capture-client-exception'
import { runClientFork } from '@/lib/effect/client-runtime'

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY
const POSTHOG_ENABLED =
  process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_ENABLE_POSTHOG_IN_DEV === 'true'

const AUTOCAPTURE_ATTRIBUTE_DENYLIST = [
  'value',
  'title',
  'aria-label',
  'aria-describedby',
  'href',
  'src',
  'name',
  'data-document-id',
  'data-document-name',
  'data-file-name',
  'data-filename',
  'data-storage-id',
] as const

const REPLAY_BLOCK_SELECTOR = [
  'canvas',
  'iframe',
  'embed',
  'object',
  'a[href]',
  'form[action]',
  'img[src]',
  'source[src]',
  'video[src]',
  'audio[src]',
  '[download]',
  '[title]',
  '[aria-label]',
  '.ph-no-capture',
  '[data-posthog-block]',
  '[data-document-id]',
  '[data-document-name]',
  '[data-file-name]',
  '[data-filename]',
  '[data-storage-id]',
].join(', ')

const REPLAY_SAFE_STATIC_TEXT = new Set([
  'Abrir',
  'Asistente',
  'Atrás',
  'Cancelar',
  'Cerrar',
  'Contacto',
  'Continuar',
  'Cuenta',
  'Dashboard',
  'Data Room',
  'Descargar',
  'Documentos',
  'Equipo',
  'Financiamiento',
  'Guardar',
  'Guardar cambios',
  'Perfil de la empresa',
  'Siguiente',
  'Subir documento',
  'Subir documentos',
])

function maskReplayText(text: string, element?: HTMLElement): string {
  return element?.dataset.replayUi === 'true' && REPLAY_SAFE_STATIC_TEXT.has(text.trim())
    ? text
    : text.replace(/\S/g, '*')
}

declare global {
  interface Navigator {
    readonly globalPrivacyControl?: boolean
    readonly msDoNotTrack?: string | number | null
  }

  interface Window {
    readonly doNotTrack?: string | number | null
  }
}

function browserRequestsDoNotTrack(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  return (
    navigator.globalPrivacyControl === true ||
    [navigator.doNotTrack, navigator.msDoNotTrack, window.doNotTrack].some(
      (value) => value === '1' || value === 1 || value === 'yes'
    )
  )
}

// ============================================================================
// PROXY HOST PARA EVITAR BLOQUEADORES DE ANUNCIOS
// ============================================================================
// Los bloqueadores (uBlock, AdBlock, etc.) bloquean requests a "posthog.com".
// Solución: Usar un proxy local (/api/posthog) que reenvía a PostHog.
//
// En desarrollo: usamos el proxy local para evitar problemas con bloqueadores
// En producción: también usamos proxy para máxima compatibilidad
//
// Documentación oficial: https://posthog.com/docs/advanced/proxy/nextjs
// ============================================================================
const POSTHOG_HOST = '/ingest' // Proxy local que evita bloqueadores

type ScheduledPostHogInit = { cancel: () => void }

// El SDK pesa unos 80 KiB entre el bundle y los scripts de `/ingest/static`.
// Enganchado al primer idle tras hidratar, esos bytes entran en la ventana que
// Lighthouse le imputa al LCP de la landing: analytics compitiendo con el texto
// de la promesa. Analytics no pinta nada, así que primero `load` y recién
// después el idle. Si la página ya terminó de cargar, el idle es inmediato.
function whenIdle(callback: () => void): () => void {
  if ('requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(callback, { timeout: 2000 })
    return () => {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(handle)
    }
  }

  const handle = setTimeout(callback, 1000)
  return () => clearTimeout(handle)
}

function schedulePostHogInit(callback: () => void): ScheduledPostHogInit {
  if (document.readyState === 'complete') {
    return { cancel: whenIdle(callback) }
  }

  let cancelIdle: (() => void) | null = null
  const onLoad = () => {
    cancelIdle = whenIdle(callback)
  }
  window.addEventListener('load', onLoad, { once: true })

  return {
    cancel: () => {
      window.removeEventListener('load', onLoad)
      cancelIdle?.()
    },
  }
}

function cancelScheduledPostHogInit(scheduledInit: ScheduledPostHogInit) {
  scheduledInit.cancel()
}

// ===== LA COSTURA CON EFFECT =====
// Que el SDK no llegue no es un caso que la app deba sentir: se avisa por
// consola y el contexto se queda en `null`. Lo que cambia es que el fallo tiene
// nombre en vez de ser un `.catch` anónimo, y que la espera se corre en una
// fibra: desmontar la interrumpe, así que un SDK que termina de bajar después
// del desmontaje ya no escribe estado.
class PostHogInitError extends Schema.TaggedError<PostHogInitError>()('PostHogInitError', {
  cause: Schema.Defect(),
}) {}

const attachPostHogRuntime = Effect.fn('PostHog.attach')(function* (
  init: Promise<PostHog>
): Effect.fn.Return<PostHog | null> {
  return yield* Effect.tryPromise({
    try: () => init,
    catch: (cause) => new PostHogInitError({ cause }),
  }).pipe(
    Effect.tapError((error) => Effect.logWarning('[PostHog] Failed to initialize:', error.cause)),
    Effect.orElseSucceed(() => null)
  )
})

// El cliente viaja por este contexto, no por el Provider de `posthog-js/react`.
// Dos razones. Una: ese import arrastraba los ~70 KiB del SDK al grafo inicial
// de CADA pagina. Dos, la que rompio la landing el 2026-09-03: montar el
// Provider recien cuando el SDK llegaba cambiaba el tipo del elemento raiz, y
// React desmonta y remonta todo el subarbol cuando eso pasa — se borraban los
// archivos que el cliente acababa de elegir. Este contexto se renderiza SIEMPRE,
// con `null` mientras no haya cliente: el arbol nunca cambia de forma.
const PostHogClientContext = createContext<PostHog | null>(null)

// El candado anti-doble-init vive en el modulo, no en el componente. Cada
// seccion de la app monta su propio AppShell (my-company, notifications,
// settings, admin, onboarding) y el sitio publico monta PublicShell, asi que
// React desmonta y remonta este provider en cada salto. Con un `useRef` el
// candado moria con el componente y el SDK avisaba «You have already
// initialized PostHog» una vez por salto. El SDK es un singleton de modulo;
// su candado tambien. Un provider que se monta despues recibe el runtime al
// instante en vez de reprogramar un init ocioso.
let postHogInit: Promise<PostHog> | null = null

function usePostHogRuntime() {
  const [runtime, setRuntime] = useState<PostHog | null>(null)

  useEffect(() => {
    if (POSTHOG_ENABLED && !POSTHOG_KEY && process.env.NODE_ENV === 'development') {
      runClientFork(
        Effect.logWarning('[PostHog] No API key found. Set NEXT_PUBLIC_POSTHOG_KEY in .env.local')
      )
    }

    if (
      !POSTHOG_ENABLED ||
      !POSTHOG_KEY ||
      typeof window === 'undefined' ||
      browserRequestsDoNotTrack()
    ) {
      return
    }

    // `whenIdle` solo puede cancelar su callback si el navegador expone
    // `cancelIdleCallback`; esta bandera cubre al que no. De ahí en adelante
    // manda la fibra.
    let cancelled = false
    let fiber: Fiber.Fiber<PostHog | null> | null = null

    const scheduledInit = schedulePostHogInit(() => {
      if (cancelled) return

      if (!postHogInit) {
        // El sanitizador de eventos solo sirve cuando hay SDK: viaja en el
        // mismo viaje diferido y no en el grafo inicial de cada página.
        const pending: Promise<PostHog> = Promise.all([
          import('posthog-js'),
          import('@/lib/analytics/posthog-sanitize'),
        ]).then(
          ([{ default: posthog }, { sanitizeAnalyticsEvent, sanitizeReplayNetworkRequest }]) => {
            posthog.init(POSTHOG_KEY, {
              api_host: POSTHOG_HOST,
              before_send: (event) =>
                browserRequestsDoNotTrack() ? null : sanitizeAnalyticsEvent(event),
              persistence: 'localStorage',
              disable_persistence: false,
              person_profiles: 'never',
              autocapture: {
                dom_event_allowlist: ['click', 'submit'],
                element_allowlist: ['a', 'button', 'form', 'input', 'select', 'textarea', 'label'],
                element_attribute_ignorelist: [...AUTOCAPTURE_ATTRIBUTE_DENYLIST],
                capture_copied_text: false,
              },
              mask_all_element_attributes: true,
              mask_all_text: true,
              rageclick: true,
              capture_pageview: 'history_change',
              capture_pageleave: true,
              capture_performance: {
                network_timing: false,
                web_vitals: true,
                web_vitals_attribution: false,
              },
              capture_exceptions: {
                capture_unhandled_errors: true,
                capture_unhandled_rejections: true,
                capture_console_errors: false,
              },
              capture_heatmaps: true,
              capture_dead_clicks: {
                element_attribute_ignorelist: [...AUTOCAPTURE_ATTRIBUTE_DENYLIST],
              },
              disable_scroll_properties: false,
              disable_session_recording: false,
              session_recording: {
                maskAllInputs: true,
                maskTextSelector: '*',
                maskTextFn: maskReplayText,
                blockSelector: REPLAY_BLOCK_SELECTOR,
                recordHeaders: false,
                recordBody: false,
                recordCrossOriginIframes: false,
                captureCanvas: { recordCanvas: false },
                maskCapturedNetworkRequestFn: sanitizeReplayNetworkRequest,
              },
              enable_recording_console_log: false,
              disable_surveys: true,
              disable_surveys_automatic_display: true,
              disable_product_tours: true,
              disable_conversations: true,
              disable_web_experiments: true,
              disable_external_dependency_loading: false,
              advanced_disable_flags: false,
              advanced_disable_feature_flags: true,
              advanced_disable_feature_flags_on_first_load: true,
              respect_dnt: true,
              opt_in_site_apps: false,
              save_referrer: false,
              save_campaign_params: false,
              disable_capture_url_hashes: true,
              mask_personal_data_properties: true,
              property_denylist: [
                '$initial_current_url',
                '$initial_pathname',
                '$initial_referrer',
                '$initial_referring_domain',
                '$title',
                'title',
                'document_title',
                'email',
                'name',
                'filename',
                'documentName',
                'companyName',
              ],
              rate_limiting: { events_per_second: 5, events_burst_limit: 20 },
            })

            // Las excepciones que ocurrieron antes de este instante estan en
            // cola; el sink las entrega ahora. Ver capture-client-exception.ts.
            registerExceptionSink(posthog)

            return posthog
          }
        )

        // Un candado de modulo tambien recuerda los fracasos: si el chunk no
        // baja, la analitica quedaria muerta hasta la proxima recarga entera.
        // El `useRef` daba ese reintento gratis al remontar, asi que el
        // candado se suelta cuando ESTE intento falla y el siguiente montaje
        // vuelve a probar.
        pending.catch(() => {
          if (postHogInit === pending) postHogInit = null
        })

        postHogInit = pending
      }

      fiber = runClientFork(attachPostHogRuntime(postHogInit))
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit) && exit.value) setRuntime(exit.value)
      })
    })

    return () => {
      cancelled = true
      cancelScheduledPostHogInit(scheduledInit)
      fiber?.interruptUnsafe()
    }
  }, [])

  return runtime
}

// ============================================================================
// PROVIDER COMPONENT
// ============================================================================

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const runtime = usePostHogRuntime()

  // Una sola forma, siempre. Sin analytics, con analytics, en una ruta
  // confidencial o mientras el SDK baja: el elemento raiz es el mismo y los
  // children conservan su estado. Lo unico que cambia es el valor del contexto.
  return <PostHogClientContext value={runtime}>{children}</PostHogClientContext>
}
