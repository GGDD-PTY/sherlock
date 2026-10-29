import { describe, expect, it } from 'vitest'

import {
  ACTOR_CAPABILITY_MATRIX,
  CORE_WORKFLOWS,
  DASHBOARD_INVENTORY,
  DEFAULT_HOME_BY_ACTOR,
  PRODUCT_NORTH_STAR,
  PRODUCT_GAPS,
  PRODUCT_ROUTES,
  UNKNOWN_UNKNOWNS,
} from '@/lib/product/architecture'
import {
  ACTOR_ROLES,
  APP_SHELLS,
  KYC_STATUSES,
  PRODUCT_CORE_ENTITIES,
  ROUTE_SURFACES,
} from '@/lib/product/types'
import { PRIMARY_NAV_ITEMS, NAVBAR_SECONDARY_ITEMS } from '@/lib/navigation/registry'

describe('product architecture source of truth', () => {
  it('maps every actor to a default shell and home', () => {
    expect(ACTOR_ROLES).toEqual(['GUEST', 'COMPANY', 'ADMIN'])
    expect(APP_SHELLS).toEqual(['PUBLIC', 'COMPANY', 'ADMIN'])
    expect(DEFAULT_HOME_BY_ACTOR.COMPANY).toBe('/my-company/documents')
    expect(DEFAULT_HOME_BY_ACTOR.ADMIN).toBe('/admin')
  })

  it('keeps route inventory ids and paths unique enough for navigation and docs', () => {
    const ids = PRODUCT_ROUTES.map((route) => route.id)
    expect(new Set(ids).size).toBe(ids.length)

    const flattenedPaths = PRODUCT_ROUTES.flatMap((route) =>
      route.paths.map((path) => `${route.id}:${path}`)
    )
    expect(new Set(flattenedPaths).size).toBe(flattenedPaths.length)
  })

  it('exposes routes for every declared surface', () => {
    for (const surface of ROUTE_SURFACES) {
      expect(PRODUCT_ROUTES.filter((route) => route.surface === surface).length).toBeGreaterThan(0)
    }
  })

  it('ensures non-public routes have entrypoints so they are reachable from the product', () => {
    const privateRoutes = PRODUCT_ROUTES.filter((route) => route.surface !== 'PUBLIC')
    expect(privateRoutes.length).toBeGreaterThan(0)
    for (const route of privateRoutes) {
      expect(route.entrypoints.length).toBeGreaterThan(0)
    }
  })

  it('keeps the live company and admin dashboards addressable', () => {
    const roles = DASHBOARD_INVENTORY.map((dashboard) => dashboard.role)

    expect(roles).toContain('COMPANY')
    expect(roles).toContain('ADMIN')
    expect(DASHBOARD_INVENTORY.find((dashboard) => dashboard.role === 'COMPANY')?.homePath).toBe(
      '/my-company/documents'
    )
    expect(DASHBOARD_INVENTORY.find((dashboard) => dashboard.role === 'ADMIN')?.homePath).toBe(
      '/admin'
    )
  })

  it('keeps the retained admin workflow in the product registry', () => {
    expect(CORE_WORKFLOWS.map((workflow) => workflow.id)).toContain('admin-review')
  })

  // `admin/_shared.ts` deriva de `PRODUCT_ROUTES` el literal que `requireRole`
  // acepta, así que una página de admin fuera del catálogo tiene que escribir
  // su ruta a mano y queda invisible para el registro. Estas dos lo estuvieron.
  it('lists /ayuda in the product route catalog', () => {
    expect(PRODUCT_ROUTES.flatMap((route) => route.paths)).toContain('/ayuda')
  })

  it('describes the local Mycroft bridge, not a VDR MCP', () => {
    expect(PRODUCT_NORTH_STAR.operatingModel[0]).toBe(
      'Mycroft corre fuera; el equipo baja los documentos con vdr:pull, corre el modelo y sube los entregables con vdr:push.'
    )
    expect(PRODUCT_NORTH_STAR.operatingModel.join(' ').toLowerCase()).not.toContain('mcp')
  })

  it('lists every live admin page in the route catalog', () => {
    const adminPaths = PRODUCT_ROUTES.filter((route) => route.surface === 'ADMIN').flatMap(
      (route) => route.paths
    )

    expect(adminPaths).toEqual(expect.arrayContaining(['/admin', '/admin/gdpr', '/admin/support']))
  })

  it('captures the retained admin capability gate explicitly', () => {
    expect(ACTOR_CAPABILITY_MATRIX.find((entry) => entry.id === 'admin-view-as')?.gates).toEqual([
      'AUTH',
      'ROLE_ADMIN',
      'AUDIT_LOG_REQUIRED',
    ])
  })

  it('keeps product gaps and unknown unknowns visible', () => {
    expect(PRODUCT_GAPS.length).toBeGreaterThanOrEqual(5)
    expect(PRODUCT_GAPS[0]?.priority).toBe('P0')
    expect(UNKNOWN_UNKNOWNS.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps central vocabularies aligned with the operating model', () => {
    expect(KYC_STATUSES).toContain('RESUBMIT_REQUIRED')
    expect(PRODUCT_CORE_ENTITIES).toContain('DOCUMENT')
  })

  it('keeps the retained execution and servicing standards explicit', () => {
    expect(PRODUCT_NORTH_STAR.positioning.toLowerCase()).not.toContain('deal desk')
    expect(PRODUCT_NORTH_STAR.executionStandard).toEqual([
      'FUNCTIONAL',
      'FAST',
      'SECURE',
      'VISUALLY_POLISHED',
      'VDR_EXCELLENT',
    ])
    expect(PRODUCT_NORTH_STAR.analyticsRole).toContain('internal servicing')
    expect(PRODUCT_NORTH_STAR.analyticsRole).toContain('never a customer-facing product')
    expect(PRODUCT_NORTH_STAR.sourceMaterials).toContain('docs/north/true-north.md')
  })

  it('annotates navigation items with shell metadata', () => {
    expect(PRIMARY_NAV_ITEMS.every((item) => item.shells.length > 0)).toBe(true)
    expect(NAVBAR_SECONDARY_ITEMS.every((item) => item.shells.length > 0)).toBe(true)
    expect(NAVBAR_SECONDARY_ITEMS.find((item) => item.href === '/admin')?.shells).toEqual(['ADMIN'])
    // Corte sell-side [F] v0.10: connections/messages salen de la navegación.
    for (const retired of ['/connections', '/messages']) {
      expect(
        NAVBAR_SECONDARY_ITEMS.some((item) => item.href === retired),
        retired
      ).toBe(false)
    }
  })
})
