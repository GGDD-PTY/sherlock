'use client'

// ============================================================================
// ADMIN COMPANIES CLIENT COMPONENT
// ============================================================================
// Tabla de empresas con filtros y acciones de administración
//
// ===== APROBAR MATERIAL PARA COMPARTIR ES UNA ACCIÓN DE NEGOCIO =====
// El único handler de la pantalla cambia qué material de una empresa se puede
// compartir afuera. Fallaba con un `toast.error('No se pudo actualizar la
// visibilidad')` que tapaba tanto «no tienes permiso» como «esta empresa no
// tiene material aprobado todavía». Ahora es un programa con nombre y el aviso
// dice lo que el backend redactó.
// ============================================================================

import { Link } from '@/i18n/navigation'
import { useEffect, useState } from 'react'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { Effect, Schema } from 'effect'
import { toast } from 'sonner'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import { formatShortDate, getInitials } from '@/lib/utils'
import { countryNames, type CountryCode } from '@/lib/constants'
import { getCountryLabel } from '@/lib/constants/countries'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { DEMO_PUBLIC_COMPANIES } from '@/lib/dev-auth/demo-data'
import { useDevAuthFixtures } from '@/lib/dev-auth/local-convex-identity'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Search,
  MoreHorizontal,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  FolderOpen,
  MapPin,
} from 'lucide-react'
import { runClientEffect } from '@/lib/effect/client-runtime'

// ============================================================================
// TIPOS
// ============================================================================

// getCountryLabel cubre el catálogo de lanzamiento y alias como «Panama».
// countryNames cubre códigos extra (US, ES, UY, DO) que ese catálogo no trae.
const CountryCodeSchema = Schema.Literals(
  Object.keys(countryNames) as [CountryCode, ...CountryCode[]]
)
const decodeCountryCode = Schema.decodeUnknownOption(CountryCodeSchema)

function countryLabel(code: string): string {
  const labeled = getCountryLabel(code)
  if (labeled !== code) return labeled
  const decoded = decodeCountryCode(code)
  return decoded._tag === 'Some' ? countryNames[decoded.value] : code
}

type AdminCompany = {
  _id: string
  _creationTime: number
  name: string
  legalName?: string
  country: string
  city?: string
  industry?: string
  logoUrl?: string
  isVerified?: boolean
  isFeatured?: boolean
  isPublic?: boolean
  onboardingStep?: number
  ownerEmail?: string | null
}

/** Filas por página del cursor admin. */
const COMPANIES_PAGE_SIZE = 20

const DEMO_ADMIN_COMPANIES: AdminCompany[] = DEMO_PUBLIC_COMPANIES.map((company, index) => ({
  ...company,
  isPublic: index > 1,
  isVerified: index !== 1 && company.isVerified,
  isFeatured: index > 1 && company.isFeatured,
  onboardingStep: index === 0 ? 4 : company.onboardingStep,
}))

const copy = {
  total: 'Total empresas',
  inReview: 'Revisión del equipo',
  live: 'Materiales aprobados',
  search: 'Buscar por nombre, razón social, industria, país o email...',
  tableTitle: 'Pipeline de empresas',
  tableDescription:
    'Cola completa de empresas beta, incluyendo registros pendientes de revisión del equipo.',
  empty: 'No se encontraron empresas',
  company: 'Empresa',
  industry: 'Industria',
  country: 'País',
  status: 'Estado',
  registered: 'Registrada',
  actions: 'Acciones',
  review: 'Revisión',
  liveTeaser: 'Material aprobado para compartir',
  verified: 'Verificada',
  openDataRoom: 'Abrir sala (VDR)',
  actionsLabel: 'Acciones de empresa',
  demoQueueDescription:
    'En modo dev-auth se muestran empresas de ejemplo. Los registros privados reales siguen requiriendo auth admin de WorkOS/Convex.',
  sessionRequiredTitle: 'Se requiere sesión admin de Convex',
  sessionRequiredDescription:
    'La cola de revisión de empresas es solo para admin. Inicia sesión con WorkOS/Convex admin o sincroniza el entorno dev de Convex antes de cargar registros privados.',
  publishTeaser: 'Aprobar material para compartir',
  unpublishTeaser: 'Retirar aprobación para compartir',
  publishConfirm: (name: string) => `¿Aprobar el material revisado de "${name}" para compartir?`,
  unpublishConfirm: (name: string) => `¿Retirar la aprobación para compartir de "${name}"?`,
  visibilityUpdated: 'Visibilidad actualizada',
  visibilityError: 'No se pudo actualizar la visibilidad',
  visibilityDemo: 'Modo demo: los cambios de visibilidad no se persisten',
}

