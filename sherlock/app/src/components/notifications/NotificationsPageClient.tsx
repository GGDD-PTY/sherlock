'use client'

import { Link } from '@/i18n/navigation'
import { useState, useCallback, memo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Schema } from 'effect'
import { formatNotificationTimeAgo } from '@/components/notifications/format-time-ago'
import { markNotificationsAsRead } from '@/components/notifications/mark-as-read'
import { useNotifications } from '@/hooks/useNotifications'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyNotifications, EmptyState } from '@/components/ui/empty-state'
import { Bell, Check, CheckCheck, Clock } from 'lucide-react'
import { Id } from '@/../convex/_generated/dataModel'
import { cn } from '@/lib/utils'
import { runClientEffect } from '@/lib/effect/client-runtime'

const NotificationTabSchema = Schema.Literals(['all', 'unread', 'read'])
type NotificationTab = typeof NotificationTabSchema.Type
const isNotificationTab = Schema.is(NotificationTabSchema)

// El navbar mide 4rem y el pie del producto 3.5rem: la pantalla se queda con lo
// que sobra del viewport y la lista scrollea por dentro, así que la página nunca
// pasa de 900 px a 1440x900 por muchos avisos que haya (mismo cálculo que
// `AdminLayout`).
const SCREEN_HEIGHT = 'h-[calc(100dvh-7.5rem)]'

