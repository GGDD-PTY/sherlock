// ============================================================================
// USE NOTIFICATIONS HOOK
// ============================================================================
// Hook para acceder a las notificaciones del usuario actual.
// Usa Convex para suscripciones en tiempo real automáticas.
// Incluye preferencias de notificación guardadas en Convex.
//
// ===== LA COSTURA CON EFFECT =====
// Las suscripciones en tiempo real siguen siendo de Convex: `useQuery` es su
// modelo y Effect no lo mejora. Lo que sí cambia son las tres acciones que el
// cliente dispara. Eran tres `try/catch` con `err: unknown` y tres
// logs copiados; ahora son un solo programa —`runNotificationAction`—
// con error etiquetado (`NotificationActionError`), span con nombre y el aviso
// en un único lugar. El programa se corre en el borde de cada handler y devuelve
// un resultado que el handler lee para decidir el toast; ningún fallo cruza como
// `unknown`, y la acción que falla nunca tumba el gesto del cliente.
// ============================================================================

import { useCallback, useEffect, useRef } from 'react'
import { Effect, Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { localConvexAdminKey } from '@/lib/dev-auth/local-convex-identity'
import { type Notification, type NotificationPreferences } from '@/lib/notifications'
import { toast } from 'sonner'
import { Id } from '../../convex/_generated/dataModel'
import { safeRedirect } from '@/lib/utils/safe-redirect'
import { runClientEffect } from '@/lib/effect/client-runtime'

// ============================================================================
// ERROR TIPADO Y PROGRAMA DE LAS ACCIONES
// ============================================================================
// No se exportan: el contrato del hook son sus cuatro funciones `Promise<void>`.

const NotificationActionSchema = Schema.Literals([
  'markAsRead',
  'markAllAsRead',
  'updatePreferences',
])

type NotificationAction = typeof NotificationActionSchema.Type

class NotificationActionError extends Schema.TaggedError<NotificationActionError>()(
  'NotificationActionError',
  {
    action: NotificationActionSchema,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

/** El resultado ya resuelto: el programa no falla, decide. */
type ActionOutcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false }

/**
 * Corre una mutation de Convex y se traga su fallo, avisando por el logger de
 * Effect. El `aviso` es el prefijo que ya iba en cada log, para que el texto
 * no cambie.
 */
const runNotificationAction = Effect.fn('Notifications.action')(function* <A>(
  action: NotificationAction,
  aviso: string,
  call: () => Promise<A>
): Effect.fn.Return<ActionOutcome<A>> {
  return yield* Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new NotificationActionError({
        action,
        message: `Convex rechazó ${action}.`,
        cause,
      }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(aviso, error)),
    Effect.match({
      onSuccess: (value): ActionOutcome<A> => ({ ok: true, value }),
      onFailure: (): ActionOutcome<A> => ({ ok: false }),
    })
  )
})

// ===== TIPOS =====
interface UseNotificationsReturn {
  // Estado
  notifications: Notification[]
  unreadCount: number
  preferences: NotificationPreferences
  isLoading: boolean

  // Acciones
  markAsRead: (notificationId: Id<'notifications'>) => Promise<void>
  markAllAsRead: () => Promise<void>
  updatePreferences: (prefs: Partial<NotificationPreferences>) => Promise<void>
  refresh: () => Promise<void>
}

// `emitToasts` queda en true para la campana, que es dueña del aviso en
// pantalla. Quien solo lee el conteo (la fila del menú compacto) lo apaga:
// cada instancia del hook tiene su propio ref, y dos efectos vivos muestran
// el mismo toast dos veces.
type UseNotificationsOptions = {
  readonly emitToasts?: boolean
}

// ===== HOOK PRINCIPAL =====
export function useNotifications(options: UseNotificationsOptions = {}): UseNotificationsReturn {
  const emitToasts = options.emitToasts ?? true
  const t = useTranslations('notifications.toast')
  // ===== CURRENT USER =====
  const { profile, isLoading: userLoading, isConvexSessionReady } = useCurrentUser()
  // ES: Las tres queries de abajo llaman `requireAuth` en Convex. Tener perfil
  // no significa que Convex ya tenga el token: `ConvexProviderWithAuth` hace
  // `setAuth` en un efecto del padre, después del efecto de suscripción, y lo
  // repite en cada refresh. Suscribirse antes tira AUTH_NOT_AUTHENTICATED, y
  // ese throw se pintaba en el navbar (el NotificationBell vive ahí).
  // EN: Wait for the Convex session, not just for a profile id.
  // El bypass de desarrollo ya NO apaga las tres queries. Desde el 2026-09-06
  // el backend local recibe la identidad del usuario de `/dev-login`
  // (`setAdminAuth`, ver `src/lib/dev-auth/local-convex-identity.ts`), así que
  // `requireAuth` resuelve al mismo perfil que la página le pasa. Apagarlas
  // dejaba la pantalla vacía aunque la base tuviera filas, y con eso no se mide
  // nada.
  //
  // Pero en dev-auth `isConvexSessionReady` viene en `true` fijo, y eso solo es
  // cierto cuando la impersonación está montada: sin la admin key del backend
  // local —dev-auth contra la nube, o contra local sin key— el cliente llama
  // sin la identidad elegida, `requireAuth` cae al admin del bypass y
  // `markAllAsRead` marcaría los avisos del admin y no los de la lista que se
  // ve. La misma condición que decide la impersonación decide la compuerta.
  const devIdentityReady =
    !DEV_AUTH_ENABLED ||
    localConvexAdminKey(
      {
        NODE_ENV: process.env.NODE_ENV,
        NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
        NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
      },
      DEV_AUTH_ENABLED
    ) !== null

  const notificationUserId =
    isConvexSessionReady && devIdentityReady ? (profile?._id ?? null) : null

  // ===== CONVEX QUERIES (REAL-TIME) =====
  // Estas queries se actualizan automáticamente cuando cambian los datos
  const convexNotifications = useQuery(
    api.notifications.getNotifications,
    notificationUserId ? { userId: notificationUserId, limit: 20 } : 'skip'
  )

  // NOTA: Este es el getUnreadCount de messages, no notifications
  // Necesitamos verificar si existe en notifications también
  const convexUnreadCount = useQuery(
    api.notifications.getUnreadCount,
    notificationUserId ? { userId: notificationUserId } : 'skip'
  )

  // Preferencias de notificación (real-time desde Convex)
  const convexPreferences = useQuery(
    api.notifications.getPreferences,
    notificationUserId ? { userId: notificationUserId } : 'skip'
  )

  // ===== CONVEX MUTATIONS =====
  const markAsReadMutation = useMutation(api.notifications.markAsRead)
  const markAllAsReadMutation = useMutation(api.notifications.markAllAsRead)
  const updatePreferencesMutation = useMutation(api.notifications.updatePreferences)

  // ===== TRANSFORM CONVEX DATA TO LEGACY FORMAT =====
  // Convertir de formato Convex a formato del lib/notifications.ts
  const notifications: Notification[] = (convexNotifications ?? []).map((n) => ({
    id: n._id,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    message: n.message,
    link: n.link,
    is_read: n.isRead ?? false,
    created_at: new Date(n._creationTime).toISOString(),
    metadata: {
      actorId: n.actorId,
      entityType: n.entityType,
      entityId: n.entityId,
    },
  }))

  const unreadCount = convexUnreadCount ?? 0
  const isLoading = userLoading || Boolean(notificationUserId && convexNotifications === undefined)

  // ===== TOAST PARA NUEVAS NOTIFICACIONES EN TIEMPO REAL =====
  // Guardamos el count anterior para detectar nuevas notificaciones
  const prevUnreadCountRef = useRef<number | null>(null)

  useEffect(() => {
    if (!emitToasts) return
    // ES: Sembramos el ref con el primer valor REAL. Mientras las queries están
    //     en 'skip' o cargando, `convexUnreadCount` es undefined (el 0 de
    //     `unreadCount` es un placeholder, no "cero sin leer"). Sembrar con ese
    //     0 hacía que el salto 0 → N al resolver disparara un toast espurio con
    //     una notificación vieja en cada carga de página.
    // EN: Seed the ref from the first resolved value so the loading placeholder
    //     never looks like "there were zero unread".
    if (convexUnreadCount === undefined) return

    if (prevUnreadCountRef.current === null) {
      prevUnreadCountRef.current = convexUnreadCount
      return
    }

    // Solo mostrar toast si:
    // 1. El nuevo count es mayor que el anterior real
    // 2. Hay al menos una notificación nueva
    if (convexUnreadCount > prevUnreadCountRef.current && notifications.length > 0) {
      // Tomar la notificación más reciente (primera del array)
      const latestNotification = notifications[0]
      if (latestNotification && !latestNotification.is_read) {
        // Mostrar toast con la notificación
        toast(latestNotification.title, {
          description: latestNotification.message,
          action: latestNotification.link
            ? {
                label: t('view'),
                onClick: () => {
                  safeRedirect(latestNotification.link as string, '/notifications')
                },
              }
            : undefined,
        })
      }
    }

    // Actualizar el ref después de procesar
    prevUnreadCountRef.current = convexUnreadCount
  }, [convexUnreadCount, emitToasts, notifications, t])

  // ===== MARCAR COMO LEÍDA =====
  // El resultado del programa se lee, no se tira: un rechazo de Convex dejaba
  // el punto azul puesto sin decir nada y el cliente creía que ya lo había
  // marcado. El gesto no se tumba —la lista sigue viva— pero el fallo se canta.
  const handleMarkAsRead = useCallback(
    async (notificationId: Id<'notifications'>) => {
      const outcome = await runClientEffect(
        runNotificationAction('markAsRead', '[useNotifications] Error marking as read:', () =>
          markAsReadMutation({ notificationId })
        )
      )

      if (!outcome.ok) toast.error(t('markError'))
    },
    [markAsReadMutation, t]
  )

  // ===== MARCAR TODAS COMO LEÍDAS =====
  const handleMarkAllAsRead = useCallback(async () => {
    if (!profile?._id) return

    // NOTA: markAllAsRead obtiene el userId automáticamente del usuario autenticado
    const outcome = await runClientEffect(
      runNotificationAction('markAllAsRead', '[useNotifications] Error marking all as read:', () =>
        markAllAsReadMutation({})
      )
    )

    if (outcome.ok) {
      toast.success(t('markAllRead', { count: outcome.value }))
      return
    }
    toast.error(t('markError'))
  }, [profile, markAllAsReadMutation, t])

  // ===== ACTUALIZAR PREFERENCIAS (Guardadas en Convex) =====
  const handleUpdatePreferences = useCallback(
    async (newPrefs: Partial<NotificationPreferences>) => {
      if (!profile?._id) return

      const outcome = await runClientEffect(
        runNotificationAction(
          'updatePreferences',
          '[useNotifications] Error updating preferences:',
          () =>
            updatePreferencesMutation({
              userId: profile._id,
              ...newPrefs,
            })
        )
      )

      if (outcome.ok) {
        toast.success(t('preferencesUpdated'))
        return
      }
      toast.error(t('preferencesError'))
    },
    [profile, t, updatePreferencesMutation]
  )

  // ===== REFRESH (no-op con Convex, es automático) =====
  const refresh = useCallback(async () => {
    // Con Convex las queries se actualizan automáticamente
    // Este método existe por compatibilidad con la interfaz legacy
  }, [])

  // ===== PREFERENCIAS CON DEFAULTS =====
  // Si Convex aún no cargó, usamos defaults seguros
  const preferences: NotificationPreferences = convexPreferences ?? {
    emailNewConnection: true,
    emailNewMessage: true,
    emailRoomUpdates: true,
    emailWeeklyDigest: true,
    emailAnalysisComplete: true,
    pushEnabled: true,
  }

  return {
    notifications,
    unreadCount,
    preferences,
    isLoading,
    markAsRead: handleMarkAsRead,
    markAllAsRead: handleMarkAllAsRead,
    updatePreferences: handleUpdatePreferences,
    refresh,
  }
}
