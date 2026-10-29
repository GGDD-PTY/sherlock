// ============================================================================
// CONTRATO DE EVENTOS MANUALES DE ANALÍTICA
// ============================================================================
// Cada vocabulario se escribe UNA vez, como `Schema.Literals`, y el mapa de
// tipos sale de esos schemas. Antes había dos copias de las mismas listas —el
// tipo de cada evento arriba y la cascada de `value === '...'` de
// `isSafeManualAnalyticsProperty` abajo— que coincidían por costumbre: agregar
// un modo al tipo sin agregarlo al guard hacía que el sanitizador tirara la
// propiedad en silencio, y al revés dejaba pasar un valor que ningún evento
// declara.
//
// Los modos por evento se sacan con `pick` del vocabulario completo, así que
// renombrar un modo rompe la compilación de todos los eventos que lo usan.
// ============================================================================

import { Schema } from 'effect'

const LocaleSchema = Schema.Literals(['es'])
type Locale = typeof LocaleSchema.Type

const RoleSchema = Schema.Literals(['COMPANY'])
type Role = typeof RoleSchema.Type

export const AnalyticsModeSchema = Schema.Literals(['UNRESOLVED', 'TEMPORARY', 'PERMANENT', 'DEMO'])
type IntakeMode = 'UNRESOLVED' | 'TEMPORARY' | 'PERMANENT'
type WorkspaceMode = 'TEMPORARY' | 'PERMANENT' | 'DEMO'
type DurableMode = 'TEMPORARY' | 'PERMANENT'
type DeliveredMode = 'PERMANENT' | 'DEMO'
type ClaimedMode = 'PERMANENT'

const CompletionBandSchema = Schema.Literals(['LOW', 'MEDIUM', 'HIGH'])
const SurfaceSchema = Schema.Literals(['PREPARATION_PACKAGE'])

// Una duración o un contador: número finito, no negativo y con techo de un día
// en milisegundos. El techo existe para que un reloj corrido en el navegador no
// mande un número absurdo a PostHog.
const MAX_DURATION_MS = 86_400_000
const CountOrDurationSchema = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_DURATION_MS }))
)

export type ManualAnalyticsEventMap = {
  intake_started: { locale: Locale; mode: IntakeMode }
  files_selected: {
    locale: Locale
    mode: IntakeMode
    fileCount: number
  }
  workspace_entered: { locale: Locale; mode: WorkspaceMode }
  first_durable_upload: {
    locale: Locale
    mode: DurableMode
    fileCount: number
  }
  assessment_ready: {
    locale: Locale
    mode: DeliveredMode
    completionBand: typeof CompletionBandSchema.Type
  }
  deliverable_viewed: {
    locale: Locale
    mode: DeliveredMode
    surface: typeof SurfaceSchema.Type
  }
  support_opened: { locale: Locale; mode: WorkspaceMode }
  workspace_claimed: { locale: Locale; mode: ClaimedMode }
  onboarding_started: { role: Role }
  onboarding_step_viewed: { role: Role; step: number }
  onboarding_step_completed: { role: Role; step: number; timeSpentMs: number }
  onboarding_completed: {
    role: Role
    totalSteps: number
    totalTimeMs: number
    stepsCompleted: number
  }
  onboarding_abandoned: {
    role: Role
    lastStepReached: number
    timeOnLastStepMs: number
    totalTimeMs: number
  }
}

export type ManualAnalyticsEventName = keyof ManualAnalyticsEventMap

export type AnalyticsEvent = {
  [EventName in ManualAnalyticsEventName]: {
    event: EventName
    properties: ManualAnalyticsEventMap[EventName]
  }
}[ManualAnalyticsEventName]

export const MANUAL_ANALYTICS_EVENT_PROPERTIES = {
  intake_started: ['locale', 'mode'],
  files_selected: ['locale', 'mode', 'fileCount'],
  workspace_entered: ['locale', 'mode'],
  first_durable_upload: ['locale', 'mode', 'fileCount'],
  assessment_ready: ['locale', 'mode', 'completionBand'],
  deliverable_viewed: ['locale', 'mode', 'surface'],
  support_opened: ['locale', 'mode'],
  workspace_claimed: ['locale', 'mode'],
  onboarding_started: ['role'],
  onboarding_step_viewed: ['role', 'step'],
  onboarding_step_completed: ['role', 'step', 'timeSpentMs'],
  onboarding_completed: ['role', 'totalSteps', 'stepsCompleted', 'totalTimeMs'],
  onboarding_abandoned: ['role', 'lastStepReached', 'timeOnLastStepMs', 'totalTimeMs'],
} as const satisfies {
  [EventName in ManualAnalyticsEventName]: readonly (keyof ManualAnalyticsEventMap[EventName])[]
}

export function isManualAnalyticsEventName(
  eventName: string
): eventName is ManualAnalyticsEventName {
  return Object.prototype.hasOwnProperty.call(MANUAL_ANALYTICS_EVENT_PROPERTIES, eventName)
}

// El guard es por propiedad, no por evento: `mode` acepta el vocabulario
// completo aunque cada evento declare un subconjunto. Es a propósito —el
// sanitizador corre sobre lo que el SDK arma en el navegador del cliente, no
// sobre lo que el llamador tipó— pero ahora la lista que acepta es la misma
// que la que los eventos pueden declarar, y no dos listas paralelas.
const isLocale = Schema.is(LocaleSchema)
const isRole = Schema.is(RoleSchema)
const isAnalyticsMode = Schema.is(AnalyticsModeSchema)
const isCompletionBand = Schema.is(CompletionBandSchema)
const isSurface = Schema.is(SurfaceSchema)
const isCountOrDuration = Schema.is(CountOrDurationSchema)

export function isSafeManualAnalyticsProperty(property: string, value: unknown): boolean {
  if (property === 'locale') return isLocale(value)
  if (property === 'role') return isRole(value)
  if (property === 'mode') return isAnalyticsMode(value)
  if (property === 'completionBand') return isCompletionBand(value)
  if (property === 'surface') return isSurface(value)

  return isCountOrDuration(value)
}
