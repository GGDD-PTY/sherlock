// ============================================================================
// ADMIN CHROME - GATE DE ENVIRONMENT PARA DEV TOOLBAR
// ============================================================================
// ES: La DevToolbar (que monta UserImpersonator) es tooling solo-dev: en
//     producción AdminChrome no debe montarla, ni siquiera para un ADMIN.
//     ViewAsBanner (view-as por rol) sí sobrevive en prod.
// ============================================================================

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    // Resolver el import dinámico de forma síncrona vía el path del loader:
    // devolvemos un stub según el módulo que AdminChrome pida.
    const source = loader.toString()
    if (source.includes('ViewAsBanner')) {
      const ViewAsBannerStub = () => <div data-testid="view-as-banner" />
      return ViewAsBannerStub
    }
    const DevToolbarStub = () => <div data-testid="dev-toolbar" />
    return DevToolbarStub
  },
}))

// Importar el módulo ANTES de stubear NODE_ENV: el gate lee process.env en
// render-time, pero react/jsx-dev-runtime se resuelve en import-time y con
// NODE_ENV=production dejaría de exportar jsxDEV.
async function loadAdminChrome() {
  const { AdminChrome } = await import('@/components/admin/AdminChrome')

  return AdminChrome
}

describe('AdminChrome - dev toolbar production gate', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not mount DevToolbar in production', async () => {
    const AdminChrome = await loadAdminChrome()
    vi.stubEnv('NODE_ENV', 'production')

    render(<AdminChrome />)

    expect(screen.queryByTestId('dev-toolbar')).toBeNull()
    expect(screen.getByTestId('view-as-banner')).toBeTruthy()
  })

  it('mounts DevToolbar outside production', async () => {
    const AdminChrome = await loadAdminChrome()

    render(<AdminChrome />)

    expect(screen.getByTestId('dev-toolbar')).toBeTruthy()
    expect(screen.getByTestId('view-as-banner')).toBeTruthy()
  })
})
