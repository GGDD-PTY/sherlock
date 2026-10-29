// ============================================================================
// SANITIZADOR DE EVENTOS DE POSTHOG
// ============================================================================
// Lo que `before_send` deja pasar: navegación, interacciones, replay, heatmaps,
// errores y eventos manuales. Todo sale sin query, ids de negocio, texto de la
// interfaz, atributos libres, cuerpos, headers ni perfiles personales.
//
// Solo `import type` de `posthog-js`: un import de valor volvería a meter el
// SDK en el grafo inicial (lo fija `landing-first-paint-contract.test.tsx`).
//
// TODO LO QUE ENTRA ES `unknown`: las propiedades las arma el SDK dentro del
// navegador del cliente. El módulo entero es la misma decisión repetida —«esto
// se deja pasar o el evento se cae»— y antes se escribía como `| null` en cada
// función, con seis `return properties ? personlessEvent(...) : null` idénticos
// en el despachador.
//
// Ahora el motivo de la caída vive en el TIPO: cada paso es un `Effect` que
// falla con `AnalyticsDropError`, y el borde lo corre con `Effect.runSync`
// —`before_send` del SDK es síncrona— y colapsa el fallo en el mismo `null` de
// siempre. Las listas que llegan más sucias (puntos del heatmap, entradas de
// `$exception_list`) se DECODIFICAN con `Schema` en vez de narrowearse a mano.
// ============================================================================

import { Effect, Option, Predicate, Schema } from 'effect'

import type { CaptureResult, CapturedNetworkRequest } from 'posthog-js'
import {
  isManualAnalyticsEventName,
  isSafeManualAnalyticsProperty,
  MANUAL_ANALYTICS_EVENT_PROPERTIES,
} from '@/lib/analytics/event-contract'

const AUTOMATIC_EVENT_NAMES = ['$pageview', '$pageleave', '$web_vitals'] as const
type AutomaticEventName = (typeof AUTOMATIC_EVENT_NAMES)[number]

const INTERACTION_EVENT_NAMES = ['$autocapture', '$rageclick', '$dead_click'] as const
type InteractionEventName = (typeof INTERACTION_EVENT_NAMES)[number]

const EXCEPTION_EVENT_NAME = '$exception'
const SNAPSHOT_EVENT_NAME = '$snapshot'
const HEATMAP_EVENT_NAME = '$$heatmap'
const EXCEPTION_CONTEXT_PROPERTIES = [
  'digest',
  'locale',
  'route',
  '$exception_type',
  '$exception_level',
  '$exception_handled',
  '$exception_source',
] as const
const EXCEPTION_FRAME_LIMIT = 30
const EXCEPTION_LIST_LIMIT = 5
const ELEMENT_CHAIN_LIMIT = 20
const HEATMAP_URL_LIMIT = 20
const HEATMAP_POINT_LIMIT = 2_000

const DYNAMIC_PATH_PARENTS = new Set([
  'companies',
  'invitations',
  'ndas',
  'rooms',
  'users',
])

const AUTOMATIC_CONTEXT_PROPERTIES = [
  'token',
  'distinct_id',
  '$device_id',
  '$session_id',
  '$window_id',
  '$lib',
  '$lib_version',
  '$insert_id',
  '$time',
  '$sent_at',
  '$geoip_disable',
  '$process_person_profile',
  '$browser',
  '$browser_version',
  '$os',
  '$os_version',
  '$device_type',
  '$viewport_width',
  '$viewport_height',
  '$screen_width',
  '$screen_height',
  '$current_url',
  '$host',
  '$pathname',
  '$referrer',
  '$referring_domain',
] as const

const AUTOMATIC_EVENT_PROPERTIES = {
  $pageview: [...AUTOMATIC_CONTEXT_PROPERTIES, '$pageview_id', '$prev_pageview_pathname'],
  $pageleave: [
    ...AUTOMATIC_CONTEXT_PROPERTIES,
    '$pageview_id',
    '$prev_pageview_pathname',
    '$prev_pageview_duration',
    '$prev_pageview_last_content_percentage',
    '$prev_pageview_last_scroll_percentage',
    '$prev_pageview_max_content_percentage',
    '$prev_pageview_max_scroll_percentage',
  ],
  $web_vitals: [
    ...AUTOMATIC_CONTEXT_PROPERTIES,
    '$web_vitals_CLS_value',
    '$web_vitals_FCP_value',
    '$web_vitals_INP_value',
    '$web_vitals_LCP_value',
    '$web_vitals_TTFB_value',
  ],
} as const satisfies Record<AutomaticEventName, readonly string[]>

