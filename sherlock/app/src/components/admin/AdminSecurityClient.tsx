'use client'

// ============================================================================
// ADMIN SECURITY CLIENT COMPONENT
// ============================================================================
// Dashboard for viewing and managing security events
// Shows severity badges, filters, and resolution capability
//
// ===== EL VOCABULARIO SE LEE, NO SE COPIA =====
// Los once tipos de evento y las cuatro severidades estaban escritos otra vez
// acá, a mano, junto a los que ya vivían en `convex/security.ts`. Coincidían
// por costumbre: un tipo nuevo en el backend entraba a la base y esta pantalla
// lo pintaba como texto crudo sin filtro ni etiqueta, y nada se ponía rojo.
// Ahora el catálogo se importa de donde se define —los mismos `Schema.Literals`
// que construyen los validadores de Convex— así que hay una sola lista.
//
// El import va a `convex/_security/shared`, el módulo puro, y no a
// `convex/security`: ese registra `query` y `mutation`, así que arrastra
// `convex/_generated/server` al bundle del cliente y Next abría esta ruta con
// el overlay y «Convex functions should not be imported in the browser»
// (tarjeta OB-RES-3). Cruzar `convex/` → `src/` sigue siendo barato mientras
// el módulo del otro lado no registre funciones, como
// `convex/_roadmap/registry` o `convex/_adminVdr/capabilityFormat`.
// ============================================================================

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useQuery, useMutation } from 'convex/react'
import { Effect, Schema } from 'effect'
import { api } from '@/../convex/_generated/api'
import { Id } from '@/../convex/_generated/dataModel'
import {
  SecurityEventTypeSchema,
  SecuritySeveritySchema,
  type SecurityEventType,
  type SecuritySeverity,
} from '@/../convex/_security/shared'
import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { cn, formatShortRelativeTime } from '@/lib/utils'
import {
  getClassificationBadgeClassName,
  type DocumentClassification,
} from '@/lib/documents/classification'
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Info,
  Clock,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { runClientEffect } from '@/lib/effect/client-runtime'

// ===== TIPOS =====
type SecurityTranslator = ReturnType<typeof useTranslations>

type SecurityEvent = {
  _id: Id<'securityEvents'>
  _creationTime: number
  type: string
  severity: SecuritySeverity
  userId?: Id<'users'>
  userEmail?: string
  ipAddress?: string
  userAgent?: string
  details?: Record<string, unknown>
  resolved: boolean
  resolvedByProfileId?: Id<'profiles'>
  resolvedAt?: number
  resolutionNotes?: string
}

type DocumentReviewItem = {
  _id: Id<'documents'>
  _creationTime: number
  name: string
  accessLevel?: 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'
  classification?: DocumentClassification
  company?: { _id: Id<'companies'>; name: string } | null
  latestReviewLog?: {
    accessedAt?: number
    outcome?: string
    reason?: string
  } | null
}

type SecurityEventCounts = {
  total: number
  critical: number
  alert: number
  warning: number
  info: number
}

// ===== SEVERITY CONFIG =====
// `Record<SecuritySeverity, ...>` y no `Record<string, ...>`: una severidad
// nueva en `convex/security.ts` deja de compilar acá en vez de llegar a
// `config.bgColor` como `undefined` en medio de un render.
const severityConfig: Record<
  SecuritySeverity,
  { icon: React.ReactNode; color: string; bgColor: string }
> = {
  INFO: {
    icon: <Info className="h-4 w-4" />,
    color: 'text-info',
    bgColor: 'bg-info/10',
  },
  WARNING: {
    icon: <AlertTriangle className="h-4 w-4" />,
    color: 'text-warning',
    bgColor: 'bg-warning/10',
  },
  ALERT: {
    icon: <ShieldAlert className="h-4 w-4" />,
    color: 'text-warning',
    bgColor: 'bg-warning/10',
  },
  CRITICAL: {
    icon: <XCircle className="h-4 w-4" />,
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
  },
}

// ===== EVENT TYPE LABELS =====
// La lista es la del backend, no una copia. `.literals` la devuelve tal cual
// para llenar el filtro.
const EVENT_TYPES = SecurityEventTypeSchema.literals
const isKnownEventType = Schema.decodeUnknownOption(SecurityEventTypeSchema)
const decodeSeverity = Schema.decodeUnknownOption(SecuritySeveritySchema)

