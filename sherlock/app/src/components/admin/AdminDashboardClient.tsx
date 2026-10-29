'use client'

// ============================================================================
// VISTA GENERAL DEL EQUIPO
// ============================================================================
// Dos personas abren esta pantalla. Lo que tienen que ver en un vistazo es
// quién se movió, qué llegó y cuánto queda del plan. Por eso hay UNA tabla de
// salas, dos listas cortas y un índice de enlaces — no dieciséis cards.
//
// Todo sale de `api.adminOverview.getAdminOverview` en una sola lectura
// acotada, y la propia consulta avisa cuando truncó. Los enlaces llevan
// `prefetch={false}`: cada URL de /admin en el viewport hace que el proxy
// corra getCurrentUserState.
// ============================================================================

import { Schema } from 'effect'
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'

import { api } from '@/../convex/_generated/api'
import { DailySeriesPanel, type DailySeries } from '@/components/admin/charts/DailySeriesPanel'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Link } from '@/i18n/navigation'
import { getNumberFormatLocale } from '@/i18n/routing'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { localConvexAdminKey } from '@/lib/dev-auth/local-convex-identity'
import { formatFileSize } from '@/lib/utils'

type AdminOverview = FunctionReturnType<typeof api.adminOverview.getAdminOverview>
type CompanyRow = Omit<AdminOverview['companies'][number], 'companyId'> & { companyId: string }
type AlertRow = Omit<AdminOverview['alerts'][number], 'alertId' | 'companyId'> & {
  alertId: string
  companyId: string | null
}
type SupportRow = Omit<AdminOverview['support']['threads'][number], 'threadId' | 'companyId'> & {
  threadId: string
  companyId: string | null
}
type AdminOverviewView = Omit<AdminOverview, 'companies' | 'alerts' | 'support'> & {
  companies: CompanyRow[]
  alerts: AlertRow[]
  support: Omit<AdminOverview['support'], 'threads'> & { threads: SupportRow[] }
}

const GIBIBYTE = 1024 * 1024 * 1024

// El tablero enseña las salas que se movieron; la lista completa vive en
// `/admin/companies` y el pie de la tabla lleva hasta allá.
const ROOMS_ROWS_CAP = 4

// `dev:local` sí tiene un backend real y una identidad admin configurada. Solo
// el dev-auth sin ese par usa los fixtures históricos del dashboard.
const USE_DEV_AUTH_FIXTURES =
  DEV_AUTH_ENABLED &&
  localConvexAdminKey(
    {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
    },
    DEV_AUTH_ENABLED
  ) === null

const FALLBACK_OVERVIEW: AdminOverviewView = {
  companies: [
    {
      companyId: 'demo_company_001',
      name: 'Sample Hydro, S. A.',
      ownerEmail: 'company@dev.local',
      documentsTotal: 13,
      documentsByFolder: {
        room_legal: 3,
        room_corporate: 2,
        room_financial: 6,
        room_operations: 1,
        room_marketing: 1,
      },
      storageBytes: 18_400_000,
      lastUploadAt: 0,
      deliverableVersions: 1,
      supportUnread: 0,
      truncated: false,
    },
  ],
  alerts: [],
  support: { threads: [], unreadThreads: 0, unreadMessages: 0 },
  usage: {
    companies: 1,
    documents: 13,
    storageBytes: 18_400_000,
    storageCapBytes: GIBIBYTE,
    usersByRole: { ADMIN: 2, COMPANY: 1 },
    truncated: false,
  },
  coverage: { truncated: false, companyCap: 50 },
  generatedAt: 0,
}

// Sin backend local no hay serie que contar: la sección lo dice en vez de
// quedarse cargando para siempre.
const FALLBACK_SERIES: DailySeries = { dias: [], diasConDatos: 0, truncado: false }

/** Gibibytes con dos decimales; por debajo de 1 GiB manda el formato del data room. */
// El conteo llega del backend: un NaN o un Infinity pintaría «NaN GB» en la
// cifra grande del tablero, así que se valida en la frontera.
const isByteCount = Schema.is(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))

function formatStorage(bytes: number): string {
  if (!isByteCount(bytes)) return formatFileSize(0, '0 B')
  if (bytes >= GIBIBYTE) return `${(bytes / GIBIBYTE).toFixed(2)} GB`
  return formatFileSize(bytes, '0 B')
}

