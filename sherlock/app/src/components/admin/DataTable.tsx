'use client'

// ============================================================================
// DATA TABLE — LA TABLA DEL PANEL DEL EQUIPO
// ============================================================================
// Cuatro listas admin pintaban su propia tabla a mano: cada una con su
// encabezado, su estado vacío, su botón «Cargar más» y su idea de qué se puede
// ordenar. Eran cuatro contratos distintos sobre el mismo primitivo, así que
// una columna ordenable en una pantalla no existía en la de al lado.
//
// Acá viven una sola vez: columnas tipadas (`DataTableColumn<T>`), orden por
// columna sobre las filas ya cargadas, filtro de texto del lado del cliente
// cuando el llamador lo pide, y el cursor de Convex detrás del mismo botón.
// Sin virtualización y sin tarjeta alrededor: la tabla es el bloque.
// ============================================================================

import { Schema } from 'effect'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  flexRender,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortDirection,
  type SortingState,
} from '@tanstack/react-table'

import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

// El juego de features se arma una vez, fuera del componente: `tableFeatures`
// es estático por diseño en la v9 y de él sale el tipo de `ColumnDef`.
const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  // Slot de tipo: el valor es fantasma y se borra en runtime. Alinear una
  // columna a la derecha o darle un ancho mínimo deja de ser un `as` en la
  // celda y pasa a ser parte de la definición de la columna.
  columnMeta: {} as { headClassName?: string; cellClassName?: string },
})

/** La columna que escribe cada pantalla: tipada contra su propia fila. */
export type DataTableColumn<TRow extends RowData> = ColumnDef<typeof dataTableFeatures, TRow>

// `usePaginatedQuery` devuelve su `status` como string. Se decodifica contra el
// catálogo en vez de castearlo: un estado que no conocemos no pinta botón, en
// lugar de pintar uno que no hace nada.
const PaginationStatusSchema = Schema.Literals([
  'LoadingFirstPage',
  'CanLoadMore',
  'LoadingMore',
  'Exhausted',
])
const decodePaginationStatus = Schema.decodeUnknownOption(PaginationStatusSchema)

interface DataTablePagination {
  /** El `status` de `usePaginatedQuery` de Convex. */
  status: string
  /** El `loadMore` de `usePaginatedQuery`, con el tamaño de página ya aplicado. */
  onLoadMore: () => void
}

interface DataTableProps<TRow extends RowData> {
  /** Obligatorio: nombra la tabla para lectores de pantalla y para el foco. */
  ariaLabel: string
  columns: DataTableColumn<TRow>[]
  data: TRow[]
  /** Una línea cuando no hay filas. Sin ella se usa la del catálogo. */
  emptyMessage?: string
  /**
   * La tabla toma el alto que le deja la pantalla y las filas scrollean por
   * dentro, con la cabecera pegada arriba. Sin esto la página crece con cada
   * fila y pasa de 900 px a 1440x900 ([F] 2026-09-11, tarjeta O1-05).
   */
  fillHeight?: boolean
  /** Filtro de texto sobre las filas cargadas. Sin él, filtra el servidor. */
  filterText?: string
  initialSorting?: SortingState
  pagination?: DataTablePagination
  /** El `id` del `<tr>`, para enlazar una fila desde afuera. */
  rowId?: (row: TRow) => string
}

function sortIndicator(direction: false | SortDirection) {
  if (direction === 'asc') return <ArrowUp aria-hidden="true" className="h-3 w-3" />
  if (direction === 'desc') return <ArrowDown aria-hidden="true" className="h-3 w-3" />
  return <ChevronsUpDown aria-hidden="true" className="h-3 w-3 opacity-40" />
}

function ariaSort(direction: false | SortDirection) {
  if (direction === 'asc') return 'ascending' as const
  if (direction === 'desc') return 'descending' as const
  return 'none' as const
}

export function DataTable<TRow extends RowData>({
  ariaLabel,
  columns,
  data,
  emptyMessage,
  fillHeight,
  filterText,
  initialSorting,
  pagination,
  rowId,
}: DataTableProps<TRow>) {
  const t = useTranslations('admin.table')
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? [])

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    state: { sorting, globalFilter: filterText ?? '' },
    onSortingChange: setSorting,
    globalFilterFn: filterFn_includesString,
    ...(rowId ? { getRowId: rowId } : {}),
  })

  const status = decodePaginationStatus(pagination?.status)
  const canLoadMore = status._tag === 'Some' && status.value === 'CanLoadMore'
  const isLoadingMore = status._tag === 'Some' && status.value === 'LoadingMore'
  const rows = table.getRowModel().rows

  return (
    <div className={cn('space-y-3', fillHeight && 'flex min-h-0 flex-1 flex-col')}>
      <Table
        aria-label={ariaLabel}
        {...(fillHeight ? { containerClassName: 'min-h-0 flex-1 overflow-y-auto' } : {})}
      >
        <TableHeader className={cn('bg-secondary', fillHeight && 'sticky top-0 z-10')}>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted()
                const label = header.column.columnDef.header
                const content = header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())

                return (
                  <TableHead
                    key={header.id}
                    aria-sort={header.column.getCanSort() ? ariaSort(sorted) : undefined}
                    className={cn('py-2', header.column.columnDef.meta?.headClassName)}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="text-foreground hover:text-primary inline-flex items-center gap-1"
                        onClick={header.column.getToggleSortingHandler()}
                        title={typeof label === 'string' ? t('sort', { column: label }) : undefined}
                      >
                        {content}
                        {sortIndicator(sorted)}
                      </button>
                    ) : (
                      content
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                allowWrap
                className="text-muted-foreground py-6 text-center"
                colSpan={columns.length}
              >
                {emptyMessage ?? t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id} {...(rowId ? { id: row.id } : {})}>
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn('py-2', cell.column.columnDef.meta?.cellClassName)}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {(canLoadMore || isLoadingMore) && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={pagination?.onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? t('loadingMore') : t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
