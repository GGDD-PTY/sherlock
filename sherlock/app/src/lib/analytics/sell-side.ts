import { Schema } from 'effect'

import { track } from '@/lib/analytics/posthog'
import {
  AnalyticsModeSchema,
  MANUAL_ANALYTICS_EVENT_PROPERTIES,
  type ManualAnalyticsEventMap,
} from '@/lib/analytics/event-contract'

// Una demo sintética no emite analítica de éxito. El modo se saca con `pick`
// del vocabulario de `event-contract`, no como un `'DEMO'` suelto: escrito a
// mano, renombrar el modo allá dejaba este archivo emitiendo eventos de demo
// sin que nada se quejara.
const isDemoMode = Schema.is(AnalyticsModeSchema.pick(['DEMO']))

type SellSideEventName = Exclude<keyof ManualAnalyticsEventMap, `onboarding_${string}`>
type SellSideEventMap = Pick<ManualAnalyticsEventMap, SellSideEventName>

const emittedEventKeys = new Set<string>()

export function trackSellSideEventOnce<Event extends keyof SellSideEventMap>(
  event: Event,
  properties: SellSideEventMap[Event] & Record<string, unknown>,
  dedupeKey = 'default'
): void {
  if (typeof window === 'undefined' || isDemoMode(properties.mode)) return

  const eventKey = `${event}:${dedupeKey}`
  if (emittedEventKeys.has(eventKey)) return
  emittedEventKeys.add(eventKey)

  const safeProperties = Object.fromEntries(
    MANUAL_ANALYTICS_EVENT_PROPERTIES[event].map((key) => [key, properties[key]])
  ) as SellSideEventMap[Event]

  track({ event, properties: safeProperties } as Parameters<typeof track>[0])
}
