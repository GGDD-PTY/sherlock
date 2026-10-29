'use client'

// ============================================================================
// ACTIVIDAD DEL DATA ROOM (CLIENTE)
// ============================================================================
// Quién abrió y quién descargó cada documento del VDR. La query de Convex es la
// frontera de autorización y también la que decide qué identidad se revela: acá
// solo se pinta lo que ya vino resuelto.
//
// El cajón de eventos filtra el arreglo `events` que ya se trajo — sin segunda
// query, sin segunda superficie de authz, y con la garantía de que los
// contadores nunca contradicen las filas que los respaldan.
// ============================================================================

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Option, Schema } from 'effect'
import { useSearchParams } from 'next/navigation'
import { useQuery } from 'convex/react'
import { Link } from '@/i18n/navigation'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { getVdrFolderLabel } from '@/lib/vdr/document-taxonomy'
import { formatDateTime, formatShortDate } from '@/lib/utils'
import {
  activityCopy,
  normalizeLocale,
  windowDaysOr,
  WINDOW_OPTIONS,
  type WindowDays,
} from './copy'
import { ActivitySkeleton } from './ActivitySkeleton'
import { ConvexLoadFailure } from '@/components/company/vdr/ConvexLoadFailure'
import { useConvexLoadTimeout } from '@/components/company/vdr/useConvexLoadTimeout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, Download, Eye, FolderLock, Link2, ShieldAlert } from 'lucide-react'

// ===== LA COSTURA CON EFFECT =====
// El tipo de evento venía del backend y se casteaba: `KIND_META[event.kind as
// ActivityKind]`. Un tipo de evento que el backend agregue y esta tabla no
// tenga daba `undefined`, y la línea siguiente —`meta.icon`— tiraba el cajón de
// eventos entero. Ahora el tipo se decodifica contra la unión real y lo que no
// esté en la tabla cae en `OTHER`, que existe justo para eso.
const ActivityKindSchema = Schema.Literals(['VIEW', 'DOWNLOAD', 'LINK', 'BLOCKED', 'OTHER'])
type ActivityKind = typeof ActivityKindSchema.Type
const decodeActivityKind = Schema.decodeUnknownOption(ActivityKindSchema)

