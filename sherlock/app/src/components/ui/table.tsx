import * as React from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `allowWrap` llega por props y a veces de config de columnas. Un string
// truthy ('yes') no es wrap: `!allowWrap` lo trataba como verdadero. El guard
// decide con `Schema.is(Schema.Boolean)`: solo el booleano `true` quita
// `whitespace-nowrap`.
const isAllowWrap = Schema.is(Schema.Boolean)

interface TableProps extends React.ComponentProps<'table'> {
  /** Clases del contenedor con scroll: ahí se limita el alto de una lista larga. */
  containerClassName?: string
}

function Table({ className, containerClassName, 'aria-label': ariaLabel, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className={cn('relative w-full overflow-x-auto', containerClassName)}
      {...(ariaLabel ? { role: 'region' as const, 'aria-label': ariaLabel, tabIndex: 0 } : {})}
    >
      {/* El nombre va en la región (foco por teclado) y en la tabla: los
          lectores de pantalla anuncian y navegan la tabla por su nombre. */}
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        aria-label={ariaLabel}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors',
        className
      )}
      {...props}
    />
  )
}

interface TableHeadProps extends React.ComponentProps<'th'> {
  allowWrap?: boolean
}

function TableHead({ className, allowWrap, ...props }: TableHeadProps) {
  const wraps = isAllowWrap(allowWrap) ? allowWrap : false

  return (
    <th
      data-slot="table-head"
      className={cn(
        'text-foreground h-10 px-2 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0',
        !wraps && 'whitespace-nowrap',
        className
      )}
      {...props}
    />
  )
}

interface TableCellProps extends React.ComponentProps<'td'> {
  allowWrap?: boolean
}

function TableCell({ className, allowWrap, ...props }: TableCellProps) {
  const wraps = isAllowWrap(allowWrap) ? allowWrap : false

  return (
    <td
      data-slot="table-cell"
      className={cn(
        'p-2 align-middle [&:has([role=checkbox])]:pr-0',
        !wraps && 'whitespace-nowrap',
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('text-muted-foreground mt-4 text-sm', className)}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, TableCaption }