type SafeUrlContext = {
  currentUrl: string
  host: string
  origin: string
  pathname: string
}

/**
 * Por qué se cayó un evento. Que sea un error TAGGED es el punto: un `null` no
 * distingue «este nombre de evento no se manda» —el caso normal— de «la URL del
 * SDK no se pudo leer», que es señal de que algo se rompió.
 */
class AnalyticsDropError extends Schema.TaggedError<AnalyticsDropError>()('AnalyticsDropError', {
  reason: Schema.Literals([
    'evento_no_listado',
    'url_no_confiable',
    'sin_datos_de_heatmap',
    'snapshot_incompleto',
  ]),
}) {}

function drop(reason: typeof AnalyticsDropError.Type.reason): AnalyticsDropError {
  return new AnalyticsDropError({ reason })
}

// ============================================================================
// FORMAS QUE LLEGAN DEL SDK
// ============================================================================
// `$heatmap_data` y `$exception_list` son las dos listas que el SDK arma con lo
// que encuentra en la página. Se decodifican; lo que no encaja se descarta.

const HeatmapPointSchema = Schema.Struct({
  x: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  y: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  type: Schema.Literals(['click', 'mousemove', 'rageclick', 'deadclick']),
})

const decodeHeatmapPoint = Schema.decodeUnknownOption(HeatmapPointSchema)

// El tipo de la excepción es lo único del `$exception_list` que sale con su
// valor real; el patrón es lo que impide que alguien meta un mensaje ahí.
const ExceptionTypeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.$<>-]{1,128}$/))
)
const isExceptionType = Schema.is(ExceptionTypeSchema)

function isAutomaticEventName(eventName: string): eventName is AutomaticEventName {
  return AUTOMATIC_EVENT_NAMES.some((automaticEventName) => automaticEventName === eventName)
}

function isInteractionEventName(eventName: string): eventName is InteractionEventName {
  return INTERACTION_EVENT_NAMES.some((interactionEventName) => interactionEventName === eventName)
}

function isIdentifierLikePathSegment(segment: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return true
  }
  if (decoded.includes('@')) return true
  if (/^\d{4,}$/.test(decoded)) return true
  if (/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(decoded)) return true
  return decoded.length >= 16 && /[a-z]/i.test(decoded) && /\d/.test(decoded)
}

export function sanitizeAnalyticsPathname(pathname: string): string {
  const segments = pathname.split('/')
  return segments
    .map((segment, index) => {
      if (!segment) return segment
      const previous = segments[index - 1]
      return (previous && DYNAMIC_PATH_PARENTS.has(previous)) ||
        isIdentifierLikePathSegment(segment)
        ? ':id'
        : segment
    })
    .join('/')
}

function safeUrlContext(rawUrl: unknown): Option.Option<SafeUrlContext> {
  if (typeof window === 'undefined') return Option.none()

  const candidate = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : window.location.href
  const parse = Option.liftThrowable((input: string) => new URL(input, window.location.origin))

  return parse(candidate).pipe(
    Option.filter((url) => url.protocol === 'http:' || url.protocol === 'https:'),
    Option.map((url) => {
      const pathname = sanitizeAnalyticsPathname(url.pathname)

      return {
        currentUrl: `${url.origin}${pathname}`,
        host: url.host,
        origin: url.origin,
        pathname,
      }
    })
  )
}

/** La URL que el evento necesita sí o sí: sin ella no hay evento. */
function requiredUrlContext(rawUrl: unknown): Effect.Effect<SafeUrlContext, AnalyticsDropError> {
  return Effect.fromOption(safeUrlContext(rawUrl), () => drop('url_no_confiable'))
}

