// ============================================================================
// TESTS: Table allowWrap boundary
// ============================================================================
// `allowWrap` decide con `Schema.is(Schema.Boolean)`, no con la coerción de JS
// (`!allowWrap`). El caso que prueba la frontera es un valor que no es un
// booleano real pero sí truthy en JS ('yes'): con la coerción vieja eso
// activaba el wrap; con el guard cae al default seguro (no-wrap). Ver
// research/BUGS.md #1.
// ============================================================================

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Table, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

describe('Table labelled overflow region', () => {
  it('exposes a keyboard-reachable region when aria-label is set', () => {
    render(
      <Table aria-label="Estados financieros">
        <TableBody>
          <TableRow>
            <TableCell>Dato</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )

    const region = screen.getByRole('region', { name: 'Estados financieros' })
    expect(region).toHaveAttribute('data-slot', 'table-container')
    expect(region).toHaveAttribute('tabindex', '0')
  })

  it('does not name the container when aria-label is omitted', () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>Dato</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )

    expect(container.querySelector('[data-slot="table-container"]')).not.toHaveAttribute('role')
    expect(container.querySelector('[data-slot="table-container"]')).not.toHaveAttribute('tabindex')
  })
})

describe('TableHead allowWrap', () => {
  it('wraps by default when allowWrap is omitted (whitespace-nowrap)', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead>Encabezado</TableHead>
          </TableRow>
        </TableBody>
      </Table>
    )
    expect(screen.getByText('Encabezado')).toHaveClass('whitespace-nowrap')
  })

  it('allows wrapping when allowWrap is a real boolean true', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead allowWrap>Encabezado</TableHead>
          </TableRow>
        </TableBody>
      </Table>
    )
    expect(screen.getByText('Encabezado')).not.toHaveClass('whitespace-nowrap')
  })

  it('falls back to no-wrap on a truthy non-boolean value instead of coercing it', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead allowWrap={'yes' as unknown as boolean}>Encabezado</TableHead>
          </TableRow>
        </TableBody>
      </Table>
    )
    // Con `!allowWrap` (coerción de JS) 'yes' es truthy y esto NO tendría la
    // clase; con el guard de Schema.is, un no-booleano cae al default seguro.
    expect(screen.getByText('Encabezado')).toHaveClass('whitespace-nowrap')
  })
})

describe('TableCell allowWrap', () => {
  it('falls back to no-wrap on a truthy non-boolean value instead of coercing it', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell allowWrap={'yes' as unknown as boolean}>Dato</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )
    expect(screen.getByText('Dato')).toHaveClass('whitespace-nowrap')
  })
})