function activityKindOr(value: unknown, fallback: ActivityKind): ActivityKind {
  const decoded = decodeActivityKind(value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

type AccessLevel = 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE' | null | undefined

interface DataRoomActivityClientProps {
  companyId: string
  companyName: string
  returnHref?: string
}

type Selection = { type: 'document' | 'counterparty'; key: string }

type ActivityCopy = (typeof activityCopy)['es']

const KIND_META = {
  VIEW: { icon: Eye, className: 'border-line text-foreground', copyKey: 'kindView' },
  DOWNLOAD: {
    icon: Download,
    className: 'border-accent/50 text-foreground',
    copyKey: 'kindDownload',
  },
  LINK: { icon: Link2, className: 'text-muted-foreground', copyKey: 'kindLink' },
  BLOCKED: {
    icon: ShieldAlert,
    className: 'border-destructive/30 text-destructive',
    copyKey: 'kindBlocked',
  },
  OTHER: { icon: Link2, className: 'text-muted-foreground', copyKey: 'kindOther' },
} as const satisfies Record<
  ActivityKind,
  { icon: typeof Eye; className: string; copyKey: keyof ActivityCopy }
>

// El rótulo de cada período salía de armar la clave por concatenación y
// castearla (`copy[`window${days}` as 'window7']`). Cada período nombra el suyo.
type WindowLabelKey = 'window7' | 'window30' | 'window90' | 'window365'

const WINDOW_LABEL: Record<WindowDays, WindowLabelKey> = {
  7: 'window7',
  30: 'window30',
  90: 'window90',
  365: 'window365',
}

function accessLabel(accessLevel: AccessLevel, copy: ActivityCopy) {
  if (accessLevel === 'PUBLIC') return copy.accessPublic
  if (accessLevel === 'NDA_REQUIRED') return copy.accessNda
  return copy.accessPrivate
}

export function DataRoomActivityClient(props: DataRoomActivityClientProps) {
  const [attempt, setAttempt] = useState(0)
  return (
    <DataRoomActivityLive
      key={`${props.companyId}:${attempt}`}
      {...props}
      onRetry={() => {
        setAttempt((current) => current + 1)
      }}
    />
  )
}

function DataRoomActivityLive({
  companyId,
  companyName,
  returnHref = '/my-company/documents',
  onRetry,
}: DataRoomActivityClientProps & { onRetry: () => void }) {
  const locale = normalizeLocale(useLocale())
  const copy = activityCopy[locale]
  const t = useTranslations('vdr.activity')
  const searchParams = useSearchParams()

  const [windowDays, setWindowDays] = useState<WindowDays>(30)
  const [selection, setSelection] = useState<Selection | null>(() => {
    const documentId = searchParams.get('document')
    return documentId ? { type: 'document', key: documentId } : null
  })

  const activity = useQuery(api.documents.getRoomActivity, {
    companyId: companyId as Id<'companies'>,
    windowDays,
  })
  const loadTimeout = useConvexLoadTimeout(activity === undefined, 12_000, companyId)

  const documentNames = useMemo(
    () => new Map((activity?.byDocument ?? []).map((row) => [row.documentId as string, row.name])),
    [activity]
  )

  const counterpartyLabels = useMemo(
    () =>
      new Map(
        (activity?.byCounterparty ?? []).map((row) => [
          row.key as string,
          // La contraparte no tiene nombre propio que revelar: o es el
          // equipo, o es su código seudónimo de esta sala.
          row.kind === 'TEAM'
            ? copy.teamLabel
            : (row.displayName ?? `${copy.counterpartyPrefix} ${row.code}`),
        ])
      ),
    [activity, copy]
  )

  const selectedEvents = useMemo(() => {
    if (!activity || !selection) return []

    return activity.events.filter((event) =>
      selection.type === 'document'
        ? event.documentId === selection.key
        : event.counterpartyKey === selection.key
    )
  }, [activity, selection])

  // Cada columna cae a SU propio fallback. `unknownLabel` habla de perfiles y
  // solo sirve para contrapartes: puesto en una fecha o en un documento decía
  // "Perfil no disponible" sobre algo que no es un perfil.
  const formatDay = (at: number) => formatShortDate(at, locale, copy.unknownDate)
  const formatEventMoment = (at: number) => formatDateTime(at, locale, copy.unknownDate)

  if (loadTimeout.timedOut) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <ConvexLoadFailure message={t('loadFailed')} onRetry={onRetry} />
      </div>
    )
  }

  if (activity === undefined) {
    return <ActivitySkeleton />
  }

  const hasActivity = activity.byDocument.length > 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      {/* ===== ENCABEZADO ===== */}
      <div className="mb-8">
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href={returnHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {copy.backToDataRoom}
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-3xl font-normal tracking-normal">{copy.title}</h1>
            <p className="text-muted-foreground mt-1">{copy.subtitle(companyName)}</p>
          </div>
          <Select
            value={String(windowDays)}
            onValueChange={(value) => setWindowDays(windowDaysOr(value, windowDays))}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label={copy.window}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {copy[WINDOW_LABEL[days]]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ===== TOTALES ===== */}
      <div className="mb-8 grid gap-4 md:grid-cols-4">
        {[
          { label: copy.statViews, value: activity.totals.views },
          { label: copy.statDownloads, value: activity.totals.downloads },
          { label: copy.statCounterparties, value: activity.counterpartyCount },
          { label: copy.statDocuments, value: activity.documentCount },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="font-data text-3xl">{stat.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      {/* ===== VACÍO / TABLAS ===== */}
      {!hasActivity ? (
        <EmptyState
          icon={FolderLock}
          title={copy.emptyNoActivityTitle}
          description={copy.emptyNoActivityBody}
          action={{ label: copy.emptyNoActivityAction, onClick: () => setWindowDays(365) }}
          secondaryAction={{ label: copy.emptyActionDataRoom, href: returnHref }}
        />
      ) : (
        <Tabs defaultValue="documents">
          <TabsList className="mb-4">
            <TabsTrigger value="documents">{copy.tabDocuments}</TabsTrigger>
            <TabsTrigger value="counterparties">{copy.tabCounterparties}</TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            <div className="border-line min-w-0 overflow-hidden rounded-lg border">
              <Table className="md:min-w-[52rem]">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-xs">{copy.colDocument}</TableHead>
                    <TableHead className="text-xs">{copy.colAccess}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colCounterparties}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colViews}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colDownloads}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colBlocked}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colLastAccess}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.byDocument.map((row) => (
                    <TableRow
                      key={row.documentId}
                      data-testid={`activity-document-row-${row.documentId}`}
                      className="cursor-pointer"
                      onClick={() => setSelection({ type: 'document', key: row.documentId })}
                    >
                      <TableCell className="font-medium">
                        {row.name ?? copy.unknownDocument}
                        <span className="text-muted-foreground block text-xs">
                          {getVdrFolderLabel(row.folder, locale)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{accessLabel(row.accessLevel, copy)}</Badge>
                      </TableCell>
                      <TableCell className="font-data text-right">
                        {row.counterpartyCount}
                      </TableCell>
                      <TableCell className="font-data text-right">{row.counters.views}</TableCell>
                      <TableCell data-testid="activity-downloads" className="font-data text-right">
                        {row.counters.downloads}
                      </TableCell>
                      <TableCell
                        className={`font-data text-right ${
                          row.counters.blocked > 0 ? 'text-destructive' : 'text-muted-foreground'
                        }`}
                      >
                        {row.counters.blocked}
                      </TableCell>
                      <TableCell className="font-data text-muted-foreground text-right">
                        {formatDay(row.lastAccessAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="counterparties">
            <div className="border-line min-w-0 overflow-hidden rounded-lg border">
              <Table className="md:min-w-[52rem]">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="text-xs">{copy.colCounterparty}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colDocuments}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colViews}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colDownloads}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colBlocked}</TableHead>
                    <TableHead className="text-right text-xs">{copy.colLastAccess}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.byCounterparty.map((row) => (
                    <TableRow
                      key={row.key}
                      data-testid={`activity-counterparty-row-${row.key}`}
                      className="cursor-pointer"
                      onClick={() => setSelection({ type: 'counterparty', key: row.key })}
                    >
                      <TableCell className="font-medium">
                        {counterpartyLabels.get(row.key) ?? copy.unknownLabel}
                        {!row.identityRevealed && (
                          <span className="text-muted-foreground block text-xs">
                            {copy.identityHidden}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-data text-right">{row.documentCount}</TableCell>
                      <TableCell className="font-data text-right">{row.counters.views}</TableCell>
                      <TableCell className="font-data text-right">
                        {row.counters.downloads}
                      </TableCell>
                      <TableCell
                        className={`font-data text-right ${
                          row.counters.blocked > 0 ? 'text-destructive' : 'text-muted-foreground'
                        }`}
                      >
                        {row.counters.blocked}
                      </TableCell>
                      <TableCell className="font-data text-muted-foreground text-right">
                        {formatDay(row.lastAccessAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">{copy.identityHiddenHint}</p>
          </TabsContent>
        </Tabs>
      )}

      {activity.truncated ? (
        <p className="text-muted-foreground mt-4 text-xs">
          {copy.truncatedNotice(activity.scanCap)}
        </p>
      ) : null}
      <p className="text-muted-foreground mt-2 text-xs">{copy.linkNote}</p>

      {/* ===== CAJÓN DE EVENTOS ===== */}
      <Sheet open={selection !== null} onOpenChange={(open) => !open && setSelection(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{copy.drawerTitle}</SheetTitle>
            <SheetDescription>
              {selection?.type === 'document'
                ? (documentNames.get(selection.key) ?? copy.unknownDocument)
                : (counterpartyLabels.get(selection?.key ?? '') ?? copy.unknownLabel)}
            </SheetDescription>
          </SheetHeader>
          <div data-testid="activity-events" className="px-4 pb-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{copy.drawerColWhen}</TableHead>
                  <TableHead className="text-xs">{copy.drawerColAction}</TableHead>
                  <TableHead className="text-xs">
                    {selection?.type === 'document'
                      ? copy.drawerColCounterparty
                      : copy.drawerColDocument}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedEvents.map((event) => {
                  const meta = KIND_META[activityKindOr(event.kind, 'OTHER')]
                  const Icon = meta.icon

                  return (
                    <TableRow key={event.id} data-testid="activity-event-row">
                      <TableCell className="font-data">{formatEventMoment(event.at)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={meta.className}>
                          <Icon className="mr-1 h-3 w-3" />
                          {copy[meta.copyKey]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {selection?.type === 'document'
                          ? (counterpartyLabels.get(event.counterpartyKey) ?? copy.unknownLabel)
                          : (documentNames.get(event.documentId) ?? copy.unknownDocument)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
