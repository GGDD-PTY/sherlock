'use client'

// ============================================================================
// ACTIVACIÓN DE LA SALA — el bloque del equipo ([F] 2026-09-01)
// ============================================================================
// Activar = el equipo puede empezar a trabajar sin volver a pedirle nada al
// cliente. La declara una persona, no una regla: el checklist sugiere y el
// botón no exige el 100% (respuesta 3 de la spec). Los cinco ítems derivados
// se muestran en crudo, con su conteo por carpeta; los dos manuales llevan su
// casilla. Los entregables siguen viviendo en AdminPreparationWorkspace: acá
// no se repiten.

// ===== LO QUE CAMBIÓ CON EFFECT =====
// La lista de las siete casillas vive en `companyChecklistItems`, una sola vez
// para este panel y para `AdminRoomSections`.
//
// La lectura del checklist llegaba por `as ChecklistView`: un cast sobre lo que
// Convex ya devuelve tipado, que además declaraba una forma más pobre que la
// real. Se fue el cast.
//
// `run(action)` tenía un `catch {}` mudo que solo prendía una bandera: toda
// falla se veía igual. Ahora el fallo lleva nombre y el panel dice el mensaje
// que redactó el backend.

import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { Effect } from 'effect'
import { useTranslations } from 'next-intl'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import {
  CHECKLIST_ITEM_KEYS,
  isManualChecklistItem,
} from '@/components/admin/companyChecklistItems'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { PANAMA_TIME_ZONE } from '@/lib/utils'

const NOTE_INPUT_ID = 'admin-room-activation-note'

// El día que se pinta es el de Panamá, no el del navegador de quien mira: sin
// la zona fija, una activación de las 20:00 en Panamá se leía del día siguiente.
function formatShortDate(at: number): string {
  return new Intl.DateTimeFormat('es-PA', {
    day: 'numeric',
    month: 'short',
    timeZone: PANAMA_TIME_ZONE,
  }).format(new Date(at))
}

export function AdminRoomActivationPanel({
  companyId,
  className,
  isDemo = false,
}: {
  companyId: Id<'companies'>
  className?: string
  isDemo?: boolean
}) {
  const t = useTranslations('adminRoomActivation')
  const checklist = useQuery(
    api.companyChecklist.getCompanyChecklist,
    isDemo ? 'skip' : { companyId }
  )
  const setChecklistItem = useMutation(api.companyChecklist.setChecklistItem)
  const setActivation = useMutation(api.companyChecklist.setActivation)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  function run(step: string, action: () => PromiseLike<unknown>) {
    setBusy(true)
    setFailure(null)
    void runClientEffect(
      adminStep('AdminRoomActivation.write', step, t('error'), action).pipe(
        Effect.catch((error: AdminActionError) =>
          Effect.logError(`[AdminRoomActivationPanel] ${error.action} falló en ${error.step}`).pipe(
            Effect.andThen(Effect.sync(() => setFailure(error.message)))
          )
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false)))
      )
    )
  }

  if (isDemo) return null

  if (checklist === undefined) {
    return (
      <section className={className} aria-busy="true" aria-label={t('loading')}>
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      </section>
    )
  }

  const activation = checklist.activation
  const trimmedNote = note.trim()

  return (
    <section className={className} data-testid="admin-room-activation">
      <Card>
        <CardHeader className="pb-2">
          {/* Una sola voz para el acceso (auditoría 2026-09-06, F07): la sala
              está activada o sin activar, y una línea dice qué significa
              para el equipo (no hay gate: el cliente sube y habla desde el
              minuto cero). El avance del checklist se lee en el resumen de
              la sección de preparación, no acá. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('title')}</h2>
            <div className="text-sm sm:text-right">
              <p data-testid="admin-activation-state" className="font-medium">
                {activation.active ? t('available') : t('notActivated')}
                {activation.active && activation.at ? (
                  <span className="text-muted-foreground font-data ml-2 text-xs font-normal">
                    {formatShortDate(activation.at)}
                  </span>
                ) : null}
              </p>
              <p className="text-muted-foreground">
                {activation.active ? t('availableHint') : t('notActivatedHint')}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {activation.active ? null : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1 space-y-1">
                <Label htmlFor={NOTE_INPUT_ID}>{t('noteLabel')}</Label>
                <Input
                  id={NOTE_INPUT_ID}
                  value={note}
                  placeholder={t('notePlaceholder')}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run('companyChecklist.setActivation', () =>
                    setActivation({
                      companyId,
                      active: true,
                      ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
                    })
                  )
                }
              >
                {t('activate')}
              </Button>
            </div>
          )}

          <ul data-testid="admin-checklist-items" className="space-y-2">
            {CHECKLIST_ITEM_KEYS.map((key) => {
              const item = checklist.items[key]
              const label =
                typeof item.count === 'number'
                  ? `${t(`items.${key}`)} (${item.count})`
                  : t(`items.${key}`)

              return (
                <li
                  key={key}
                  data-testid={`admin-checklist-item-${key}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-muted-foreground w-20 shrink-0 text-xs uppercase">
                      {item.done ? t('done') : t('pending')}
                    </span>
                    <span>{label}</span>
                    {isManualChecklistItem(key) ? (
                      <span className="text-muted-foreground text-xs">{t('teamOnly')}</span>
                    ) : null}
                    {item.at ? (
                      <span className="text-muted-foreground text-xs">
                        {formatShortDate(item.at)}
                      </span>
                    ) : null}
                  </span>
                  {isManualChecklistItem(key) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        run('companyChecklist.setChecklistItem', () =>
                          setChecklistItem({ companyId, item: key, done: !item.done })
                        )
                      }
                    >
                      {item.done ? t('unmark') : t('mark')}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {failure ? (
            <p role="alert" className="text-destructive text-sm">
              {failure}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}
