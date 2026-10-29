import { Effect } from 'effect'

import type { QueryCtx } from '../_generated/server'
import { mapExistingDocs } from '../_helpers/batch'
import { convexPromise, runConvex } from '../_helpers/effect'

const DAY_MS = 24 * 60 * 60 * 1000
// Offset fijo: Panamá no tiene horario de verano.
const PANAMA_OFFSET_MS = 5 * 60 * 60 * 1000

/** Día de Panamá (`YYYY-MM-DD`). */
export function dayKey(timestamp: number): string {
  return new Date(timestamp - PANAMA_OFFSET_MS).toISOString().slice(0, 10)
}

/** Medianoche de Panamá del día del timestamp, en época. */
export function startOfDay(timestamp: number): number {
  return Math.floor((timestamp - PANAMA_OFFSET_MS) / DAY_MS) * DAY_MS + PANAMA_OFFSET_MS
}

// El único hecho que la vista de actividad sabe contar y los dos roles que
// puede nombrar. Vocabulario declarado: agregar un hecho obliga a pasar por acá.
type ActivityType = 'USER_JOINED'
type ActivityRole = 'COMPANY' | 'ADMIN'

export type Activity = {
  readonly type: 'USER_JOINED'
  readonly timestamp: number
  readonly personLabel?: string
  readonly role?: ActivityRole
}

// La unión y el vocabulario no pueden separarse: un hecho nuevo en uno y no en
// el otro deja de compilar.
/**
 * «Estos dos tipos son EXACTAMENTE el mismo», comprobado en las dos
 * direcciones y en una sola declaración.
 *
 * La forma anterior era `MustExtend<A, B> & MustExtend<B, A>`. Funcionaba, pero
 * cuando la comprobación tiene éxito los dos lados de la intersección son el
 * mismo tipo, y `no-duplicate-type-constituents` lo marca: el lint se disparaba
 * justo cuando el contrato se cumplía. Esta forma no interseca nada.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const _sameActivityVocabulary: Exact<ActivityType, Activity['type']> = true

// Cap de seguridad por tabla: la vista admin pide hasta 50, pero nadie debe
// poder pedir lecturas arbitrariamente grandes via el arg limit.
const MAX_ACTIVITY_PER_SOURCE = 100

const fetchRecentActivitySources = Effect.fn('Analytics.recentActivitySources')(function* (
  ctx: QueryCtx,
  perSource: number
) {
  const capped = Math.max(1, Math.min(perSource, MAX_ACTIVITY_PER_SOURCE))

  const recentProfiles = yield* convexPromise(() =>
    ctx.db.query('profiles').order('desc').take(capped)
  )

  return { recentProfiles }
})

export const buildRecentActivityEffect = Effect.fn('Analytics.recentActivity')(function* (
  ctx: QueryCtx,
  limit: number
) {
  if (limit <= 0) return [] as Activity[]

  const { recentProfiles } = yield* fetchRecentActivitySources(ctx, limit)

  const userIds = recentProfiles
    .filter((profile) => profile.userId)
    .map((profile) => profile.userId!)

  const users = yield* convexPromise(() => Promise.all(userIds.map((id) => ctx.db.get(id))))

  const userMap = mapExistingDocs(users)
  const activities: Activity[] = []

  for (const profile of recentProfiles) {
    const user = profile.userId ? userMap.get(profile.userId) : null
    const personLabel = profile.fullName || user?.email
    activities.push({
      type: 'USER_JOINED',
      timestamp: profile._creationTime,
      ...(personLabel ? { personLabel } : {}),
      ...(profile.role ? { role: profile.role } : {}),
    })
  }

  return activities.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
})

export function buildRecentActivity(ctx: QueryCtx, limit: number): Promise<Activity[]> {
  return runConvex(buildRecentActivityEffect(ctx, limit))
}