/** Cifra display: Fraunces 32, navy en light / crema en dark, guarismos tabulares. */
const FIGURE_CLASS = 'font-display text-[2rem] leading-tight tabular-nums'
/** Encabezado de sección: sans 18 semibold; la Fraunces queda para el h1. */
const SECTION_HEADING_CLASS = 'font-sans text-lg font-semibold tracking-normal'
const SECTION_CLASS = 'border-border-hairline border-t pt-3'

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-2 ${FIGURE_CLASS}`}>{value}</dd>
    </div>
  )
}

export function AdminDashboardClient() {
  const t = useTranslations('admin.operations')
  const locale = useLocale()
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const overviewQuery = useQuery(
    api.adminOverview.getAdminOverview,
    USE_DEV_AUTH_FIXTURES ? 'skip' : {}
  )
  const overview: AdminOverviewView | undefined = USE_DEV_AUTH_FIXTURES
    ? FALLBACK_OVERVIEW
    : overviewQuery
  const seriesArgs = USE_DEV_AUTH_FIXTURES ? 'skip' : {}
  const documentsSeries = useQuery(api.analyticsSeries.getDocumentsDaily, seriesArgs)
  const intakeSeries = useQuery(api.analyticsSeries.getIntakeDaily, seriesArgs)
  const activitySeries = useQuery(api.analyticsSeries.getActivityDaily, seriesArgs)

  if (overview === undefined) {
    return (
      <div aria-busy="true" className="space-y-6">
        <p aria-label={t('loading')} className="sr-only" role="status">
          {t('loading')}
        </p>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    )
  }

  const number = new Intl.NumberFormat(getNumberFormatLocale(locale))
  const count = (value: number) => number.format(value)
  const when = (value: number | null) =>
    value === null || value === 0
      ? t('overview.rooms.never')
      : format.relativeTime(new Date(value), now)
  const rooms = [...overview.companies]
    .toSorted((a, b) => (b.lastUploadAt ?? 0) - (a.lastUploadAt ?? 0))
    .slice(0, ROOMS_ROWS_CAP)
  const seriesTruncated = [documentsSeries, intakeSeries, activitySeries].some(
    (serie) => serie?.truncado === true
  )
  const storageRatio = Math.min(
    100,
    Math.round((overview.usage.storageBytes / overview.usage.storageCapBytes) * 100)
  )

  return (
    <div className="space-y-6">
      {USE_DEV_AUTH_FIXTURES ? (
        <div className="border-warning/20 bg-warning/10 rounded-md border px-4 py-3" role="alert">
          <p className="text-sm font-medium">{t('sample.title')}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t('sample.description')}</p>
        </div>
      ) : null}

      {overview.coverage.truncated ? (
        <p
          className="border-border bg-muted/30 text-muted-foreground rounded-md border px-4 py-3 text-xs"
          role="status"
        >
          {t('overview.capped', { count: overview.coverage.companyCap })}
        </p>
      ) : null}

      <section aria-label={t('overview.usage.title')} data-testid="admin-overview-usage">
        <dl className={`${SECTION_CLASS} grid grid-cols-2 gap-6 sm:grid-cols-4`}>
          <Figure label={t('overview.usage.companies')} value={count(overview.usage.companies)} />
          <Figure label={t('overview.usage.documents')} value={count(overview.usage.documents)} />
          <div className="min-w-0">
            <dt className="eyebrow">{t('overview.usage.storage')}</dt>
            {/* La barra y su leyenda viven dentro del dd: un dl solo admite
                grupos dt/dd, y la barra necesita nombre accesible. */}
            <dd className="mt-2">
              <span className={`block ${FIGURE_CLASS}`}>
                {formatStorage(overview.usage.storageBytes)}
              </span>
              <Progress
                aria-label={t('overview.usage.storage')}
                className="mt-2 h-1"
                value={storageRatio}
              />
              <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                {t('overview.usage.storageOf', {
                  cap: formatStorage(overview.usage.storageCapBytes),
                })}
              </p>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="eyebrow">{t('overview.usage.accounts')}</dt>
            <dd className="mt-2 space-y-1 text-sm">
              <p className="tabular-nums">
                {t('overview.usage.team', { count: overview.usage.usersByRole.ADMIN })}
              </p>
              <p className="tabular-nums">
                {t('overview.usage.clients', { count: overview.usage.usersByRole.COMPANY })}
              </p>
            </dd>
          </div>
        </dl>
        {/* Las series viven dentro del bloque de consumo: una sección propia
            costaba encabezado, borde y separación, y la ruta tiene que caber
            en 900 px (tarjeta O1-04). */}
        <section
          aria-label={t('overview.series.title')}
          className="mt-3 space-y-2"
          data-testid="admin-overview-series"
        >
          <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
            <DailySeriesPanel
              color="var(--chart-1)"
              label={t('overview.series.documents')}
              serie={USE_DEV_AUTH_FIXTURES ? FALLBACK_SERIES : documentsSeries}
            />
            <DailySeriesPanel
              color="var(--chart-2)"
              label={t('overview.series.intake')}
              serie={USE_DEV_AUTH_FIXTURES ? FALLBACK_SERIES : intakeSeries}
            />
            <DailySeriesPanel
              color="var(--chart-4)"
              label={t('overview.series.activity')}
              serie={USE_DEV_AUTH_FIXTURES ? FALLBACK_SERIES : activitySeries}
            />
          </div>
          {seriesTruncated ? (
            <p className="text-muted-foreground text-xs">{t('overview.series.truncated')}</p>
          ) : null}
        </section>
      </section>

      <section
        aria-label={t('overview.rooms.title')}
        className={`${SECTION_CLASS} space-y-2`}
        data-testid="admin-overview-rooms"
      >
        <h2 className={SECTION_HEADING_CLASS}>{t('overview.rooms.title')}</h2>
        {overview.companies.length === 0 ? (
          <p className="text-muted-foreground border-border rounded-md border py-8 text-center text-sm">
            {t('overview.rooms.empty')}
          </p>
        ) : (
          <Table
            aria-label={t('overview.rooms.tableLabel')}
            data-testid="admin-overview-rooms-table"
          >
            {/* `py-1` en celdas y encabezados: la tabla es el bloque más alto
                del tablero y la ruta tiene que caber en 900 px. */}
            <TableHeader className="[&_th]:py-1">
              <TableRow>
                <TableHead allowWrap>{t('overview.rooms.company')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.documents')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.legal')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.corporate')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.financial')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.operations')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.marketing')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.storage')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.lastUpload')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.deliverables')}</TableHead>
                <TableHead className="text-right">{t('overview.rooms.support')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_td]:py-1">
              {rooms.map((company) => (
                <TableRow key={company.companyId}>
                  <TableCell allowWrap>
                    <Link
                      className="hover:text-primary font-medium underline-offset-4 hover:underline"
                      href={`/admin/companies/${company.companyId}/documents`}
                      prefetch={false}
                    >
                      {company.name}
                    </Link>
                    {company.ownerEmail ? (
                      <p className="text-muted-foreground text-xs">{company.ownerEmail}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-figure text-right font-semibold tabular-nums">
                    {count(company.documentsTotal)}
                  </TableCell>
                  <TableCell className="font-figure text-muted-foreground text-right tabular-nums">
                    {count(company.documentsByFolder.room_legal)}
                  </TableCell>
                  <TableCell className="font-figure text-muted-foreground text-right tabular-nums">
                    {count(company.documentsByFolder.room_corporate)}
                  </TableCell>
                  <TableCell className="font-figure text-muted-foreground text-right tabular-nums">
                    {count(company.documentsByFolder.room_financial)}
                  </TableCell>
                  <TableCell className="font-figure text-muted-foreground text-right tabular-nums">
                    {count(company.documentsByFolder.room_operations)}
                  </TableCell>
                  <TableCell className="font-figure text-muted-foreground text-right tabular-nums">
                    {count(company.documentsByFolder.room_marketing)}
                  </TableCell>
                  <TableCell className="font-figure text-right tabular-nums">
                    {formatStorage(company.storageBytes)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs">
                    {when(company.lastUploadAt)}
                  </TableCell>
                  <TableCell className="font-figure text-right tabular-nums">
                    {count(company.deliverableVersions)}
                  </TableCell>
                  <TableCell className="font-figure text-right tabular-nums">
                    {company.supportUnread > 0 ? count(company.supportUnread) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {overview.companies.length === 0 ? null : (
          <p className="text-muted-foreground text-xs">
            <Link
              className="hover:text-primary underline-offset-4 hover:underline"
              href="/admin/companies"
              prefetch={false}
            >
              {t('overview.rooms.seeAll', { count: overview.usage.companies })}
            </Link>
          </p>
        )}
      </section>

      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <section
          aria-label={t('overview.alerts.title')}
          className={`${SECTION_CLASS} space-y-3`}
          data-testid="admin-overview-alerts"
        >
          <h2 className={SECTION_HEADING_CLASS}>{t('overview.alerts.title')}</h2>
          {overview.alerts.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('overview.alerts.empty')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {overview.alerts.map((alert) => (
                <li
                  className="flex items-baseline justify-between gap-4 py-2.5"
                  key={alert.alertId}
                >
                  <div className="min-w-0">
                    <Link
                      className="hover:text-primary text-sm font-medium underline-offset-4 hover:underline"
                      href={alert.link}
                      prefetch={false}
                    >
                      {alert.companyName}
                    </Link>
                    <p className="text-muted-foreground text-xs">
                      {alert.kind === 'COMPANY_WORKSPACE_CREATED'
                        ? t('overview.alerts.workspace')
                        : t('overview.alerts.documents', { count: alert.fileCount })}
                      {alert.isRead ? '' : ` · ${t('overview.alerts.unread')}`}
                    </p>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {when(alert.lastEventAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label={t('overview.support.title')}
          className={`${SECTION_CLASS} space-y-4`}
          data-testid="admin-overview-support"
        >
          <h2 className={SECTION_HEADING_CLASS}>{t('overview.support.title')}</h2>
          {overview.support.threads.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('overview.support.empty')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {overview.support.threads.map((thread) => (
                <li
                  className="flex items-baseline justify-between gap-4 py-2.5"
                  key={thread.threadId}
                >
                  <span className="min-w-0 truncate text-sm">
                    {thread.roomLabel ?? t('overview.support.intake')}
                  </span>
                  <span className="font-figure text-muted-foreground shrink-0 text-xs tabular-nums">
                    {t('overview.support.pending', { count: thread.unreadCount })} ·{' '}
                    {when(thread.lastMessageAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/support" prefetch={false}>
              {t('overview.support.openInbox')}
            </Link>
          </Button>
        </section>
      </div>
    </div>
  )
}
