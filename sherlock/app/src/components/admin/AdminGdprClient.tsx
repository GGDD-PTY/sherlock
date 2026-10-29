'use client'

// ============================================================================
// ADMIN GDPR CLIENT — cola de solicitudes de eliminación (Art. 17)
// ============================================================================
// La mitad de escritura (processAccountDeletion, con cascada y auditoría)
// existía sin superficie: toda solicitud quedaba PENDING para siempre. Esta
// pantalla la lista y permite procesarla con confirmación explícita — la
// eliminación es irreversible y la copia lo dice sin eufemismos.
//
// ===== LO QUE CAMBIÓ CON EFFECT =====
// La lista llegaba por un `as DeletionRequest[]`: un cast sobre filas crudas de
// Convex que declaraba una forma sin comprobarla y, de paso, pasaba la fila
// entera al árbol de React. Ahora hay una proyección explícita —la lista blanca
// de lo que la pantalla pinta— y el único campo que puede venir fuera de
// catálogo, `status`, se DECODIFICA contra `DeletionStatusSchema`: la fila que
// no encaja se descarta en vez de caer en un badge `undefined`.
//
// El procesado es un `Effect.fn` con su fallo tipado, así que el aviso dice el
// mensaje de negocio que mandó el backend en vez de un «no se pudo» para todo.
// ============================================================================

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Effect, Option, Schema } from 'effect'
import { formatDateTime } from '@/lib/utils'
import { useMutation, useQuery } from 'convex/react'
import { toast } from 'sonner'

import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import { api } from '../../../convex/_generated/api'
import type { Doc, Id } from '../../../convex/_generated/dataModel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { runClientEffect } from '@/lib/effect/client-runtime'

const DeletionStatusSchema = Schema.Literals(['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'])
type DeletionStatus = typeof DeletionStatusSchema.Type

// La lista blanca de lo que esta pantalla pinta. La fila de Convex trae además
// `profileId` y `processedBy`, que ningún render usa; la proyección los deja
// afuera en vez de pasarlos enteros al árbol de React.
type DeletionRequest = {
  _id: Id<'deletionRequests'>
  email: string
  reason?: string
  status: DeletionStatus
  requestedAt: number
  processedAt?: number
}

const decodeDeletionStatus = Schema.decodeUnknownOption(DeletionStatusSchema)

// La proyección va donde ENTRA el dato, no en cada pintada. `status` se
// decodifica contra el catálogo: una fila con un estado que esta pantalla no
// sabe pintar se descarta en vez de caer en un badge `undefined`.
function toDeletionRequests(
  rows: Array<Doc<'deletionRequests'>> | undefined
): DeletionRequest[] | undefined {
  return rows?.flatMap((row) =>
    Option.toArray(
      Option.map(decodeDeletionStatus(row.status), (status) => ({
        _id: row._id,
        email: row.email,
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        status,
        requestedAt: row.requestedAt,
        ...(row.processedAt === undefined ? {} : { processedAt: row.processedAt }),
      }))
    )
  )
}

const STATUS_BADGES: Record<DeletionStatus, string> = {
  PENDING: 'bg-warning/10 text-warning',
  PROCESSING: 'bg-accent/10 text-accent',
  COMPLETED: 'bg-success/10 text-success',
  CANCELLED: 'bg-muted text-muted-foreground',
}

/**
 * Procesar es irreversible y la cascada vive en el backend. Acá el paso tiene
 * nombre para que el aviso pueda decir cuál falló.
 */
const processDeletion = Effect.fn('AdminGdpr.processDeletion')(function* (
  run: (args: { requestId: Id<'deletionRequests'> }) => Promise<unknown>,
  requestId: Id<'deletionRequests'>,
  fallback: string
): Effect.fn.Return<void, AdminActionError> {
  yield* adminStep('AdminGdpr.processDeletion', 'gdpr.processAccountDeletion', fallback, () =>
    run({ requestId })
  )
})

export function AdminGdprClient() {
  const locale = useLocale()
  const t = useTranslations('admin.gdpr')
  // Dos consultas, no una. `listDeletionRequests` devuelve las 200 más
  // recientes: la cola operable cabe ahí, pero una pendiente vieja se cae de esa
  // ventana en cuanto entran 200 solicitudes nuevas, y separar por estado en el
  // cliente la desaparecía justo de la lista que hay que atender (Art. 17). Las
  // pendientes se piden por el filtro `status`, que va por el índice
  // `by_status`; el historial sigue siendo lo reciente. Sin paginación.
  const rawPending = useQuery(api.gdpr.listDeletionRequests, { status: 'PENDING' })
  const rawRecent = useQuery(api.gdpr.listDeletionRequests, {})
  const processAccountDeletion = useMutation(api.gdpr.processAccountDeletion)
  const [confirmingId, setConfirmingId] = useState<Id<'deletionRequests'> | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  const pendingRequests = toDeletionRequests(rawPending)
  const recentRequests = toDeletionRequests(rawRecent)

  const handleProcess = () => {
    if (!confirmingId) return
    setIsProcessing(true)

    void runClientEffect(
      processDeletion(processAccountDeletion, confirmingId, t('toasts.error')).pipe(
        Effect.tap(() => Effect.sync(() => toast.success(t('toasts.success')))),
        Effect.catch((error) =>
          Effect.logError(`[AdminGdprClient] ${error.action} falló en ${error.step}`).pipe(
            Effect.andThen(Effect.sync(() => toast.error(error.message)))
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setIsProcessing(false)
            setConfirmingId(null)
          })
        )
      )
    )
  }

  if (pendingRequests === undefined || recentRequests === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const pending = pendingRequests
  const history = recentRequests.filter((request) => request.status !== 'PENDING')

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {pending.length > 0 ? t('pendingCount', { count: pending.length }) : t('pending')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('emptyPending')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {pending.map((request) => (
                <li
                  key={request._id}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{request.email}</p>
                    <p className="text-muted-foreground text-sm">
                      {t('requestedAt', {
                        date: formatDateTime(request.requestedAt, locale, '-'),
                      })}
                      {request.reason ? ` · ${t('reason', { reason: request.reason })}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmingId(request._id)}
                  >
                    {t('process')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('history')}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('emptyHistory')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {history.map((request) => (
                <li
                  key={request._id}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{request.email}</p>
                    <p className="text-muted-foreground">
                      {t('requestedAt', {
                        date: formatDateTime(request.requestedAt, locale, '-'),
                      })}
                      {request.processedAt
                        ? ` · ${t('processedAt', {
                            date: formatDateTime(request.processedAt, locale, '-'),
                          })}`
                        : ''}
                    </p>
                  </div>
                  <Badge className={STATUS_BADGES[request.status]}>
                    {t(`statuses.${request.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmingId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('dialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>{t('dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleProcess} disabled={isProcessing}>
              {isProcessing ? t('dialog.processing') : t('dialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
