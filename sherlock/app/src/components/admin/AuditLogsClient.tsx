'use client'

// ============================================================================
// AUDIT LOGS CLIENT COMPONENT
// ============================================================================
// Display admin action history with filters.
// Note: This component requires `bunx convex dev` to generate API types.
//
// ===== ESTA PANTALLA CONOCE UNA PARTE DEL CATÁLOGO, Y AHORA LO DICE =====
// `convex/_helpers/auditLog.ts` define 81 acciones de admin como
// `Schema.Literals`. Acá había 29 escritas otra vez a mano en `actionStyles`,
// y `src/messages/es.json` traía 31 etiquetas — tres de ellas
// (`DOCUMENT_ACCESS_OVERRIDE`, `ADMIN_LOGIN`, `SETTINGS_CHANGE`) para acciones
// que el backend NO puede escribir: copia muerta.
//
// Las 52 acciones restantes se pintan como su enum en crudo. Eso no es un bug,
// es la cobertura real; lo que sí era un bug es que no se pudiera ver. Ahora la
// lista es UN `Schema.Literals` —`RENDERED_ACTIONS`— del que salen el mapa de
// estilos y el tipo, así que agregar un estilo sin su etiqueta, o al revés, no
// compila. El catálogo completo no se importa de Convex porque
// `AdminActionSchema` no está exportado allá (ver el reporte de esta ola).
// ============================================================================

import { usePaginatedQuery, useQuery } from 'convex/react'
import { Schema } from 'effect'
import { api } from '../../../convex/_generated/api'
import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Id } from '../../../convex/_generated/dataModel'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { formatDateTime } from '@/lib/utils'

const adminAuditLogsApi = api.adminAuditLogs

// ===== TYPE DEFINITIONS =====
interface AuditLogItem {
  _id: Id<'adminAuditLogs'>
  _creationTime: number
  adminProfileId: Id<'profiles'>
  adminEmail: string
  adminName: string
  action: string
  targetType: string
  targetId?: string
  previousValue?: unknown
  newValue?: unknown
  notes?: string
  demoNoteKey?: 'companyVerified' | 'kycApproved'
}

type AuditStats = {
  totalLogs: number
  totalLogsCapped: boolean
  recentLogs: number
  byCategory: {
    user: number
    kyc: number
  }
}

const DEMO_AUDIT_LOGS: AuditLogItem[] = [
  {
    _id: 'demo_audit_log_company_verified' as Id<'adminAuditLogs'>,
    _creationTime: Date.UTC(2026, 4, 21, 15, 30),
    adminProfileId: 'demo_admin_profile' as Id<'profiles'>,
    adminEmail: 'admin@dev.local',
    adminName: 'Sherlock Admin',
    action: 'COMPANY_VERIFY',
    targetType: 'COMPANY',
    targetId: 'demo_company_profile',
    demoNoteKey: 'companyVerified',
  },
  {
    _id: 'demo_audit_log_kyc_approved' as Id<'adminAuditLogs'>,
    _creationTime: Date.UTC(2026, 4, 21, 14, 0),
    adminProfileId: 'demo_admin_profile' as Id<'profiles'>,
    adminEmail: 'admin@dev.local',
    adminName: 'Sherlock Admin',
    action: 'KYC_APPROVE',
    targetType: 'PROFILE',
    targetId: 'demo_company_owner',
    demoNoteKey: 'kycApproved',
  },
]

const DEMO_AUDIT_STATS: AuditStats = {
  totalLogs: DEMO_AUDIT_LOGS.length,
  totalLogsCapped: false,
  recentLogs: DEMO_AUDIT_LOGS.length,
  byCategory: {
    user: 1,
    kyc: 1,
  },
}
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { User, FileText, Shield, Building2, FileCheck } from 'lucide-react'

// ===== ACTION LABELS =====
// Las acciones que esta pantalla sabe pintar con etiqueta y color. Es un
// subconjunto declarado del catálogo del backend, no una segunda verdad.
const RenderedActionSchema = Schema.Literals([
  'USER_ROLE_CHANGE',
  'USER_VERIFICATION_CHANGE',
  'USER_STATUS_CHANGE',
  'USER_DELETE',
  'KYC_APPROVE',
  'KYC_REJECT',
  'KYC_REQUEST_REVISION',
  'NDA_REVOKE',
  'NDA_TEMPLATE_CREATE',
  'NDA_TEMPLATE_UPDATE',
  'NDA_TEMPLATE_DELETE',
  'COMPANY_VERIFY',
  'COMPANY_UNVERIFY',
  'COMPANY_VISIBILITY_CHANGE',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_METADATA_UPDATE',
  'DOCUMENT_ARCHIVE',
  'SEED_DATA',
  'SYSTEM_CONFIG_CHANGE',
])

