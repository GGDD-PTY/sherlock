'use client'

import { useState } from 'react'
import { Effect, Schema } from 'effect'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { markNotificationsAsRead } from '@/components/notifications/mark-as-read'
import { useNotifications } from '@/hooks/useNotifications'
import { safeRedirect } from '@/lib/utils/safe-redirect'
import { formatNotificationTimeAgo } from '@/components/notifications/format-time-ago'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Id } from '../../../convex/_generated/dataModel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Bell,
  BellRing,
  CheckCheck,
  MessageSquare,
  FileText,
  TrendingUp,
  Settings,
  ExternalLink,
  Loader2,
  Gavel,
  Filter,
  Newspaper,
  PieChart,
} from 'lucide-react'
import { NotificationTypeSchema, type NotificationType } from '@/lib/notifications'
import { cn } from '@/lib/utils'
import { runClientEffect } from '@/lib/effect/client-runtime'

const isNotificationType = Schema.is(NotificationTypeSchema)

const TYPE_ICONS: Record<NotificationType, React.ReactNode> = {
  new_message: <MessageSquare className="text-accent h-4 w-4" />,
  nda_signed: <FileText className="text-success h-4 w-4" />,
  document_shared: <FileText className="text-primary h-4 w-4" />,
  analysis_complete: <TrendingUp className="text-accent h-4 w-4" />,
  subscription_update: <Settings className="text-muted-foreground h-4 w-4" />,
  council_completed: <Gavel className="text-secondary-foreground h-4 w-4" />,
  screening_complete: <Filter className="text-primary h-4 w-4" />,
  news_alert_triggered: <Newspaper className="text-primary h-4 w-4" />,
  portfolio_alert: <PieChart className="text-success h-4 w-4" />,
  system: <Bell className="text-muted-foreground h-4 w-4" />,
}

function notificationIcon(type: unknown) {
  return isNotificationType(type) ? TYPE_ICONS[type] : <Bell className="h-4 w-4" />
}

const clickNotification = Effect.fn('NotificationBell.click')(function* (
  mark: () => Promise<unknown>,
  close: () => void,
  link: string | undefined
) {
  // Si marcar falla, el clic igual tiene que cerrar el panel y navegar:
  // `markNotificationsAsRead` registra el rechazo e ignora, y el programa sigue.
  yield* markNotificationsAsRead(mark)
  yield* Effect.sync(close)
  if (link) {
    yield* Effect.sync(() => safeRedirect(link, '/notifications'))
  }
})

export function NotificationBell({ showLabel = false }: { readonly showLabel?: boolean } = {}) {
  const locale = useLocale()
  const t = useTranslations('notifications.bell')
  const tTime = useTranslations('notifications')
  const { notifications, unreadCount, isLoading, markAsRead, markAllAsRead } = useNotifications()

  const [isOpen, setIsOpen] = useState(false)

  const recentNotifications = notifications.slice(0, 10)

  const handleNotificationClick = (notificationId: Id<'notifications'>, link?: string) => {
    void runClientEffect(
      clickNotification(
        () => markAsRead(notificationId),
        () => setIsOpen(false),
        link
      )
    )
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={showLabel ? 'sm' : 'icon'}
          className="relative"
          aria-label={unreadCount > 0 ? t('ariaLabelUnread', { count: unreadCount }) : t('title')}
        >
          {unreadCount > 0 ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
          {showLabel && <span className="hidden xl:inline">{t('title')}</span>}

          {unreadCount > 0 && (
            // Dos arreglos de la tarjeta O2-02: `w-5` fijo recortaba el número
            // en cuanto pasaba de un dígito (con `min-w-5` la píldora crece
            // hasta los tres caracteres de «99+» y ahí se queda), y con
            // etiqueta al lado la píldora flotante caía encima de las últimas
            // letras de «Notificaciones». Con etiqueta va en el flujo, detrás
            // del texto; sin etiqueta sigue pegada a la esquina del ícono.
            <Badge
              variant="destructive"
              className={cn(
                'flex h-5 min-w-5 items-center justify-center px-1 text-xs tabular-nums',
                !showLabel && 'absolute -top-1 -right-1'
              )}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h4 className="font-semibold">{t('title')}</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto py-1 text-xs"
              onClick={() => void runClientEffect(markNotificationsAsRead(markAllAsRead))}
            >
              <CheckCheck className="mr-1 h-3 w-3" />
              {t('markAll')}
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : recentNotifications.length === 0 ? (
            <div className="py-8 text-center">
              <Bell className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
            </div>
          ) : (
            <div className="divide-y">
              {recentNotifications.map((notification) => (
                <button
                  key={notification.id}
                  className={`hover:bg-muted/50 flex w-full items-start gap-3 p-4 text-left transition-colors ${
                    !notification.is_read ? 'bg-primary/5' : ''
                  }`}
                  onClick={() => handleNotificationClick(notification.id, notification.link)}
                >
                  {/* Icono */}
                  <div className="mt-0.5 flex-shrink-0">{notificationIcon(notification.type)}</div>

                  {/* Contenido */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm ${!notification.is_read ? 'font-medium' : ''}`}>
                        {notification.title}
                      </p>
                      {!notification.is_read && (
                        <div className="bg-primary mt-1.5 h-2 w-2 flex-shrink-0 rounded-full" />
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                      {notification.message}
                    </p>
                    <p className="text-muted-foreground/70 mt-1 text-xs">
                      {formatNotificationTimeAgo(notification.created_at, locale, tTime)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {notifications.length > 0 && (
          <div className="border-t p-2">
            <Button asChild variant="ghost" size="sm" className="w-full">
              <Link href="/notifications" onClick={() => setIsOpen(false)}>
                {t('viewAll')}
                <ExternalLink className="ml-2 h-3 w-3" />
              </Link>
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
