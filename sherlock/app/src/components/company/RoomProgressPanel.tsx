'use client'

// ============================================================================
// PREPARACIÓN DE LA SALA — barra, faltantes y entregables con estado
// ============================================================================
// Sustituye a TeamDeliveryPanel. Lee getCompanyChecklist (ítems + sello +
// etapas ya colapsadas, v1/v2 y Decks incluidos) y listForCompany (renditions
// para enlazar un entregable ya entregado a la sala). Las PENDING no ocupan
// fila: el dueño tiene que ver qué está vivo. Activar la sala es una decisión
// humana: el sello solo aparece si el checklist lo trae.

import { useId, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useLocale, useTranslations } from 'next-intl'
import { Exit } from 'effect'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { ConvexLoadFailure } from './vdr/ConvexLoadFailure'
import { useConvexLoadTimeout } from './vdr/useConvexLoadTimeout'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { runClientEffectExit, runClientSyncExit } from '@/lib/effect/client-runtime'
import { PANAMA_TIME_ZONE } from '@/lib/utils'
import {
  CHECKLIST_ITEM_KEYS,
  CHECKLIST_TOTAL,
  CLIENT_ITEM_KEYS,
  STAGE_ORDER,
  type ChecklistItemKey,
  type ChecklistStageKey,
} from '@/lib/vdr/room-progress'
import { Link } from '@/i18n/navigation'
import { ROOM_SCREEN_PATH } from './roomScreens'
import { normalizeSubmittedPhone, saveContactPhone } from './contactPhone'

// Los destinos son pantallas de la sala (docs/design-system-vdr.md), no anclas.
// `Link` de i18n antepone el locale, así que los hrefs van sin `/es`.
const SUPPORT_HREF: string = ROOM_SCREEN_PATH.team
const ROOM_SHELL_HREF: string = ROOM_SCREEN_PATH.documents
const UPCOMING_STAGES_FORMAT = new Intl.ListFormat('es-PA', { type: 'conjunction' })

// ===== LA COSTURA CON EFFECT =====
// Este panel lee dos queries de Convex y las casteaba: `as ChecklistView` y
// `as DeliverableRow[]`. El casteo apagaba al compilador justo donde importaba
// —los tipos locales eran una segunda copia, escrita a mano, de lo que devuelve
// el backend— y un campo renombrado del lado del servidor habría pintado
// `undefined` sin un solo error. Los dos casteos se fueron: los tipos generados
// ya calzaban, así que ahora el compilador ata el panel al backend de verdad.

type ChecklistStageStatus =
  | 'PENDING'
  | 'REQUESTED'
  | 'IN_PROGRESS'
  | 'NEEDS_INPUT'
  | 'DRAFT_READY'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'DELIVERED'
type ClientStageTone = 'future' | 'pending' | 'needsInput' | 'inPrep' | 'delivered'
type ItemActionKey = 'confirmName' | 'addPhone' | 'upload' | 'writeTeam'

type ChecklistItemView = { done: boolean; at: number | null }

type ChecklistView = {
  items: Record<ChecklistItemKey, ChecklistItemView>
  completedCount: number
  activation: { active: boolean; at: number | null }
  stages: Array<{
    key: ChecklistStageKey
    status: ChecklistStageStatus
    updatedAt: number | null
  }>
}

type DeliverableRow = {
  kind: string
  status: string
  renditions?: readonly {
    documentId: Id<'documents'>
    versionId?: Id<'documentVersions'>
  }[]
  deliveryNote?: string | null
}

const ITEM_HREF: Record<Exclude<ChecklistItemKey, 'phone'>, string> = {
  nameConfirmed: ROOM_SHELL_HREF,
  financials: ROOM_SHELL_HREF,
  legal: ROOM_SHELL_HREF,
  corporate: ROOM_SHELL_HREF,
  financialsDepth: SUPPORT_HREF,
  kickoffCall: SUPPORT_HREF,
}