/**
 * El sello de tiempo de una fila, o «ahora» si la fila no lo trae. Vive fuera
 * del componente porque `Date.now()` en el cuerpo del render es impuro: dos
 * pintadas del mismo estado darían dos valores.
 */
function reviewedAt(timestamp: number | undefined): number {
  return timestamp || Date.now()
}

/** `'ALL'` y cualquier basura son lo mismo: sin filtro de severidad. */
function decodeSeverityFilter(value: string): SecuritySeverity | undefined {
  const decoded = decodeSeverity(value)
  return decoded._tag === 'Some' ? decoded.value : undefined
}

/** Lo mismo para el tipo de evento, que ahora también viaja al servidor. */
function decodeTypeFilter(value: string): SecurityEventType | undefined {
  const decoded = isKnownEventType(value)
  return decoded._tag === 'Some' ? decoded.value : undefined
}

/** Resolver un evento es una acción auditada: su paso tiene nombre. */
const resolveSecurityEvent = Effect.fn('AdminSecurity.resolveEvent')(function* (
  run: (args: { eventId: Id<'securityEvents'>; notes?: string }) => Promise<unknown>,
  eventId: Id<'securityEvents'>,
  notes: string,
  fallback: string
): Effect.fn.Return<void, AdminActionError> {
  yield* adminStep('AdminSecurity.resolveEvent', 'security.resolveSecurityEvent', fallback, () =>
    // NOTA: resolvedByProfileId se obtiene automáticamente del usuario autenticado
    run({ eventId, ...(notes ? { notes } : {}) })
  )
})

const DEMO_SECURITY_EVENTS: SecurityEvent[] = [
  {
    _id: 'demo_security_event_failed_login' as Id<'securityEvents'>,
    _creationTime: Date.UTC(2026, 4, 21, 15, 42),
    type: 'FAILED_LOGIN',
    severity: 'WARNING',
    userEmail: 'guest@dev.local',
    ipAddress: '127.0.0.1',
    details: { source: 'dev-auth snapshot' },
    resolved: false,
  },
  {
    _id: 'demo_security_event_nda_denied' as Id<'securityEvents'>,
    _creationTime: Date.UTC(2026, 4, 21, 14, 0),
    type: 'NDA_ACCESS_DENIED',
    severity: 'ALERT',
    userEmail: 'company@dev.local',
    ipAddress: '127.0.0.1',
    details: { source: 'dev-auth snapshot' },
    resolved: false,
  },
  {
    _id: 'demo_security_event_rate_limit' as Id<'securityEvents'>,
    _creationTime: Date.UTC(2026, 4, 21, 8, 0),
    type: 'RATE_LIMIT_EXCEEDED',
    severity: 'INFO',
    userEmail: 'admin@dev.local',
    ipAddress: '127.0.0.1',
    details: { source: 'dev-auth snapshot' },
    resolved: true,
    resolvedAt: Date.UTC(2026, 4, 21, 10, 0),
    resolutionNotes: 'demoResolutionNotes',
  },
]

const DEMO_SECURITY_COUNTS: SecurityEventCounts = {
  total: 2,
  critical: 0,
  alert: 1,
  warning: 1,
  info: 0,
}

const DEMO_REVIEW_DOCUMENT_NAMES = [
  'demoDocumentName',
  'Pacto social',
  'Estados financieros FY23',
  'Estados financieros FY24',
  'Estados financieros FY25',
  'Modelo v1',
  'Teaser de crédito',
  'CIM borrador',
  'Management presentation',
  'Cap table',
  'Contrato de crédito',
  'Notas a los estados',
  'MD&A FY25',
  'Proyecciones 2026-2028',
  'Organigrama',
  'Registro de accionistas',
  'Avalúo de activos',
  'Póliza de seguro',
  'Licencia de operación',
  'Declaración de renta FY24',
] as const

const DEMO_MANUAL_REVIEW_QUEUE: DocumentReviewItem[] = DEMO_REVIEW_DOCUMENT_NAMES.map(
  (name, index) => ({
    _id: `demo_manual_review_document_${index + 1}` as Id<'documents'>,
    _creationTime: Date.UTC(2026, 4, 21, 15, 15) - index * 3_600_000,
    name,
    accessLevel: 'NDA_REQUIRED',
    classification: 'KYC_SENSITIVE',
    company: {
      _id: 'demo_company_espave' as Id<'companies'>,
      name: 'Sample Hydro, S. A.',
    },
    latestReviewLog: {
      accessedAt: Date.UTC(2026, 4, 21, 15, 15) - index * 3_600_000,
      outcome: 'blocked',
      reason: 'demoReviewReason',
    },
  })
)

