// ============================================================================
// TESTS: CompanyRoomSectionNav — pantallas por ruta, la activa sale del pathname
// ============================================================================
// La sala es un conjunto de pantallas (docs/design-system-vdr.md). La barra
// enlaza rutas del catálogo `roomScreens` y marca la activa con
// `aria-current="page"` leyendo el pathname que entrega el router.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const mockPathname = vi.hoisted(() => ({ value: '/my-company/documents' }))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mockPathname.value,
}))

import { CompanyRoomSectionNav } from '@/components/company/CompanyRoomSections'
import { ROOM_SCREENS } from '@/components/company/roomScreens'

describe('CompanyRoomSectionNav', () => {
  afterEach(() => {
    mockPathname.value = '/my-company/documents'
    cleanup()
  })

  it('links every screen to its route and marks the current one', () => {
    mockPathname.value = '/my-company/preparation'
    render(<CompanyRoomSectionNav screens={ROOM_SCREENS} />)

    expect(screen.getByRole('link', { name: 'Preparación' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('link', { name: 'Preparación' })).toHaveAttribute(
      'href',
      '/my-company/preparation'
    )
    expect(screen.getByRole('link', { name: 'Documentos' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Equipo' })).toHaveAttribute('href', '/my-company/team')
  })

  it('shows only the screens the page passes', () => {
    render(<CompanyRoomSectionNav screens={['documents', 'preparation']} />)

    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Invitados' })).not.toBeInTheDocument()
  })

  it('marks nothing when the pathname is not a known screen', () => {
    mockPathname.value = '/settings/privacy'
    render(<CompanyRoomSectionNav screens={ROOM_SCREENS} />)

    for (const link of screen.getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current')
    }
  })

  it('scrolls the active tab into view (au-01)', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    mockPathname.value = '/my-company/preparation'
    render(<CompanyRoomSectionNav screens={ROOM_SCREENS} />)

    const link = screen.getByRole('link', { name: 'Preparación' })
    expect(link).toHaveAttribute('aria-current', 'page')
    const item = link.closest('li')
    expect(item).not.toBeNull()
    expect(scrollIntoView.mock.instances).toContain(item)
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: 'nearest', block: 'nearest' })
    )
  })
})