type RenderedAction = typeof RenderedActionSchema.Type

const decodeRenderedAction = Schema.decodeUnknownOption(RenderedActionSchema)

// Las que el filtro ofrece: un subconjunto del subconjunto, y el tipo lo fija.
const FILTERABLE_ACTIONS: readonly RenderedAction[] = [
  'USER_ROLE_CHANGE',
  'KYC_APPROVE',
  'KYC_REJECT',
  'NDA_REVOKE',
]

const actionStyles: Record<RenderedAction, string> = {
  USER_ROLE_CHANGE: 'bg-primary/10 text-primary',
  USER_VERIFICATION_CHANGE: 'bg-success/10 text-success',
  USER_STATUS_CHANGE: 'bg-warning/10 text-warning',
  USER_DELETE: 'bg-destructive/10 text-destructive',
  KYC_APPROVE: 'bg-success/10 text-success',
  KYC_REJECT: 'bg-destructive/10 text-destructive',
  KYC_REQUEST_REVISION: 'bg-warning/10 text-warning',
  NDA_REVOKE: 'bg-destructive/10 text-destructive',
  NDA_TEMPLATE_CREATE: 'bg-success/10 text-success',
  NDA_TEMPLATE_UPDATE: 'bg-primary/10 text-primary',
  NDA_TEMPLATE_DELETE: 'bg-destructive/10 text-destructive',
  COMPANY_VERIFY: 'bg-success/10 text-success',
  COMPANY_UNVERIFY: 'bg-warning/10 text-warning',
  COMPANY_VISIBILITY_CHANGE: 'bg-accent/10 text-accent',
  DOCUMENT_UPLOAD: 'bg-success/10 text-success',
  DOCUMENT_METADATA_UPDATE: 'bg-primary/10 text-primary',
  DOCUMENT_ARCHIVE: 'bg-destructive/10 text-destructive',
  SEED_DATA: 'bg-accent/10 text-accent',
  SYSTEM_CONFIG_CHANGE: 'bg-muted text-muted-foreground',
}

// ===== TARGET TYPE ICONS =====
const IconedTargetTypeSchema = Schema.Literals([
  'USER',
  'PROFILE',
  'COMPANY',
  'NDA',
  'NDA_TEMPLATE',
  'DOCUMENT',
  'SYSTEM',
])

type IconedTargetType = typeof IconedTargetTypeSchema.Type

const decodeIconedTargetType = Schema.decodeUnknownOption(IconedTargetTypeSchema)

const targetTypeIcons: Record<IconedTargetType, React.ReactNode> = {
  USER: <User className="h-4 w-4" />,
  PROFILE: <User className="h-4 w-4" />,
  COMPANY: <Building2 className="h-4 w-4" />,
  NDA: <FileCheck className="h-4 w-4" />,
  NDA_TEMPLATE: <FileCheck className="h-4 w-4" />,
  DOCUMENT: <FileText className="h-4 w-4" />,
  SYSTEM: <Shield className="h-4 w-4" />,
}

// El `<Select>` de destino ofrece 'all' más un subconjunto de los que tienen
// ícono. La lista queda acá, una sola vez.
const FILTERABLE_TARGET_TYPES: readonly IconedTargetType[] = [
  'USER',
  'PROFILE',
  'COMPANY',
  'NDA',
]

// ===== CAPPED STAT DISPLAY =====
// `adminAuditLogs.getStats` bounds its historical count probe (TOTAL_LOGS_CAP)
// and returns `totalLogsCapped` when the real total exceeds it. When capped,
// the total below is honest about being a floor, not an exact count: it
// renders with a "+" suffix plus an explanatory title/aria-label. When not
// capped, rendering is unchanged (bare number, no wrapper).
function CappedStat({
  value,
  capped,
  tooltip,
}: {
  value: number
  capped: boolean
  tooltip: string
}) {
  if (!capped) return <>{value}</>
  return (
    <span title={tooltip} aria-label={`${value}+ — ${tooltip}`}>
      {value}+
    </span>
  )
}