const ITEM_ACTION: Record<ChecklistItemKey, ItemActionKey> = {
  nameConfirmed: 'confirmName',
  phone: 'addPhone',
  financials: 'upload',
  legal: 'upload',
  corporate: 'upload',
  financialsDepth: 'writeTeam',
  kickoffCall: 'writeTeam',
}

function clientStageTone(status: ChecklistStageStatus): ClientStageTone {
  if (status === 'PENDING') return 'future'
  if (status === 'REQUESTED') return 'pending'
  if (status === 'NEEDS_INPUT') return 'needsInput'
  if (status === 'DELIVERED') return 'delivered'
  return 'inPrep'
}

function clientStatusKey(
  tone: ClientStageTone
): 'PENDING' | 'REQUESTED' | 'NEEDS_INPUT' | 'IN_PREP' | 'DELIVERED' {
  if (tone === 'future') return 'PENDING'
  if (tone === 'pending') return 'REQUESTED'
  if (tone === 'needsInput') return 'NEEDS_INPUT'
  if (tone === 'delivered') return 'DELIVERED'
  return 'IN_PREP'
}

// Igual que el panel admin: el día es el de Panamá, fijo para servidor y
// navegador.
function formatShortDate(at: number, _locale: string): string {
  return new Intl.DateTimeFormat('es-PA', {
    day: 'numeric',
    month: 'short',
    timeZone: PANAMA_TIME_ZONE,
  }).format(new Date(at))
}

// La sala demo de dev-auth no tiene fila en Convex y su `companyId` no es un id
// real: la query se salta y el bloque se dibuja en cero, igual que una empresa
// recién dada de alta. Mismo patrón que `useCompanyVdr` con los documentos.
const EMPTY_CHECKLIST: ChecklistView = {
  items: Object.fromEntries(
    CHECKLIST_ITEM_KEYS.map((key) => [key, { done: false, at: null }])
  ) as ChecklistView['items'],
  completedCount: 0,
  activation: { active: false, at: null },
  stages: [],
}

function stagesOrDefault(stages: ChecklistView['stages'] | undefined) {
  const byKey = new Map((stages ?? []).map((stage) => [stage.key, stage]))
  return STAGE_ORDER.map(
    (key) => byKey.get(key) ?? { key, status: 'PENDING' as const, updatedAt: null }
  )
}

function stageDeliverableKinds(key: ChecklistStageKey): readonly string[] {
  if (key === 'MODEL_V1' || key === 'MODEL_V2') return ['MODEL']
  if (key === 'DECKS') return ['DEBT_DECK', 'EQUITY_DECK']
  return [key]
}

function appendSourceQuery(href: string, source: string): string {
  const hashAt = href.indexOf('#')
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const joiner = path.includes('?') ? '&' : '?'
  return `${path}${joiner}source=${source}${hash}`
}

function deliveredHref(
  key: ChecklistStageKey,
  deliverables: DeliverableRow[] | undefined,
  documentsHref: string
): string | null {
  if (!deliverables) return null
  const kinds = stageDeliverableKinds(key)
  const row = deliverables.find(
    (candidate) =>
      kinds.includes(candidate.kind) &&
      candidate.status === 'DELIVERED' &&
      (candidate.renditions?.length ?? 0) > 0
  )
  const rendition = row?.renditions?.[0]
  if (!rendition) return null
  const source = rendition.versionId
    ? `${rendition.documentId}:${rendition.versionId}`
    : rendition.documentId
  return appendSourceQuery(documentsHref, source)
}

// La nota del equipo viaja en la versión que el slot cita (`listForCompany` la
// resuelve): se lee bajo la etapa entregada, sin abrir la sala. Modelo v1 y v2
// comparten el slot MODEL, así que llevan la nota de la entrega vigente.
function deliveredNote(
  key: ChecklistStageKey,
  deliverables: DeliverableRow[] | undefined
): string | null {
  if (!deliverables) return null
  const kinds = stageDeliverableKinds(key)
  const row = deliverables.find(
    (candidate) =>
      kinds.includes(candidate.kind) &&
      candidate.status === 'DELIVERED' &&
      Boolean(candidate.deliveryNote)
  )
  return row?.deliveryNote ?? null
}

