// ============================================================================
// NAVIGATION REGISTRY — VISIBILIDAD POR ROL Y PLACEMENT
// ============================================================================
// Contratos del registry de navegación:
// - La sala propia se nombra por su destino ([F] 2026-09-07 09:00): «Data
//   Room» → `/my-company/documents` para la empresa, «Panel» → `/admin` para
//   el equipo. «Cuenta» es el menú de la persona (configuración, tema, cerrar
//   sesión) y ya no etiqueta la sala.
// - `/dashboard` salió del navbar y después del árbol: solo redirigía a esas
//   mismas salas ([F] 2026-09-07 09:00).
// - El item público «Data Room» apunta a la capa de subida de la landing:
//   `/data-room` era otra página que solo redirigía.
// - La empresa (COMPANY) alcanza sus dos destinos vivos desde el user-menu:
//   su sala y settings.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  ADMIN_SIDEBAR_SECTIONS,
  getAccountRoom,
  getVisibleNavbarSecondaryItems,
} from '@/lib/navigation/registry'
import { ADMIN_ROUTES } from '@/lib/product/admin-routes'

const visibleHrefs = (options: Parameters<typeof getVisibleNavbarSecondaryItems>[0]) =>
  getVisibleNavbarSecondaryItems(options).map((item) => item.href)

describe('getAccountRoom', () => {
  it('lleva a cada rol a su propia sala, nombrada por su destino', () => {
    expect(getAccountRoom({ isCompany: true, isAdmin: false })).toMatchObject({
      href: '/my-company/documents',
      labelKey: 'dataRoom',
    })
    expect(getAccountRoom({ isCompany: false, isAdmin: true })).toMatchObject({
      href: '/admin',
      labelKey: 'teamPanel',
    })
  })

  // El navbar ofrece la sala apenas resuelve la sesión, antes del perfil de
  // Convex. Sin rol todavía no hay sala que nombrar y el home público es el
  // único destino que existe: `/dashboard` se borró ([F] 2026-09-07 09:00).
  it('cae en el home público como «Cuenta» mientras el rol no se conoce', () => {
    expect(getAccountRoom({ isCompany: false, isAdmin: false })).toMatchObject({
      href: '/',
      labelKey: 'account',
    })
  })
})

describe('getVisibleNavbarSecondaryItems', () => {
  it('no ofrece destinos de sesión a visitantes sin rol (shell PUBLIC)', () => {
    for (const placement of ['mobile', 'desktop', 'user-menu'] as const) {
      const hrefs = visibleHrefs({ isCompany: false, isAdmin: false, placement })
      expect(hrefs).not.toContain('/dashboard')
      expect(hrefs).not.toContain('/admin')
      expect(hrefs).not.toContain('/my-company/documents')
    }
  })

  it('retira /dashboard de la navegación: la sala ya tiene nombre propio', () => {
    for (const placement of ['mobile', 'desktop', 'user-menu'] as const) {
      for (const audience of [
        { isCompany: true, isAdmin: false },
        { isCompany: false, isAdmin: true },
      ]) {
        expect(visibleHrefs({ ...audience, placement })).not.toContain('/dashboard')
      }
    }
  })

  it('nombra la sala de cada rol por su destino, en cada placement', () => {
    for (const placement of ['mobile', 'desktop', 'user-menu'] as const) {
      const company = getVisibleNavbarSecondaryItems({
        isCompany: true,
        isAdmin: false,
        placement,
      }).filter((item) => item.room)
      expect(company.map((item) => [item.href, item.labelKey])).toEqual([
        ['/my-company/documents', 'dataRoom'],
      ])

      const team = getVisibleNavbarSecondaryItems({
        isCompany: false,
        isAdmin: true,
        placement,
      }).filter((item) => item.room)
      expect(team.map((item) => [item.href, item.labelKey])).toEqual([['/admin', 'teamPanel']])
    }
  })

  // «Cuenta» es del menú de la persona: ningún enlace de sala la reclama.
  it('no reclama «Cuenta» para ningún enlace de navegación', () => {
    for (const placement of ['mobile', 'desktop', 'user-menu'] as const) {
      for (const audience of [
        { isCompany: true, isAdmin: false },
        { isCompany: false, isAdmin: true },
      ]) {
        const labels = getVisibleNavbarSecondaryItems({ ...audience, placement }).map(
          (item) => item.labelKey
        )
        expect(labels).not.toContain('account')
        expect(labels).not.toContain('preferences')
      }
    }
  })

  it('agrupa settings bajo «Cuenta» en el menú compacto', () => {
    const grouped = getVisibleNavbarSecondaryItems({
      isCompany: true,
      isAdmin: false,
      placement: 'mobile',
    })
      .filter((item) => item.group === 'account')
      .map((item) => item.href)
    expect(grouped).toEqual(['/settings'])
  })

  it('la empresa ve su sala y settings — sin destinos retirados', () => {
    const hrefs = visibleHrefs({
      isCompany: true,
      isAdmin: false,
      placement: 'user-menu',
    })
    expect(hrefs).toEqual(['/my-company/documents', '/settings'])
    // Corte sell-side [F] v0.10 y perfil en la sala [F] 2026-09-07: la
    // superficie marketplace-era no vuelve al menú.
    for (const retired of [
      '/my-company/profile',
      '/my-company/edit',
      '/my-company/deals',
      '/my-investor/profile',
      '/portfolio',
      '/connections',
      '/messages',
    ]) {
      expect(hrefs, retired).not.toContain(retired)
    }
  })
})

