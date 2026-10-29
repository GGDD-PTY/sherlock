import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

describe('active sell-side navigation', () => {
  const registry = read('src/lib/navigation/registry.ts')
  const navbar = read('src/components/layout/Navbar.tsx')
  const publicNavbar = read('src/components/layout/PublicNavbar.tsx')

  it('offers company preparation and admin operations without retired marketplace destinations', () => {
    expect(registry).toContain("href: '/my-company/documents'")
    expect(registry).toContain("href: '/admin'")

    for (const href of [
      '/my-company/deals',
      '/my-investor/profile',
      '/portfolio',
      '/connections',
      '/messages',
    ]) {
      expect(registry, href).not.toContain(`href: '${href}'`)
    }
  })

  it('keeps the landing CTA on intake and removes catalog search and public pricing', () => {
    // La barra de `/intake` y `/vdr-guest` conserva la ancla a la capa de
    // subida; la landing mínima ([F] 2026-09-14) sacó ese atajo de
    // `PublicNavbar`, donde el único CTA lleno es la propia capa.
    expect(publicNavbar).not.toContain('companyHref')
    expect(publicNavbar).not.toContain('startDataRoom')
    expect(navbar).toContain("const companyHref = '/#intake'")
    expect(navbar).not.toContain('GlobalSearchButton')
    expect(navbar).not.toContain('useUnreadMessages')
    expect(navbar).not.toContain("href: '/pricing'")
    expect(publicNavbar).not.toContain('useCurrentUser')
  })
})