function ContactPhoneForm({
  companyId,
  formId,
  onCancel,
  onSaved,
}: {
  companyId: Id<'companies'>
  formId: string
  onCancel: () => void
  onSaved: () => void
}) {
  const t = useTranslations('roomProgress.phoneForm')
  const inputId = useId()
  const savePhone = useMutation(api.companies.updateContactPhone)
  const [phone, setPhone] = useState('')
  const [state, setState] = useState<'idle' | 'pending' | 'invalid' | 'error'>('idle')
  const error = state === 'invalid' ? t('invalid') : state === 'error' ? t('error') : null
  const pending = state === 'pending'

  return (
    <form
      id={formId}
      className="space-y-3"
      aria-busy={pending}
      onSubmit={(event) =>
        void (async () => {
          event.preventDefault()
          if (pending) return

          const normalized = runClientSyncExit(normalizeSubmittedPhone(phone))
          if (!Exit.isSuccess(normalized)) {
            setState('invalid')
            return
          }

          setState('pending')
          const exit = await runClientEffectExit(
            saveContactPhone(savePhone, { companyId, phone: normalized.value })
          )
          if (Exit.isSuccess(exit)) {
            onSaved()
            return
          }
          setState('error')
        })()
      }
    >
      <Label htmlFor={inputId}>{t('label')}</Label>
      <p id={`${inputId}-hint`} className="text-muted-foreground text-sm">
        {t('hint')}
      </p>
      <Input
        id={inputId}
        type="tel"
        autoComplete="tel"
        maxLength={50}
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        disabled={pending}
        aria-invalid={Boolean(error)}
        aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ''}`}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

export function RoomProgressPanel(props: {
  companyId: Id<'companies'>
  className?: string
  isDemo?: boolean
  contactHref?: string
  supportHref?: string
  /** Destino de «Subir» y «Renombrar»; el equipo, desde /admin, apunta a su propia sala. */
  documentsHref?: string
  /** `companies.updateContactPhone` solo admite al dueño: el equipo no edita el teléfono aquí. */
  phoneEditable?: boolean
}) {
  const [attempt, setAttempt] = useState(0)
  return (
    <RoomProgressPanelLive
      key={`${props.companyId}:${attempt}`}
      {...props}
      onRetry={() => {
        setAttempt((current) => current + 1)
      }}
    />
  )
}

function RoomProgressPanelLive({
  companyId,
  className,
  isDemo = false,
  contactHref,
  supportHref = SUPPORT_HREF,
  documentsHref = ROOM_SHELL_HREF,
  phoneEditable = true,
  onRetry,
}: {
  companyId: Id<'companies'>
  className?: string
  isDemo?: boolean
  contactHref?: string
  supportHref?: string
  documentsHref?: string
  phoneEditable?: boolean
  onRetry: () => void
}) {
  const t = useTranslations('roomProgress')
  const vdr = useTranslations('vdr')
  const locale = useLocale()
  const phoneFormId = useId()
  const [phoneForm, setPhoneForm] = useState<'closed' | 'editing' | 'saved'>('closed')
  const loaded = useQuery(api.companyChecklist.getCompanyChecklist, isDemo ? 'skip' : { companyId })
  const deliverables = useQuery(api.deliverables.listForCompany, isDemo ? 'skip' : { companyId })
  const checklist = isDemo ? EMPTY_CHECKLIST : loaded
  const loadTimeout = useConvexLoadTimeout(
    !isDemo && (loaded === undefined || deliverables === undefined),
    12_000,
    companyId
  )

  if (loadTimeout.timedOut) {
    return (
      <section className={className} data-testid="room-progress-panel">
        <ConvexLoadFailure
          message={vdr('loadFailed')}
          onRetry={onRetry}
          testId="room-progress-load-failure"
        />
      </section>
    )
  }

  if (checklist === undefined || (!isDemo && deliverables === undefined)) {
    return (
      <section
        className={className}
        data-testid="room-progress-panel"
        aria-busy="true"
        aria-label={t('loading')}
      >
        <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
        <Skeleton className="mt-4 h-9 w-40 motion-reduce:animate-none" />
        <Skeleton className="mt-4 h-1.5 w-full motion-reduce:animate-none" />
        <Skeleton className="mt-8 h-24 w-full motion-reduce:animate-none" />
      </section>
    )
  }

  const missingKeys = CLIENT_ITEM_KEYS.filter((key) => !checklist.items[key]?.done)
  const completedKeys = CLIENT_ITEM_KEYS.filter((key) => checklist.items[key]?.done)
  const ready = completedKeys.length
  const stages = stagesOrDefault(checklist.stages)
  // Una PENDING no es fila: el dueño tiene que ver qué está vivo
  // (docs/design-system-vdr.md, «Estático y dinámico se ven distintos»).
  const liveStages = stages.filter((stage) => stage.status !== 'PENDING')
  const modelV2Delivered = liveStages.some(
    (stage) => stage.key === 'MODEL_V2' && clientStageTone(stage.status) === 'delivered'
  )
  const pendingStages = stages.filter((stage) => stage.status === 'PENDING')
  const seal =
    checklist.activation.active && checklist.activation.at
      ? t('activated', { date: formatShortDate(checklist.activation.at, locale) })
      : null

  // Un título Fraunces por pantalla; «Te falta» y «Entregables» son subtítulos.
  // El ocre lo lleva la barra; las cifras van en navy/crema.
  return (
    <section
      className={className}
      data-testid="room-progress-panel"
      aria-labelledby="room-progress-heading"
    >
      <Collapsible>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h2 id="room-progress-heading">{t('title')}</h2>
          <CollapsibleTrigger className="font-display text-foreground focus-visible:ring-ring rounded-sm text-4xl leading-none tracking-tight decoration-1 underline-offset-8 outline-none hover:underline focus-visible:ring-2">
            {t('readyCount', { ready, total: CHECKLIST_TOTAL })}
          </CollapsibleTrigger>
          {seal ? (
            <p
              data-testid="room-progress-seal"
              className="text-muted-foreground font-figure text-xs sm:ml-auto"
            >
              {seal}
            </p>
          ) : null}
        </div>
        <Progress
          value={Math.round((ready / CHECKLIST_TOTAL) * 100)}
          aria-label={t('readyCount', { ready, total: CHECKLIST_TOTAL })}
          className="[&>div]:bg-highlight mt-4 h-1.5"
        />
        {completedKeys.length > 0 ? (
          <CollapsibleContent>
            <ul className="text-muted-foreground mt-3 space-y-1 text-sm">
              {completedKeys.map((key) => (
                <li key={key}>{t(`items.${key}`)}</li>
              ))}
            </ul>
          </CollapsibleContent>
        ) : null}
      </Collapsible>

      {missingKeys.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">{t('missingTitle')}</h3>
          <ul data-testid="room-progress-missing" className="divide-border mt-2 divide-y">
            {missingKeys.map((key) => (
              <li key={key} className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm">{t(`items.${key}`)}</span>
                {key === 'phone' && contactHref ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={contactHref}>{t('actions.addPhone')}</Link>
                  </Button>
                ) : key === 'phone' && !phoneEditable ? null : key === 'phone' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isDemo}
                    title={isDemo ? t('phoneForm.demo') : undefined}
                    aria-controls={phoneFormId}
                    aria-expanded={phoneForm === 'editing'}
                    onClick={() => setPhoneForm('editing')}
                  >
                    {t('actions.addPhone')}
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href={ITEM_HREF[key] === SUPPORT_HREF ? supportHref : documentsHref}>
                      {t(
                        `actions.${ITEM_ACTION[key] === 'writeTeam' && supportHref !== SUPPORT_HREF ? 'openSupport' : ITEM_ACTION[key]}`
                      )}
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!contactHref && phoneForm === 'editing' && !isDemo && !checklist.items.phone.done ? (
        <div className="mt-4 max-w-md">
          <ContactPhoneForm
            companyId={companyId}
            formId={phoneFormId}
            onCancel={() => setPhoneForm('closed')}
            onSaved={() => setPhoneForm('saved')}
          />
        </div>
      ) : null}
      <p role="status" className="text-muted-foreground mt-2 text-sm">
        {phoneForm === 'saved' ? t('phoneForm.saved') : ''}
      </p>
      <p data-testid="room-progress-kickoff" className="text-muted-foreground mt-3 text-sm">
        {t('kickoffQuestion')}{' '}
        <Link href={supportHref} className="text-primary font-medium underline underline-offset-4">
          {t('kickoffLink')}
        </Link>{' '}
        {t('kickoffTail')}
      </p>

      <div className="mt-6">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 id="company-deliverables-heading" className="text-sm font-semibold">
            {t('stagesTitle')}
          </h3>
          <p className="text-muted-foreground text-sm">{t('stagesDescription')}</p>
        </div>
        {liveStages.length > 0 ? (
          <ol
            data-testid="room-progress-stages"
            aria-labelledby="company-deliverables-heading"
            className="divide-border mt-3 divide-y"
          >
            {liveStages.map((stage) => {
              const tone = clientStageTone(stage.status)
              const statusKey = clientStatusKey(tone)
              // v1 y v2 comparten el slot MODEL, que solo cita la entrega
              // vigente. Con v2 entregado, el enlace y la nota de v1 llevaban al
              // archivo de v2: v1 se queda como hito, sin enlace ni nota ajena.
              const superseded = stage.key === 'MODEL_V1' && modelV2Delivered
              const href =
                tone === 'needsInput'
                  ? supportHref
                  : tone === 'delivered' && !superseded
                    ? deliveredHref(stage.key, deliverables, documentsHref)
                    : null
              const statusLabel = t(`status.${statusKey}`)
              const note =
                tone === 'delivered' && !superseded ? deliveredNote(stage.key, deliverables) : null
              const statusNode =
                href !== null ? (
                  <Link href={href} className="text-xs font-medium underline underline-offset-4">
                    {statusLabel}
                  </Link>
                ) : statusLabel ? (
                  <span className="text-xs">{statusLabel}</span>
                ) : null

              return (
                <li
                  key={stage.key}
                  data-testid={`room-progress-stage-${stage.key}`}
                  data-tone={tone}
                  className="min-w-0 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <p className="text-sm font-medium">{t(`stages.${stage.key}`)}</p>
                    <p className="flex items-baseline gap-2">
                      {statusNode}
                      {stage.updatedAt ? (
                        <span className="text-muted-foreground font-figure text-xs">
                          · {formatShortDate(stage.updatedAt, locale)}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {note ? (
                    <details className="mt-1">
                      <summary className="text-muted-foreground cursor-pointer text-xs underline-offset-4 hover:underline">
                        {t('showNote')}
                      </summary>
                      <p
                        data-testid={`room-progress-note-${stage.key}`}
                        className="text-muted-foreground mt-1 text-sm leading-6 [overflow-wrap:anywhere]"
                      >
                        {note}
                      </p>
                    </details>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : null}
        {pendingStages.length > 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            {t('stagesUpcoming', {
              stages: UPCOMING_STAGES_FORMAT.format(
                pendingStages.map((stage) => t(`stages.${stage.key}`))
              ),
            })}
          </p>
        ) : null}
      </div>
    </section>
  )
}
