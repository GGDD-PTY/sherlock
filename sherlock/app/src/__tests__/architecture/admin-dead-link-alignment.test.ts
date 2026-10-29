import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(__dirname, '../../..')

function read(relativePath: string): string {
  return readFileSync(resolve(appRoot, relativePath), 'utf8')
}

describe('admin dead-link alignment', () => {
  it('does not expose retired marketplace destinations from the admin dashboard', () => {
    const dashboard = read('src/components/admin/AdminDashboardClient.tsx')

    expect(dashboard).not.toMatch(/Link href=["']\/connections["']/)
  })

  // La cola de solicitudes por transacción salió con su subsistema ([F]
  // 2026-09-17): el único destino operativo del panel es la sala de la empresa.
  it('keeps remaining destinations inside authorized operational workspaces', () => {
    const dashboard = read('src/components/admin/AdminDashboardClient.tsx')

    expect(dashboard).toContain('/admin/companies/')
    expect(dashboard).not.toContain('/admin/vdr-requests')
  })
})
