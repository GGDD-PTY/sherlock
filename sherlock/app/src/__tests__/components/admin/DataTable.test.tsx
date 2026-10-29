// ============================================================================
// DATA TABLE — EL CONTRATO QUE COMPARTEN LAS CUATRO LISTAS ADMIN
// ============================================================================
// Cuatro pantallas del panel pintan sus filas con este componente. Lo que se
// pinea acá es lo que ninguna puede perder: el nombre accesible de la tabla, el
// orden por columna sobre las filas cargadas, el filtro de texto del cliente,
// el botón del cursor de Convex y la línea del estado vacío.
// ============================================================================

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DataTable, type DataTableColumn } from '@/components/admin/DataTable'

interface Fila {
  id: string
  empresa: string
  pais: string
}

const FILAS: Fila[] = [
  { id: '1', empresa: 'Cementos del Canal, S. A.', pais: 'Panamá' },
  { id: '2', empresa: 'Agroindustrias del Istmo, S. A.', pais: 'Panamá' },
  { id: '3', empresa: 'Naviera Bocas del Toro, S. A.', pais: 'Costa Rica' },
]

const COLUMNAS: DataTableColumn<Fila>[] = [
  {
    id: 'empresa',
    header: 'Empresa',
    accessorFn: (fila) => fila.empresa,
    cell: ({ row }) => <span>{row.original.empresa}</span>,
  },
  {
    id: 'pais',
    header: 'País',
    accessorFn: (fila) => fila.pais,
    cell: ({ row }) => <span>{row.original.pais}</span>,
  },
  {
    id: 'acciones',
    header: 'Acciones',
    enableSorting: false,
    cell: ({ row }) => <button type="button">Abrir {row.original.id}</button>,
  },
]

function nombresDeFilas(): string[] {
  const cuerpo = screen.getAllByRole('rowgroup')[1]
  return within(cuerpo)
    .getAllByRole('row')
    .map((fila) => within(fila).getAllByRole('cell')[0].textContent ?? '')
}

describe('DataTable', () => {
  it('nombra la tabla y pinta una fila por dato', () => {
    render(<DataTable ariaLabel="Pipeline de empresas" columns={COLUMNAS} data={FILAS} />)

    expect(screen.getByRole('table', { name: 'Pipeline de empresas' })).toBeInTheDocument()
    expect(nombresDeFilas()).toEqual(FILAS.map((fila) => fila.empresa))
  })

  it('ordena por la columna que el equipo toca, y la columna sin orden no ofrece botón', async () => {
    render(<DataTable ariaLabel="Pipeline de empresas" columns={COLUMNAS} data={FILAS} />)

    const encabezadoEmpresa = screen.getByRole('columnheader', { name: /Empresa/ })
    expect(encabezadoEmpresa).toHaveAttribute('aria-sort', 'none')

    await userEvent.click(within(encabezadoEmpresa).getByRole('button'))
    expect(encabezadoEmpresa).toHaveAttribute('aria-sort', 'ascending')
    expect(nombresDeFilas()[0]).toBe('Agroindustrias del Istmo, S. A.')

    await userEvent.click(within(encabezadoEmpresa).getByRole('button'))
    expect(encabezadoEmpresa).toHaveAttribute('aria-sort', 'descending')
    expect(nombresDeFilas()[0]).toBe('Naviera Bocas del Toro, S. A.')

    const encabezadoAcciones = screen.getByRole('columnheader', { name: 'Acciones' })
    expect(encabezadoAcciones).not.toHaveAttribute('aria-sort')
    expect(within(encabezadoAcciones).queryByRole('button')).not.toBeInTheDocument()
  })

  it('filtra las filas cargadas con el texto que recibe', () => {
    const { rerender } = render(
      <DataTable ariaLabel="Pipeline de empresas" columns={COLUMNAS} data={FILAS} filterText="" />
    )
    expect(nombresDeFilas()).toHaveLength(3)

    rerender(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        filterText="bocas"
      />
    )
    expect(nombresDeFilas()).toEqual(['Naviera Bocas del Toro, S. A.'])

    rerender(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        filterText="costa rica"
      />
    )
    expect(nombresDeFilas()).toEqual(['Naviera Bocas del Toro, S. A.'])
  })

  it('pide la página siguiente mientras el cursor tenga una, y no antes', async () => {
    const onLoadMore = vi.fn(() => {})
    const { rerender } = render(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        pagination={{ status: 'CanLoadMore', onLoadMore }}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Cargar más' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    rerender(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        pagination={{ status: 'LoadingMore', onLoadMore }}
      />
    )
    expect(screen.getByRole('button', { name: 'Cargando...' })).toBeDisabled()

    rerender(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        pagination={{ status: 'Exhausted', onLoadMore }}
      />
    )
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument()

    // Un estado que no está en el catálogo no pinta un botón que no hace nada.
    rerender(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        pagination={{ status: 'AlgoNuevo', onLoadMore }}
      />
    )
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument()
  })

  it('dice en una línea que no hay filas, con el texto de la pantalla o el del catálogo', () => {
    const { rerender } = render(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={[]}
        emptyMessage="No se encontraron empresas"
      />
    )

    expect(screen.getByText('No se encontraron empresas')).toBeInTheDocument()
    expect(nombresDeFilas()).toEqual(['No se encontraron empresas'])

    rerender(<DataTable ariaLabel="Pipeline de empresas" columns={COLUMNAS} data={[]} />)
    expect(screen.getByText('No hay filas que mostrar')).toBeInTheDocument()
  })

  it('pone en cada fila el id que la pantalla le pide, para enlazarla desde afuera', () => {
    render(
      <DataTable
        ariaLabel="Pipeline de empresas"
        columns={COLUMNAS}
        data={FILAS}
        rowId={(fila) => `company-${fila.id}`}
      />
    )

    expect(screen.getByText('Cementos del Canal, S. A.').closest('tr')).toHaveAttribute(
      'id',
      'company-1'
    )
  })
})