/**
 * Una URL opcional: ausente se acepta vacía, presente pero ilegible tumba el
 * evento. Colapsar los dos casos en un `null` era justo lo que hacía difícil de
 * leer este archivo.
 */
function optionalUrlContext(
  rawValue: unknown
): Effect.Effect<Option.Option<SafeUrlContext>, AnalyticsDropError> {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return Effect.succeed(Option.none())
  }

  return requiredUrlContext(rawValue).pipe(Effect.map(Option.some))
}

function isSafeAutomaticValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length <= 128 && /^[A-Za-z0-9_.:+-]+$/.test(value)
  }
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  return typeof value === 'boolean'
}

const sanitizeAutomaticProperties = Effect.fn('PostHogSanitize.automatic')(function* (
  eventName: AutomaticEventName,
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const location = yield* requiredUrlContext(sourceProperties.$current_url)
  const previousLocation = yield* optionalUrlContext(sourceProperties.$prev_pageview_pathname)
  const referrer = yield* optionalUrlContext(sourceProperties.$referrer)

  const properties: CaptureResult['properties'] = {}
  for (const property of AUTOMATIC_EVENT_PROPERTIES[eventName]) {
    if (
      property === '$current_url' ||
      property === '$host' ||
      property === '$pathname' ||
      property === '$referrer' ||
      property === '$referring_domain' ||
      property === '$prev_pageview_pathname'
    ) {
      continue
    }

    const value = sourceProperties[property]
    if (isSafeAutomaticValue(value)) properties[property] = value
  }

  properties.$current_url = location.currentUrl
  properties.$host = location.host
  properties.$pathname = location.pathname

  if (Option.isSome(referrer)) {
    const source = referrer.value
    properties.$referrer =
      source.origin === window.location.origin ? source.currentUrl : source.origin
    properties.$referring_domain = source.host
  }
  if (Option.isSome(previousLocation)) {
    properties.$prev_pageview_pathname = previousLocation.value.pathname
  }

  return properties
})

/** El contexto base que llevan TODOS los eventos, sea cual sea su tipo. */
function baseProperties(
  sourceProperties: CaptureResult['properties']
): Effect.Effect<CaptureResult['properties'], AnalyticsDropError> {
  return sanitizeAutomaticProperties('$pageview', sourceProperties)
}

const sanitizeManualProperties = Effect.fn('PostHogSanitize.manual')(function* (
  eventName: keyof typeof MANUAL_ANALYTICS_EVENT_PROPERTIES,
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const properties = yield* baseProperties(sourceProperties)

  for (const property of MANUAL_ANALYTICS_EVENT_PROPERTIES[eventName]) {
    const value = sourceProperties[property]
    if (isSafeManualAnalyticsProperty(property, value)) properties[property] = value
  }

  return properties
})

function sanitizeElementsChain(rawChain: unknown): Option.Option<string> {
  if (typeof rawChain !== 'string' || rawChain.length === 0) return Option.none()
  const elements = rawChain
    .split(';')
    .slice(0, ELEMENT_CHAIN_LIMIT)
    .flatMap((rawElement) => {
      const tag = /^[a-z][a-z0-9-]*/i.exec(rawElement)?.[0]?.toLowerCase()
      if (!tag) return []
      const nthChild = /nth-child="(\d{1,4})"/.exec(rawElement)?.[1]
      const nthOfType = /nth-of-type="(\d{1,4})"/.exec(rawElement)?.[1]
      return [
        `${tag}:${nthChild ? `nth-child="${nthChild}"` : ''}${nthOfType ? `nth-of-type="${nthOfType}"` : ''}`,
      ]
    })
  return elements.length > 0 ? Option.some(elements.join(';')) : Option.none()
}

const sanitizeInteractionProperties = Effect.fn('PostHogSanitize.interaction')(function* (
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const properties = yield* baseProperties(sourceProperties)

  const eventType = sourceProperties.$event_type
  if (eventType === 'click' || eventType === 'submit') properties.$event_type = eventType
  if (
    typeof sourceProperties.$ce_version === 'number' &&
    Number.isFinite(sourceProperties.$ce_version)
  ) {
    properties.$ce_version = sourceProperties.$ce_version
  }
  const chain = sanitizeElementsChain(sourceProperties.$elements_chain)
  if (Option.isSome(chain)) properties.$elements_chain = chain.value
  if (sourceProperties.$rageclick === true) properties.$rageclick = true
  if (sourceProperties.$dead_click === true) properties.$dead_click = true

  return properties
})