export function NotificationsPageClient() {
  const t = useTranslations('notifications')
  const locale = useLocale()
  const [activeTab, setActiveTab] = useState<NotificationTab>('all')
  const { notifications, unreadCount, isLoading, markAsRead, markAllAsRead } = useNotifications()

  const formatTimeAgo = useCallback(
    (dateString: string): string => formatNotificationTimeAgo(dateString, locale, t),
    [locale, t]
  )

  const handleMarkAsRead = useCallback(
    (notificationId: Id<'notifications'>) =>
      runClientEffect(markNotificationsAsRead(() => markAsRead(notificationId))),
    [markAsRead]
  )

  const filteredNotifications = notifications.filter((n) => {
    if (activeTab === 'unread') return !n.is_read
    if (activeTab === 'read') return n.is_read
    return true
  })

  // Las pestañas cuentan LA LISTA que se cargó (el hook pide 20), no el total
  // de la cuenta. Mezclarlos rompía dos cosas: «Leídas» salía de `total - sin
  // leer globales`, o sea negativo en cuanto hubiera pendientes fuera de las
  // 20, y «Sin leer» podía quedar vacía con avisos pendientes. El contador
  // global sigue siendo el de la campana; acá solo dice cuántos quedaron
  // afuera de esta lista.
  const unreadInList = notifications.filter((n) => !n.is_read).length
  const readInList = notifications.length - unreadInList
  const unreadBeyondList = Math.max(0, unreadCount - unreadInList)
  // El subtítulo y «Marcar todas» hablan de lo que se ve. Con el filtro
  // «Leídas» puesto, el global decía «13 sin leer» sobre una lista donde no
  // había ninguno y ofrecía marcarlos.
  const unreadInView = filteredNotifications.filter((n) => !n.is_read).length
  // Los que la lista no alcanza a mostrar y este filtro sí admite. En «Leídas»
  // no cuentan: esa pestaña no habla de avisos sin leer.
  const unreadOutsideView = activeTab === 'read' ? 0 : unreadBeyondList
  // El botón marca TODOS los avisos del usuario, así que se queda mientras
  // quede alguno que marcar. Atarlo solo a `unreadInView` dejaba al cliente sin
  // forma de marcar los viejos cuando las 20 cargadas estaban todas leídas.
  const canMarkAll = unreadInView > 0 || unreadOutsideView > 0
  // «Todas las notificaciones leídas» es un estado de la cuenta, no de la
  // pestaña. En «Leídas» los dos contadores de arriba valen cero por
  // construcción, así que la frase salía aunque quedaran avisos sin leer
  // ([F] 2026-09-17, hallazgos del E2E).
  const nothingUnreadAtAll = unreadCount === 0 && unreadInList === 0

  if (isLoading) {
    return (
      <div
        className={cn('mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8', SCREEN_HEIGHT)}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 data-page-identity>{t('pageTitle')}</h1>
            <Skeleton className="mt-1 h-5 w-48 max-w-full" />
          </div>
          <Skeleton className="h-9 w-40 max-w-full" />
        </div>
        <div className="mt-4 mb-2 flex h-10 w-full gap-1">
          {NotificationTabSchema.literals.map((tab) => (
            <Skeleton key={tab} className="h-10 min-w-0 flex-1" />
          ))}
        </div>
        <div className="border-border-hairline divide-border-hairline divide-y border-y">
          {NotificationTabSchema.literals.map((row) => (
            <Skeleton key={row} className="my-2 h-5 w-full max-w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('mx-auto flex max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8', SCREEN_HEIGHT)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 data-page-identity>{t('pageTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {unreadInView > 0
              ? t('unread', { count: unreadInView })
              : unreadOutsideView > 0
                ? t('unreadBeyondList', { count: unreadOutsideView })
                : nothingUnreadAtAll
                  ? t('allRead')
                  : t('readTabScope')}
          </p>
        </div>
        {canMarkAll && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runClientEffect(markNotificationsAsRead(markAllAsRead))}
          >
            <CheckCheck className="mr-2 h-4 w-4" />
            {t('markAllAsRead')}
          </Button>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (isNotificationTab(v)) setActiveTab(v)
        }}
        className="mt-4 flex min-h-0 w-full flex-1 flex-col"
      >
        {/* A 363px de ancho las tres pestañas con ícono, texto y contador se
            salían del cuerpo (medido: clientWidth 346, scrollWidth 370). La
            lista toma el ancho completo, cada pestaña se queda con su tercio
            (`flex-1` + `min-w-0`, que es lo que le permite encoger) y el ícono
            espera a `sm`. El texto de las pestañas no cambia. */}
        <TabsList className="w-full">
          <TabsTrigger
            value="all"
            className="min-w-0 flex-1 gap-2 px-2 sm:px-3"
            aria-label={`${t('tabs.all')} (${notifications.length})`}
          >
            <Bell className="hidden h-4 w-4 sm:block" />
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{t('tabs.all')}</span>
              <span className="shrink-0">{`(${notifications.length})`}</span>
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="unread"
            className="min-w-0 flex-1 gap-2 px-2 sm:px-3"
            aria-label={`${t('tabs.unread')} (${unreadInList})`}
          >
            <Clock className="hidden h-4 w-4 sm:block" />
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{t('tabs.unread')}</span>
              <span className="shrink-0">{`(${unreadInList})`}</span>
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="read"
            className="min-w-0 flex-1 gap-2 px-2 sm:px-3"
            aria-label={`${t('tabs.read')} (${readInList})`}
          >
            <Check className="hidden h-4 w-4 sm:block" />
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{t('tabs.read')}</span>
              <span className="shrink-0">{`(${readInList})`}</span>
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="min-h-0 flex-1 overflow-y-auto">
          {filteredNotifications.length > 0 ? (
            <ul className="divide-border-hairline border-border-hairline divide-y border-y">
              {filteredNotifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onMarkAsRead={(...args) => void handleMarkAsRead(...args)}
                  formatTimeAgo={formatTimeAgo}
                />
              ))}
            </ul>
          ) : activeTab === 'unread' && unreadBeyondList > 0 ? null : activeTab === 'all' ? (
            <EmptyNotifications />
          ) : (
            <EmptyState
              icon={activeTab === 'unread' ? Clock : Check}
              title={activeTab === 'unread' ? t('empty.unreadTitle') : t('empty.readTitle')}
              description={t('empty.description')}
              variant="compact"
            />
          )}
          {/* Cuando la lista no muestra ninguno sin leer, ese aviso ya lo da el
              subtítulo: acá solo hace falta con avisos sin leer a la vista y
              otros más afuera. */}
          {activeTab === 'unread' && unreadBeyondList > 0 && unreadInView > 0 && (
            <p className="text-muted-foreground mt-3 text-sm">
              {t('unreadBeyondList', { count: unreadBeyondList })}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// Lo que la fila lee, y nada más: el tipo y los metadatos de la notificación
// dejaron de pintarse cuando la tarjeta se volvió fila (tarjeta O2-02).
type Notification = {
  id: Id<'notifications'>
  title: string
  message: string
  link?: string | null
  is_read: boolean
  created_at: string
}

const ROW_CLASS = 'hover:bg-muted/40 flex w-full items-start gap-3 py-2 text-left transition-colors'

const NotificationRow = memo(function NotificationRow({
  notification,
  onMarkAsRead,
  formatTimeAgo,
}: {
  notification: Notification
  onMarkAsRead: (id: Id<'notifications'>) => void
  formatTimeAgo: (date: string) => string
}) {
  const t = useTranslations('notifications')

  const handleClick = () => {
    if (!notification.is_read) {
      onMarkAsRead(notification.id)
    }
  }

  const rowInner = (
    <>
      {/* El punto ocupa su sitio también cuando la fila está leída: sin eso las
          filas leídas empiezan 14 px a la izquierda de las otras. `mt-1.5` lo
          deja a la altura de la primera línea del título. */}
      {notification.is_read ? (
        <span
          aria-hidden="true"
          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-transparent"
        />
      ) : (
        <span
          role="img"
          aria-label={t('tabs.unread')}
          className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        />
      )}
      {/* Título y mensaje no tienen tope de largo: vienen de notas del equipo,
          nombres de empresa y razones de rechazo. El título se queda en una
          línea y el mensaje se corta a dos; el texto entero viaja en `title`,
          que es lo que el cliente puede leer sin abrir nada. */}
      <span className="min-w-0 flex-1">
        <span
          title={notification.title}
          className={cn('block truncate text-sm', !notification.is_read && 'font-medium')}
        >
          {notification.title}
        </span>
        <span title={notification.message} className="text-muted-foreground line-clamp-2 text-sm">
          {notification.message}
        </span>
      </span>
      <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">
        {formatTimeAgo(notification.created_at)}
      </span>
    </>
  )

  return (
    <li>
      {notification.link ? (
        <Link href={notification.link} onClick={handleClick} className={ROW_CLASS}>
          {rowInner}
        </Link>
      ) : (
        <button type="button" onClick={handleClick} className={ROW_CLASS}>
          {rowInner}
        </button>
      )}
    </li>
  )
})
