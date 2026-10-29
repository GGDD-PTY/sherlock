import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { ROOM_SCREENS, ROOM_SCREEN_PATH } from '@/components/company/roomScreens'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

const DOCUMENTS_CLIENT = 'sherlock/app/src/components/company/MyCompanyDocumentsClient.tsx'
const SECTION_NAV = 'sherlock/app/src/components/company/CompanyRoomSections.tsx'

// Paneles que viven en otra pantalla. Si el cliente de documentos vuelve a
// importar uno, la portada volvió a ser un cuaderno.
const PANELS_OF_OTHER_SCREENS = [
  'CompanyProfileForm',
  'CompanyContactSection',
  'RoomProgressPanel',
  'SupportThread',
  'CompanyGuestPanel',
  'CompanyFinancialDashboard',
]

describe('VDR design contract (docs/design-system-vdr.md)', () => {
  it('keeps the binding sections', () => {
    const source = read('docs/design-system-vdr.md')
    for (const section of [
      '## Authority and scope',
      '## Una pantalla por intención',
      '## Estático y dinámico se ven distintos',
      '## Contenedor compartido',
      '## Verification',
    ]) {
      expect(source, `missing section: ${section}`).toContain(section)
    }
    expect(source).toContain('roomScreens.ts')
  })

  it('gives every screen in the catalog a page', () => {
    for (const screen of ROOM_SCREENS) {
      const route = ROOM_SCREEN_PATH[screen].replace(/^\/my-company\//, '')
      const page = path.join(APP_ROOT, 'src/app/[locale]/(app)/my-company', route, 'page.tsx')
      expect(fs.existsSync(page), `missing page for screen ${screen}: ${page}`).toBe(true)
    }
  })

  it('keeps the documents screen to the shell alone', () => {
    const source = read(DOCUMENTS_CLIENT)
    for (const panel of PANELS_OF_OTHER_SCREENS) {
      expect(source, `${panel} belongs to another screen`).not.toContain(panel)
    }
  })

  it('navigates screens by route, not by anchor', () => {
    const nav = read(SECTION_NAV)
    expect(nav).not.toMatch(/['"]#(?:room-shell|company-[a-z]+)['"]/)
    expect(nav).toContain('roomScreens')
    expect(nav).toContain("from '@/i18n/navigation'")
  })

  it('shares the product navbar container with the room screens', () => {
    const navbar = read('sherlock/app/src/components/layout/Navbar.tsx')
    const header = read('sherlock/app/src/components/company/CompanyRoomHeader.tsx')
    expect(navbar).toContain('max-w-7xl')
    expect(header).toMatch(/ROOM_SCREEN_CONTAINER_CLASS = '[^']*max-w-7xl/)
    expect(read(DOCUMENTS_CLIENT)).toContain('ROOM_SCREEN_CONTAINER_CLASS')
  })
})
