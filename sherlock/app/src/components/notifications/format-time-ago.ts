import { Schema } from 'effect'

import { PANAMA_TIME_ZONE } from '@/lib/utils'

type TimeTranslator = (key: string, values?: { count: number }) => string

// Los tramos de «hace cuánto» son vocabulario del catálogo, no números sueltos:
// cada clave existe en `notifications.time` de es.json y el orden es el de
// evaluación.
const TimeBucketSchema = Schema.Literals([
  'time.justNow',
  'time.minutesAgo',
  'time.hoursAgo',
  'time.yesterday',
  'time.daysAgo',
  'time.weeksAgo',
])
type TimeBucket = typeof TimeBucketSchema.Type
const [JUST_NOW, MINUTES_AGO, HOURS_AGO, YESTERDAY, DAYS_AGO, WEEKS_AGO] = TimeBucketSchema.literals

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30

function pickBucket(diffSeconds: number): { key: TimeBucket; count: number } | null {
  const diffMinutes = Math.floor(diffSeconds / SECONDS_PER_MINUTE)
  const diffHours = Math.floor(diffMinutes / MINUTES_PER_HOUR)
  const diffDays = Math.floor(diffHours / HOURS_PER_DAY)

  if (diffSeconds < SECONDS_PER_MINUTE) return { key: JUST_NOW, count: 0 }
  if (diffMinutes < MINUTES_PER_HOUR) return { key: MINUTES_AGO, count: diffMinutes }
  if (diffHours < HOURS_PER_DAY) return { key: HOURS_AGO, count: diffHours }
  if (diffDays === 1) return { key: YESTERDAY, count: 0 }
  if (diffDays < DAYS_PER_WEEK) return { key: DAYS_AGO, count: diffDays }
  if (diffDays < DAYS_PER_MONTH) {
    return { key: WEEKS_AGO, count: Math.floor(diffDays / DAYS_PER_WEEK) }
  }
  return null
}

export function formatNotificationTimeAgo(
  dateString: string,
  locale: string,
  t: TimeTranslator
): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return t('time.invalid')

  const bucket = pickBucket(Math.floor((Date.now() - date.getTime()) / 1000))
  if (bucket === null) {
    // Pasada la ventana relativa se imprime la fecha, y esa fecha es la de
    // Panamá: la zona del navegador movía el día de una notificación nocturna.
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: PANAMA_TIME_ZONE,
    }).format(date)
  }
  return bucket.count > 0 ? t(bucket.key, { count: bucket.count }) : t(bucket.key)
}