export function AuditLogsClient() {
  const locale = useLocale()
  const tPage = useTranslations('admin.auditLogs')
  const t = useTranslations('admin.auditLogs.filters')
  const tStats = useTranslations('admin.auditLogs.stats')
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>('all')

  // Paginación nativa de Convex: el server expone paginationOpts y el hook
  // acumula las páginas; "Cargar más" pide la siguiente con loadMore(50).
  const {
    results: liveLogs,
    status: liveStatus,
    loadMore,
  } = usePaginatedQuery(
    adminAuditLogsApi?.list,
    DEV_AUTH_ENABLED
      ? 'skip'
      : {
          action: actionFilter !== 'all' ? actionFilter : undefined,
          targetType: targetTypeFilter !== 'all' ? targetTypeFilter : undefined,
        },
    { initialNumItems: 50 }
  )

  const statsQuery = useQuery(adminAuditLogsApi?.getStats, DEV_AUTH_ENABLED ? 'skip' : {})
  const demoLogs = DEMO_AUDIT_LOGS.filter((log) => {
    if (actionFilter !== 'all' && log.action !== actionFilter) return false
    if (targetTypeFilter !== 'all' && log.targetType !== targetTypeFilter) return false
    return true
  })
  const logs: AuditLogItem[] | undefined = DEV_AUTH_ENABLED
    ? demoLogs
    : liveStatus === 'LoadingFirstPage'
      ? undefined
      : (liveLogs as AuditLogItem[])
  const canLoadMore = !DEV_AUTH_ENABLED && liveStatus === 'CanLoadMore'
  const isLoadingMore = !DEV_AUTH_ENABLED && liveStatus === 'LoadingMore'
  const stats: AuditStats | undefined = DEV_AUTH_ENABLED ? DEMO_AUDIT_STATS : statsQuery

  // El encabezado lo pinta `/admin/security`, que es una pantalla de dos
  // pestañas: aquí un h1 propio sería el segundo de la página. El aviso de la
  // muestra local se queda, que es lo único que este panel tiene que declarar.
  return (
    <div className="space-y-8">
      {DEV_AUTH_ENABLED ? (
        <p className="text-muted-foreground text-sm">{tPage('demoSnapshot')}</p>
      ) : null}

      {/* ===== STATS CARDS ===== */}
      {stats === undefined ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {tStats('total')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <CappedStat
                  value={stats.totalLogs}
                  capped={stats.totalLogsCapped}
                  tooltip={tStats('cappedTooltip', { count: stats.totalLogs })}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {tStats('recent')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.recentLogs}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {tStats('user')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.byCategory.user}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {tStats('kyc')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.byCategory.kyc}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== FILTERS ===== */}
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row">
          <div className="w-full sm:w-48">
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger>
                <SelectValue placeholder={t('actionPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allActions')}</SelectItem>
                {FILTERABLE_ACTIONS.map((action) => (
                  <SelectItem key={action} value={action}>
                    {tPage(`filterOptions.${action}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full sm:w-48">
            <Select value={targetTypeFilter} onValueChange={setTargetTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder={t('targetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {['all', ...FILTERABLE_TARGET_TYPES].map((targetType) => (
                  <SelectItem key={targetType} value={targetType}>
                    {tPage(`targetTypes.${targetType}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ===== LOGS TABLE ===== */}
      <Card>
        <CardHeader>
          <CardTitle>{tPage('table.title')}</CardTitle>
          <CardDescription>
            {logs === undefined
              ? tPage('table.loading')
              : tPage('table.count', { count: logs.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logs === undefined ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center">{tPage('empty')}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tPage('table.date')}</TableHead>
                  <TableHead>{tPage('table.admin')}</TableHead>
                  <TableHead>{tPage('table.action')}</TableHead>
                  <TableHead>{tPage('table.target')}</TableHead>
                  <TableHead>{tPage('table.notes')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: AuditLogItem) => {
                  // La acción llega como `string` desde la base: se decodifica
                  // contra el catálogo que esta pantalla sabe pintar. Fuera de
                  // él, el enum en crudo con estilo neutro — visible, no roto.
                  const renderedAction = decodeRenderedAction(log.action)
                  const known = renderedAction._tag === 'Some'
                  const actionLabel = known ? tPage(`actions.${renderedAction.value}`) : log.action
                  const actionColor = known
                    ? actionStyles[renderedAction.value]
                    : 'bg-muted text-muted-foreground'
                  const targetType = decodeIconedTargetType(log.targetType)

                  return (
                    <TableRow key={log._id}>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDateTime(log._creationTime, locale, '-')}
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{log.adminName}</span>
                      </TableCell>
                      <TableCell>
                        <Badge className={actionColor}>{actionLabel}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {targetType._tag === 'Some' ? targetTypeIcons[targetType.value] : null}
                          <span className="text-sm">{log.targetType}</span>
                          {log.targetId && (
                            <span className="text-muted-foreground text-xs">
                              ({log.targetId.slice(0, 8)}...)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-xs truncate text-sm">
                        {log.demoNoteKey
                          ? tPage(`demoNotes.${log.demoNoteKey}`)
                          : (log.notes ?? '-')}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          {(canLoadMore || isLoadingMore) && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => loadMore(50)}
                disabled={isLoadingMore}
                data-testid="audit-logs-load-more"
              >
                {isLoadingMore ? tPage('loadingMore') : tPage('loadMore')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