// El punto se decodifica con su schema; `target_fixed` se vuelve a pegar aparte
// porque un valor basura en ese campo no puede costar el punto entero.
function sanitizeHeatmapPoint(rawPoint: unknown): Option.Option<Record<string, unknown>> {
  return decodeHeatmapPoint(rawPoint).pipe(
    Option.map((point) => ({
      x: point.x,
      y: point.y,
      type: point.type,
      ...(Predicate.isObject(rawPoint) && typeof rawPoint.target_fixed === 'boolean'
        ? { target_fixed: rawPoint.target_fixed }
        : {}),
    }))
  )
}

function sanitizeHeatmapData(
  rawData: unknown
): Option.Option<Record<string, Array<Record<string, unknown>>>> {
  if (!Predicate.isObject(rawData)) return Option.none()
  const sanitized: Record<string, Array<Record<string, unknown>>> = {}

  for (const [rawUrl, rawPoints] of Object.entries(rawData).slice(0, HEATMAP_URL_LIMIT)) {
    const location = safeUrlContext(rawUrl)
    if (Option.isNone(location) || !Array.isArray(rawPoints)) continue
    const points = rawPoints
      .slice(0, HEATMAP_POINT_LIMIT)
      .flatMap((point) => Option.toArray(sanitizeHeatmapPoint(point)))
    if (points.length > 0) sanitized[location.value.currentUrl] = points
  }

  return Object.keys(sanitized).length > 0 ? Option.some(sanitized) : Option.none()
}

const sanitizeHeatmapProperties = Effect.fn('PostHogSanitize.heatmap')(function* (
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const properties = yield* baseProperties(sourceProperties)
  const heatmapData = yield* Effect.fromOption(
    sanitizeHeatmapData(sourceProperties.$heatmap_data),
    () => drop('sin_datos_de_heatmap')
  )

  properties.$heatmap_data = heatmapData
  return properties
})

// El SDK arma `$exception_list` con el stack completo: nombres de archivo con
// query, la línea de código y sus variables locales. Solo sobrevive el esqueleto
// que sirve para depurar. Cada campo se tolera por separado a propósito: un
// `colno` basura no puede borrar el `filename` del mismo frame.
function sanitizeExceptionFrames(rawFrames: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawFrames)) return []

  const frames: Array<Record<string, unknown>> = []
  for (const rawFrame of rawFrames.slice(0, EXCEPTION_FRAME_LIMIT)) {
    if (!Predicate.isObject(rawFrame)) continue
    const frame: Record<string, unknown> = {}

    if (typeof rawFrame.filename === 'string') {
      frame.filename = rawFrame.filename.split('?')[0]?.slice(0, 256)
    }
    if (typeof rawFrame.function === 'string') frame.function = rawFrame.function.slice(0, 128)
    if (typeof rawFrame.lineno === 'number' && Number.isFinite(rawFrame.lineno)) {
      frame.lineno = rawFrame.lineno
    }
    if (typeof rawFrame.colno === 'number' && Number.isFinite(rawFrame.colno)) {
      frame.colno = rawFrame.colno
    }
    if (typeof rawFrame.in_app === 'boolean') frame.in_app = rawFrame.in_app

    if (Object.keys(frame).length > 0) frames.push(frame)
  }
  return frames
}

function sanitizeExceptionList(rawList: unknown): Option.Option<Array<Record<string, unknown>>> {
  if (!Array.isArray(rawList) || rawList.length === 0) return Option.none()

  const list = rawList.slice(0, EXCEPTION_LIST_LIMIT).flatMap((rawException) => {
    if (!Predicate.isObject(rawException)) return []
    const type = isExceptionType(rawException.type) ? rawException.type : 'Error'

    return [
      {
        type,
        value: '[redacted]',
        stacktrace: {
          type: 'raw',
          frames: sanitizeExceptionFrames(
            Predicate.isObject(rawException.stacktrace) ? rawException.stacktrace.frames : undefined
          ),
        },
      },
    ]
  })

  return list.length > 0 ? Option.some(list) : Option.none()
}