// ============================================================================
// La barra del panel deriva del catálogo de `product/admin-routes.ts`: acá se
// prueba que lo deriva completo (1:1, sin agregar ni perder rutas) y que lo
// pinta como hoy. El rótulo y el orden son lo que el equipo ve, así que el
// literal de abajo es el contrato ([F] 2026-09-17).
// ============================================================================
describe('ADMIN_SIDEBAR_SECTIONS', () => {
  it('pinta las tres secciones con sus destinos, en orden', () => {
    expect(
      ADMIN_SIDEBAR_SECTIONS.map((section) => [
        section.title,
        section.items.map((item) => [item.href, item.label]),
      ])
    ).toEqual([
      [
        'Principal',
        [
          ['/admin', 'Panel'],
          ['/admin/companies', 'Empresas'],
          ['/admin/support', 'Soporte'],
        ],
      ],
      [
        'Monitoreo',
        [
          ['/admin/security', 'Seguridad'],
          ['/admin/gdpr', 'GDPR'],
        ],
      ],
      ['Configuración', [['/admin/workos', 'Accesos']]],
    ])
  })

  it('deriva una fila por ruta del catálogo, sin agregar ni perder ninguna', () => {
    const rows = ADMIN_SIDEBAR_SECTIONS.flatMap((section) => section.items)
    expect(rows).toHaveLength(ADMIN_ROUTES.length)

    // Una fila por ruta y ni una de más: se compara la lista de coincidencias
    // de cada ruta del catálogo contra su fila esperada, con todos los campos.
    expect(
      ADMIN_ROUTES.map((route) => rows.filter((item) => item.href === route.paths[0]))
    ).toEqual(
      ADMIN_ROUTES.map((route) => [
        {
          href: route.paths[0],
          label: route.nav.label,
          icon: route.nav.icon,
          exact: route.nav.exact,
        },
      ])
    )
  })

  // `/admin` es prefijo de las otras cinco: sin `exact` la fila del panel
  // quedaría marcada en todas las pantallas del panel a la vez.
  it('marca activo por igualdad exacta solo en /admin', () => {
    const exactHrefs = ADMIN_SIDEBAR_SECTIONS.flatMap((section) =>
      section.items.filter((item) => item.exact).map((item) => item.href)
    )
    expect(exactHrefs).toEqual(['/admin'])
  })
})
