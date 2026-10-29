// ===== NOTIFICATIONS PAGE =====
// Centro de notificaciones del usuario
// Muestra todas las notificaciones en una lista filtrable

import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { redirect } from '@/i18n/navigation'
import { requireAuth } from '@/lib/auth/session'
import { LazyNotificationsPage } from '@/components/lazy'
import { runServerEffect } from '@/lib/effect/runtime'
import { getTranslations, setRequestLocale } from 'next-intl/server'

// `requireAuth` + el `redirect()` de abajo se quedan fuera de cualquier
// programa Effect (effect-brief-react.md: envolverlos en
// Effect.exit/either/result les borra el `digest` que Next necesita para el
// redirect y la página renderizaría como si el visitante ya tuviera perfil).

class NotificationsCopyError extends Schema.TaggedError<NotificationsCopyError>()(
  'NotificationsCopyError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadNotificationsCopy = Effect.fn('Notifications.loadCopy')(function* (locale: string) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'notifications' }),
    catch: (cause) => new NotificationsCopyError({ cause }),
  })
})

// ===== METADATA =====
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadNotificationsCopy(locale))

  return {
    title: t('pageTitle'),
    description: t('pageDescription'),
  }
}

// ===== PAGE COMPONENT =====
export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  // ===== REQUERIR AUTENTICACIÓN =====
  const user = await requireAuth('/notifications', locale)

  if (!user.profileId) {
    redirect({ href: '/onboarding', locale })
  }

  // ===== RENDERIZAR =====
  return <LazyNotificationsPage />
}