// ===== COLUMNAS DE EVENTOS =====
// Los eventos eran una pila de `div`s con borde: cinco datos por fila sin
// encabezado, imposibles de comparar entre filas. Ahora son una tabla con las
// mismas acciones. Las celdas viven fuera del componente porque una función que
// devuelve JSX declarada adentro se remonta en cada render
// (`react/no-unstable-nested-components`).
/** Cifra display como en el tablero: eyebrow + Fraunces 32 tabular, sin tarjeta. */
function Figure({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('font-display mt-2 text-[2rem] leading-tight tabular-nums', tone)}>
        {value}
      </dd>
    </div>
  )
}

function securityEventColumns(
  t: SecurityTranslator,
  locale: string,
  eventTypeLabel: (type: string) => string,
  onResolve: (event: SecurityEvent) => void
): DataTableColumn<SecurityEvent>[] {
  return [
    {
      id: 'date',
      header: t('events.columns.date'),
      enableGlobalFilter: false,
      accessorFn: (event) => event._creationTime,
      cell: ({ row }) => (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
          <Clock aria-hidden="true" className="h-3 w-3" />
          {formatShortRelativeTime(row.original._creationTime, locale)}
        </span>
      ),
    },
    {
      id: 'severity',
      header: t('events.columns.severity'),
      accessorFn: (event) => event.severity,
      cell: ({ row }) => {
        const config = severityConfig[row.original.severity]
        return (
          <span className={`inline-flex items-center gap-2 ${config.color}`}>
            {config.icon}
            <Badge variant={row.original.severity === 'CRITICAL' ? 'destructive' : 'secondary'}>
              {row.original.severity}
            </Badge>
          </span>
        )
      },
    },
    {
      id: 'type',
      header: t('events.columns.type'),
      accessorFn: (event) => eventTypeLabel(event.type),
      cell: ({ row }) => <span className="font-medium">{eventTypeLabel(row.original.type)}</span>,
    },
    {
      id: 'detail',
      header: t('events.columns.detail'),
      enableSorting: false,
      accessorFn: (event) => [event.userEmail, event.ipAddress].filter(Boolean).join(' '),
      meta: { cellClassName: 'text-muted-foreground text-sm' },
      cell: ({ row }) => (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-3">
            {row.original.userEmail && <span>Email: {row.original.userEmail}</span>}
            {row.original.ipAddress && <span>IP: {row.original.ipAddress}</span>}
          </div>
          {row.original.resolutionNotes && (
            <p className="italic">
              {t('events.resolution', {
                notes:
                  row.original.resolutionNotes === 'demoResolutionNotes'
                    ? t('demo.resolutionNotes')
                    : row.original.resolutionNotes,
              })}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'action',
      header: t('events.columns.action'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.resolved ? (
          <Badge variant="outline" className="text-success gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {t('events.resolved')}
          </Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onResolve(row.original)}>
            {t('events.resolve')}
          </Button>
        ),
    },
  ]
}

// ===== MAIN COMPONENT =====
export function AdminSecurityClient() {
  const locale = useLocale()
  const t = useTranslations('admin.security')
  const eventTypeLabel = (type: string) =>
    isKnownEventType(type)._tag === 'Some' ? t(`eventTypes.${type}`) : type
  // ===== FILTROS =====
  const [severityFilter, setSeverityFilter] = useState<string>('ALL')
  const [typeFilter, setTypeFilter] = useState<string>('ALL')
  const [showResolved, setShowResolved] = useState(false)

  // ===== ESTADO DE RESOLUCIÓN =====
  const [resolvingEvent, setResolvingEvent] = useState<SecurityEvent | null>(null)
  const [resolutionNotes, setResolutionNotes] = useState('')
  const [isResolving, setIsResolving] = useState(false)

  // ===== QUERIES =====
  const eventsQuery = useQuery(
    api.security.getRecentSecurityEvents,
    DEV_AUTH_ENABLED
      ? 'skip'
      : {
          limit: 100,
          includeResolved: showResolved,
          // El filtro es un `string` de un `<Select>`: se decodifica contra el
          // catálogo del backend antes de viajar como argumento de la query,
          // en vez de castearlo y confiar.
          severity: decodeSeverityFilter(severityFilter),
          // El tipo viaja igual que la severidad. Filtrado en el navegador
          // sobre los 100 eventos más recientes, un evento más viejo de ese
          // tipo no existía para el equipo aunque fuera el único de su clase.
          type: decodeTypeFilter(typeFilter),
        }
  )

  const countsQuery = useQuery(api.security.getSecurityEventsCounts, DEV_AUTH_ENABLED ? 'skip' : {})
  const manualReviewQueueQuery = useQuery(
    api.documents.getManualReviewQueue,
    DEV_AUTH_ENABLED ? 'skip' : { limit: 25 }
  )

  const events = DEV_AUTH_ENABLED ? DEMO_SECURITY_EVENTS : eventsQuery
  const counts = DEV_AUTH_ENABLED ? DEMO_SECURITY_COUNTS : countsQuery
  const manualReviewQueue = DEV_AUTH_ENABLED ? DEMO_MANUAL_REVIEW_QUEUE : manualReviewQueueQuery

  // ===== MUTATIONS =====
  const resolveEventMutation = useMutation(api.security.resolveSecurityEvent)

  // Los tres filtros los resuelve la query; en dev-auth la muestra local nunca
  // pasa por Convex, así que se filtra acá con el mismo criterio.
  const filteredEvents = DEV_AUTH_ENABLED
    ? events?.filter((event: SecurityEvent) => {
        if (!showResolved && event.resolved) return false
        if (severityFilter !== 'ALL' && event.severity !== severityFilter) return false
        if (typeFilter !== 'ALL' && event.type !== typeFilter) return false
        return true
      })
    : events

  // ===== MANEJAR RESOLUCIÓN =====
  const handleResolve = () => {
    if (!resolvingEvent) return

    if (DEV_AUTH_ENABLED) {
      toast.success(t('toasts.demoResolved'))
      setResolvingEvent(null)
      setResolutionNotes('')
      return
    }

    setIsResolving(true)
    void runClientEffect(
      resolveSecurityEvent(
        resolveEventMutation,
        resolvingEvent._id,
        resolutionNotes,
        t('toasts.error')
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            toast.success(t('toasts.resolved'))
            setResolvingEvent(null)
            setResolutionNotes('')
          })
        ),
        Effect.catch((error) =>
          Effect.logError(`[AdminSecurityClient] ${error.action} falló en ${error.step}`).pipe(
            Effect.andThen(Effect.sync(() => toast.error(error.message)))
          )
        ),
        Effect.ensuring(Effect.sync(() => setIsResolving(false)))
      )
    )
  }

  const eventColumns = securityEventColumns(t, locale, eventTypeLabel, setResolvingEvent)

  // ===== LOADING STATE =====
  if (events === undefined || counts === undefined || manualReviewQueue === undefined) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    )
  }

  // Sin tarjetas: el aviso de dev-auth es una línea, las cinco cifras una fila
  // y la cola de revisión filas con hairline. La pantalla medía 1340 px
  // ([F] 2026-09-11, tarjeta O1-05).
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {DEV_AUTH_ENABLED && (
        <p className="text-muted-foreground text-sm" role="status" aria-live="polite">
          {t('snapshot.description')}
        </p>
      )}

      {/* ===== CONTADORES DE SEVERIDAD ===== */}
      <dl className="border-border-hairline grid grid-cols-2 gap-6 border-t pt-4 md:grid-cols-5">
        <Figure label={t('stats.unresolved')} value={counts.total} />
        <Figure label={t('stats.critical')} value={counts.critical} tone="text-destructive" />
        <Figure label={t('stats.alert')} value={counts.alert} tone="text-warning" />
        <Figure label={t('stats.warning')} value={counts.warning} tone="text-warning" />
        <Figure label={t('stats.info')} value={counts.info} tone="text-info" />
      </dl>

      {/* ===== COLA DE REVISIÓN DOCUMENTAL ===== */}
      <section className="border-border-hairline shrink-0 border-t pt-4">
        <h2 className="font-sans text-lg font-semibold tracking-normal">
          {t('reviewQueue.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('reviewQueue.description')}</p>

        {!manualReviewQueue || manualReviewQueue.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">{t('reviewQueue.empty')}</p>
        ) : (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              {t('reviewQueue.count', { count: manualReviewQueue.length })}
            </p>
            {/* Cinco filas de py-2 y dos líneas (~3.5rem); el resto scrollea. */}
            <ul className="divide-border-hairline mt-2 max-h-[17.5rem] divide-y overflow-y-auto">
              {manualReviewQueue.map((item: DocumentReviewItem) => (
                <li key={item._id} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {item.name === 'demoDocumentName' ? t('demo.documentName') : item.name}
                      </span>
                      <Badge
                        variant="outline"
                        className={getClassificationBadgeClassName(item.classification)}
                      >
                        {t(`classifications.${item.classification || 'KYC_SENSITIVE'}`)}
                      </Badge>
                      {item.accessLevel && <Badge variant="secondary">{item.accessLevel}</Badge>}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {t('reviewQueue.company', {
                        company: item.company?.name || t('reviewQueue.noCompany'),
                      })}
                      {/* Sin fecha de acceso no hay «último intento»: el fallback
                          de `reviewedAt` diría «ahora» de un intento que no tiene
                          hora (hallazgo de CodeRabbit). */}
                      {item.latestReviewLog?.accessedAt
                        ? ` · ${t('reviewQueue.lastAttempt', {
                            date: formatShortRelativeTime(
                              reviewedAt(item.latestReviewLog.accessedAt),
                              locale
                            ),
                          })}`
                        : ''}
                      {item.latestReviewLog?.reason
                        ? ` · ${item.latestReviewLog.reason === 'demoReviewReason' ? t('demo.reviewReason') : item.latestReviewLog.reason}`
                        : ''}
                    </p>
                  </div>
                  <div className="text-muted-foreground shrink-0 text-xs">
                    {formatShortRelativeTime(reviewedAt(item._creationTime), locale)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ===== FILTROS ===== */}
      <div className="border-border-hairline flex flex-wrap items-center gap-3 border-t pt-4">
        <div className="w-40">
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger aria-label={t('filters.severityPlaceholder')}>
              <SelectValue placeholder={t('filters.severityPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('filters.allSeverities')}</SelectItem>
              <SelectItem value="CRITICAL">{t('stats.critical')}</SelectItem>
              <SelectItem value="ALERT">{t('stats.alert')}</SelectItem>
              <SelectItem value="WARNING">{t('stats.warning')}</SelectItem>
              <SelectItem value="INFO">{t('stats.info')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="w-56">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger aria-label={t('filters.typePlaceholder')}>
              <SelectValue placeholder={t('filters.typePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('filters.allTypes')}</SelectItem>
              {EVENT_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {eventTypeLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant={showResolved ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowResolved(!showResolved)}
        >
          {showResolved ? (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" />
              {t('showingResolved')}
            </>
          ) : (
            <>
              <Shield className="mr-2 h-4 w-4" />
              {t('showResolved')}
            </>
          )}
        </Button>
      </div>

      {/* ===== LISTA DE EVENTOS ===== */}
      <section className="border-border-hairline flex min-h-0 flex-1 flex-col gap-3 border-t pt-4">
        <div>
          <h2 className="font-sans text-lg font-semibold tracking-normal">{t('events.title')}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('events.count', { count: filteredEvents?.length || 0 })}
            {!showResolved && t('events.unresolvedSuffix')}
          </p>
        </div>
        <DataTable
          ariaLabel={t('events.title')}
          columns={eventColumns}
          data={filteredEvents ?? []}
          fillHeight
          emptyMessage={showResolved ? t('events.emptyAll') : t('events.emptyUnresolved')}
          rowId={(event) => `security-event-${event._id}`}
        />
      </section>

      {/* ===== DIALOG DE RESOLUCIÓN ===== */}
      <Dialog open={!!resolvingEvent} onOpenChange={(open) => !open && setResolvingEvent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog.title')}</DialogTitle>
            <DialogDescription>{t('dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {resolvingEvent && (
              <div className="bg-muted/50 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{resolvingEvent.severity}</Badge>
                  <span className="font-medium">{eventTypeLabel(resolvingEvent.type)}</span>
                </div>
                <p className="text-muted-foreground mt-2 text-sm">
                  {resolvingEvent.userEmail && `Email: ${resolvingEvent.userEmail}`}
                  {resolvingEvent.ipAddress && ` | IP: ${resolvingEvent.ipAddress}`}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('dialog.notesLabel')}</label>
              <Textarea
                placeholder={t('resolutionNotesPlaceholder')}
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResolvingEvent(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button onClick={handleResolve} disabled={isResolving}>
              {isResolving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              {t('dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