// ============================================================================
// CIFRAS
// ============================================================================

/** Cifra display como en la vista general: eyebrow + Fraunces 32 tabular. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="font-display mt-2 text-[2rem] leading-tight tabular-nums">{value}</dd>
    </div>
  )
}

// ===== COLUMNAS =====
// Viven fuera del componente: una función que devuelve JSX declarada dentro de
// otro componente se remonta en cada render (`react/no-unstable-nested-components`).
// El texto buscado lo filtra la `DataTable` sobre estas columnas, así que la
// columna «Empresa» lleva la razón social en su valor y la celda pinta solo el
// nombre comercial.
function companyColumns(
  t: typeof copy,
  dateLocale: string,
  onToggleVisibility: (company: AdminCompany) => void
): DataTableColumn<AdminCompany>[] {
  return [
    {
      id: 'company',
      header: t.company,
      accessorFn: (company) =>
        [company.name, company.legalName, company.ownerEmail].filter(Boolean).join(' '),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            <AvatarImage src={row.original.logoUrl} />
            <AvatarFallback>{getInitials(row.original.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <span className="font-medium">{row.original.name}</span>
            {row.original.ownerEmail ? (
              <p className="text-muted-foreground text-xs">{row.original.ownerEmail}</p>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      id: 'industry',
      header: t.industry,
      // La industria es texto libre ([F] 2026-09-17): la celda pinta lo que la
      // empresa escribió, y el valor de la columna es ese mismo texto, así el
      // orden y la búsqueda coinciden con lo que el equipo lee.
      accessorFn: (company) => company.industry ?? '',
      cell: ({ row }) => row.original.industry || '-',
    },
    {
      id: 'country',
      header: t.country,
      accessorFn: (company) => countryLabel(company.country),
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <MapPin aria-hidden="true" className="text-muted-foreground h-3 w-3" />
          {countryLabel(row.original.country)}
        </div>
      ),
    },
    {
      id: 'status',
      header: t.status,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex gap-2">
          {row.original.isPublic ? (
            <Badge variant="outline" className="text-primary">
              <Eye className="mr-1 h-3 w-3" />
              {t.liveTeaser}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-warning">
              <Clock3 className="mr-1 h-3 w-3" />
              {t.review}
            </Badge>
          )}
          {row.original.isVerified && (
            <Badge variant="outline" className="text-primary">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              {t.verified}
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: 'registered',
      header: t.registered,
      // Fuera del filtro de texto: el sello de tiempo es un número y
      // cualquier dígito buscado lo haría coincidir.
      enableGlobalFilter: false,
      accessorFn: (company) => company._creationTime,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatShortDate(row.original._creationTime, dateLocale)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t.actions,
      enableSorting: false,
      meta: { headClassName: 'text-right', cellClassName: 'text-right' },
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t.actionsLabel}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* El equipo arma el data room del cliente: la sala se abre con el
                companyId de la fila, no con el de la sesión. Convex re-verifica
                el rol ADMIN. */}
            <DropdownMenuItem asChild>
              <Link href={`/admin/companies/${row.original._id}/documents`}>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t.openDataRoom}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onToggleVisibility(row.original)}>
              {row.original.isPublic ? (
                <>
                  <EyeOff className="mr-2 h-4 w-4" />
                  {t.unpublishTeaser}
                </>
              ) : (
                <>
                  <Eye className="mr-2 h-4 w-4" />
                  {t.publishTeaser}
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function AdminCompaniesClient() {
  const t = copy
  const [searchTerm, setSearchTerm] = useState('')
  const adminQueryDisabled = useDevAuthFixtures(undefined, DEV_AUTH_ENABLED)
  const isUsingDemoQueue = adminQueryDisabled

  // ===== LA COLA PAGINA POR CURSOR =====
  // `listAdminCompanies` traía la tabla entera en cada carga del panel. La
  // página la pide el cursor de Convex y el resto llega por «Cargar más».
  const {
    results: companies,
    status: companiesStatus,
    loadMore,
  } = usePaginatedQuery(
    api.companies.listAdminCompaniesPaginated,
    adminQueryDisabled ? 'skip' : {},
    { initialNumItems: COMPANIES_PAGE_SIZE }
  )
  const setCompanyVisibility = useMutation(api.companies.setCompanyVisibility)

  // El texto buscado filtra las filas ya cargadas: una empresa que coincide y
  // vive en una página que el cursor todavía no trajo no existiría para el
  // equipo. Mientras haya búsqueda se piden las páginas siguientes hasta agotar
  // el cursor —igual que hacía el `.collect()` de antes, pero solo al buscar—;
  // sin búsqueda la cola se queda en su primera página. El propio `status` corta
  // el ciclo: pasa a `LoadingMore` y termina en `Exhausted`.
  useEffect(() => {
    if (!searchTerm || companiesStatus !== 'CanLoadMore') return
    loadMore(COMPANIES_PAGE_SIZE)
  }, [companiesStatus, loadMore, searchTerm])

  // ===== TOGGLE VISIBILIDAD (admin-only, auditada en backend) =====
  const handleToggleVisibility = (company: AdminCompany) => {
    const nextIsPublic = !company.isPublic
    const confirmed = window.confirm(
      nextIsPublic ? t.publishConfirm(company.name) : t.unpublishConfirm(company.name)
    )
    if (!confirmed) return

    if (isUsingDemoQueue) {
      toast.info(t.visibilityDemo)
      return
    }

    const companyId = company._id as Id<'companies'>
    void runClientEffect(
      adminStep(
        'AdminCompanies.setVisibility',
        'companies.setCompanyVisibility',
        t.visibilityError,
        () => setCompanyVisibility({ companyId, isPublic: nextIsPublic })
      ).pipe(
        Effect.tap(() => Effect.sync(() => toast.success(t.visibilityUpdated))),
        Effect.catch((failure: AdminActionError) =>
          Effect.logError(`[AdminCompaniesClient] ${failure.action} falló en ${failure.step}`).pipe(
            Effect.andThen(Effect.sync(() => toast.error(failure.message)))
          )
        )
      )
    )
  }

  // ===== LOADING STATE =====
  if (!adminQueryDisabled && companiesStatus === 'LoadingFirstPage') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const companyRows: AdminCompany[] = isUsingDemoQueue ? DEMO_ADMIN_COMPANIES : companies
  const dateLocale = 'es-PA'

  const columns = companyColumns(t, dateLocale, handleToggleVisibility)

  // ===== STATS =====
  // Las cifras cuentan lo cargado, no la tabla entera: con el cursor abierto se
  // marcan con «+», la misma convención de la cola del Data Room.
  const loadedCount = (count: number) =>
    isUsingDemoQueue || companiesStatus === 'Exhausted' ? String(count) : `${count}+`
  const stats = {
    total: loadedCount(companyRows.length),
    inReview: loadedCount(companyRows.filter((c: AdminCompany) => !c.isPublic).length),
    live: loadedCount(companyRows.filter((c: AdminCompany) => c.isPublic).length),
  }

  // El aviso de la cola demo era una tarjeta sobre las cifras; ahora es la línea
  // que sigue al subtítulo de la página, y solo con dev-auth ([F] 2026-09-11).
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {isUsingDemoQueue && (
        <p className="text-muted-foreground text-sm">{t.demoQueueDescription}</p>
      )}

      {/* ===== FIGURES ===== */}
      <dl className="border-border-hairline grid grid-cols-2 gap-6 border-t pt-4 sm:grid-cols-3">
        <Figure label={t.total} value={stats.total} />
        <Figure label={t.inReview} value={stats.inReview} />
        <Figure label={t.live} value={stats.live} />
      </dl>

      {/* ===== SEARCH ===== */}
      <div className="relative max-w-md">
        <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input
          placeholder={t.search}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* ===== COMPANIES TABLE ===== */}
      <section className="border-border-hairline flex min-h-0 flex-1 flex-col gap-3 border-t pt-4">
        <div>
          <h2 className="font-sans text-lg font-semibold tracking-normal">
            {t.tableTitle} ({loadedCount(companyRows.length)})
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t.tableDescription}</p>
        </div>
        <DataTable
          ariaLabel={t.tableTitle}
          columns={columns}
          data={companyRows}
          emptyMessage={t.empty}
          fillHeight
          filterText={searchTerm}
          rowId={(company) => `company-${company._id}`}
          {...(isUsingDemoQueue
            ? {}
            : {
                pagination: {
                  status: companiesStatus,
                  onLoadMore: () => loadMore(COMPANIES_PAGE_SIZE),
                },
              })}
        />
      </section>
    </div>
  )
}
