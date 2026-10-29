import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const APP_ROOT = join(process.cwd(), 'src')

const read = (path: string) => readFileSync(join(APP_ROOT, path), 'utf8')

const NAVBAR_DESTINATION_SURFACES = [
  'components/notifications/NotificationsPageClient.tsx',
  'components/company/MyCompanyDocumentsClient.tsx',
] as const

describe('navbar destination page identity', () => {
  it.each(NAVBAR_DESTINATION_SURFACES)('%s exposes its section name as a page h1', (path) => {
    const source = read(path)

    expect(source).toMatch(/<h1[^>]*data-page-identity/)
  })

  // El destino por rol dejó de ser una ruta propia: `/dashboard` se borró y su
  // contrato vive en `lib/navigation/home.ts` ([F] 2026-09-07 09:00), con su
  // propia prueba en lib/navigation/home.test.ts.
  //
  // El enlace de vuelta al dashboard salió del banner ([F] 2026-08-30 03:44:
  // data room del cliente = 3 bloques): la identidad ahora abre el header y las
  // acciones de la sala vienen después, sin navegación de vuelta en el medio.
  it('opens the header with the Data Room identity and no dashboard back action', () => {
    const source = read('components/company/MyCompanyDocumentsClient.tsx')

    expect(source.indexOf('data-page-identity')).toBeLessThan(source.indexOf('<VdrUploadDialog'))
    expect(source).not.toContain('<Link href="/dashboard">')
    // [F] 2026-09-03 23:30: el sitio ships solo en español; la copia de
    // identidad dejó de venir en pares es/en y queda una sola entrada.
    expect(source.match(/title: 'Data Room'/g)).toHaveLength(1)
  })

  it('NotificationsPageClient keeps its page identity visible while data loads', () => {
    const source = read('components/notifications/NotificationsPageClient.tsx')

    expect(source.match(/<h1[^>]*data-page-identity/g)?.length).toBeGreaterThanOrEqual(2)
  })

  // La sala pinta su propio h1 mientras carga y, ya cargada, el de la cabecera
  // compartida de las pantallas (docs/design-system-vdr.md).
  it('MyCompanyDocumentsClient keeps its page identity visible while data loads', () => {
    const source = read('components/company/MyCompanyDocumentsClient.tsx')
    const header = read('components/company/CompanyRoomHeader.tsx')

    expect(source.match(/<h1[^>]*data-page-identity/g)?.length).toBeGreaterThanOrEqual(1)
    expect(source).toContain('<CompanyRoomHeader')
    expect(header.match(/<h1[^>]*data-page-identity/g)?.length).toBeGreaterThanOrEqual(1)
  })

  // `/dashboard` ya no existe: no hay un tercer destino que nombrar mientras
  // carga ([F] 2026-09-07 09:00).
  it('keeps the documents route loading on the room silhouette, not marketplace cards', () => {
    const source = read('app/[locale]/(app)/my-company/documents/loading.tsx')

    expect(source).toMatch(/font-sans text-lg/)
    expect(source).toContain('h-28')
    expect(source).toContain('h-96')
    expect(source).not.toMatch(/text-3xl/)
    expect(source).not.toMatch(/md:grid-cols-4/)
  })

  it.each([
    'app/[locale]/(app)/notifications/loading.tsx',
    'app/[locale]/(app)/my-company/documents/loading.tsx',
    'components/lazy/index.tsx',
  ])('%s names the destination while the route loads', (path) => {
    const source = read(path)

    expect(source).toMatch(/<(h1|Heading)[^>]*\n?\s*data-page-identity/)
    expect(source).toContain('useTranslations(')
  })

  it('reads Data Room metadata from the Spanish catalog, without Virtual Data Room', () => {
    const documentsPage = read('app/[locale]/(app)/my-company/documents/page.tsx')
    const activityPage = read('app/[locale]/(app)/my-company/documents/activity/page.tsx')
    const es = JSON.parse(read('messages/es.json')) as {
      vdr: {
        meta: {
          documents: { title: string; description: string }
          activity: { title: string; description: string }
        }
      }
    }

    expect(documentsPage).toContain("namespace: 'vdr.meta.documents'")
    expect(activityPage).toContain("namespace: 'vdr.meta.activity'")
    expect(es.vdr.meta.documents.title).toBe('Data Room')
    expect(es.vdr.meta.documents.description).toBe(
      'Tus documentos, carpetas y versiones en un solo lugar.'
    )
    expect(es.vdr.meta.activity.title).toBe('Actividad del Data Room')
    expect(es.vdr.meta.activity.description).toBe('Quién abrió, subió o descargó qué y cuándo.')
    expect(JSON.stringify(es.vdr.meta)).not.toMatch(/Virtual Data Room|Mis Documentos/)
  })

  it('reads the Notifications page identity from the Spanish catalog', () => {
    const source = read('components/notifications/NotificationsPageClient.tsx')

    expect(source).toContain("useTranslations('notifications')")
    expect(source).toContain("{t('pageTitle')}")

    const es = JSON.parse(read('messages/es.json')) as {
      notifications: { pageTitle: string }
    }

    expect(es.notifications.pageTitle).toBe('Notificaciones')
  })
})