const sanitizeExceptionProperties = Effect.fn('PostHogSanitize.exception')(function* (
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const properties = yield* baseProperties(sourceProperties)

  for (const property of EXCEPTION_CONTEXT_PROPERTIES) {
    const value = sourceProperties[property]

    if (property === 'digest') {
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        properties.digest = value
      }
      continue
    }
    if (property === 'locale') {
      if (value === 'es') properties.locale = value
      continue
    }
    if (property === 'route') {
      const route = safeUrlContext(value)
      if (Option.isSome(route)) properties.route = route.value.pathname
      continue
    }
    if (isSafeAutomaticValue(value)) properties[property] = value
  }

  const exceptionList = sanitizeExceptionList(sourceProperties.$exception_list)
  if (Option.isSome(exceptionList)) properties.$exception_list = exceptionList.value
  properties.$exception_message = '[redacted]'

  return properties
})

const sanitizeSnapshotProperties = Effect.fn('PostHogSanitize.snapshot')(function* (
  sourceProperties: CaptureResult['properties']
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  const properties = yield* baseProperties(sourceProperties)

  if (
    typeof sourceProperties.$snapshot_bytes !== 'number' ||
    !Number.isFinite(sourceProperties.$snapshot_bytes) ||
    sourceProperties.$snapshot_bytes < 0 ||
    (!Array.isArray(sourceProperties.$snapshot_data) &&
      typeof sourceProperties.$snapshot_data !== 'string')
  ) {
    return yield* drop('snapshot_incompleto')
  }

  properties.$snapshot_bytes = sourceProperties.$snapshot_bytes
  properties.$snapshot_data = sourceProperties.$snapshot_data
  return properties
})

function personlessEvent(
  event: CaptureResult,
  properties: CaptureResult['properties']
): CaptureResult {
  properties.$process_person_profile = false
  const sanitizedEvent = { ...event, properties }
  delete sanitizedEvent.$set
  delete sanitizedEvent.$set_once
  delete sanitizedEvent.$unset
  return sanitizedEvent
}

export function sanitizeReplayNetworkRequest(
  request: CapturedNetworkRequest
): CapturedNetworkRequest | null {
  return safeUrlContext(request.name).pipe(
    Option.map((location) => {
      const sanitized = { ...request, name: location.currentUrl }
      delete sanitized.requestHeaders
      delete sanitized.responseHeaders
      delete sanitized.requestBody
      delete sanitized.responseBody
      return sanitized
    }),
    Option.getOrNull
  )
}

/** El despachador: qué sanitizador le toca a cada evento. */
const sanitizedProperties = Effect.fn('PostHogSanitize.dispatch')(function* (
  event: CaptureResult
): Effect.fn.Return<CaptureResult['properties'], AnalyticsDropError> {
  if (isManualAnalyticsEventName(event.event)) {
    return yield* sanitizeManualProperties(event.event, event.properties)
  }
  if (event.event === EXCEPTION_EVENT_NAME) {
    return yield* sanitizeExceptionProperties(event.properties)
  }
  if (event.event === SNAPSHOT_EVENT_NAME) {
    return yield* sanitizeSnapshotProperties(event.properties)
  }
  if (event.event === HEATMAP_EVENT_NAME) {
    return yield* sanitizeHeatmapProperties(event.properties)
  }
  if (isInteractionEventName(event.event)) {
    return yield* sanitizeInteractionProperties(event.properties)
  }
  if (!isAutomaticEventName(event.event)) {
    return yield* drop('evento_no_listado')
  }

  return yield* sanitizeAutomaticProperties(event.event, event.properties)
})

export function sanitizeAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || typeof window === 'undefined') return null

  return Effect.runSync(
    sanitizedProperties(event).pipe(
      Effect.map((properties) => personlessEvent(event, properties)),
      Effect.catchTag('AnalyticsDropError', () => Effect.succeed(null))
    )
  )
}
