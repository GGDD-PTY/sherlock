import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import esMessages from '@/messages/es.json'

const read = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8')

describe('visible copy that lives in es.json', () => {
  it('reads the skip link from common.navbar.aria', () => {
    expect(esMessages.common.navbar.aria.skipToContent).toBe('Saltar al contenido principal')
    // O2-06: el salto salió del layout raíz a los dos shells.
    expect(read('components/providers/PublicShell.tsx')).toContain("tAria('skipToContent')")
    expect(read('components/providers/AppShell.tsx')).toContain("tAria('skipToContent')")
  })

  it('keeps the global 404 strings in the catalog', () => {
    expect(esMessages.errors.global404).toEqual({
      title: 'Página no encontrada',
      body: 'La página que buscas no existe o fue movida.',
      cta: 'Ir al inicio',
      help: 'Ir a Ayuda',
    })
    expect(read('app/global-not-found.tsx')).toContain('esMessages.errors.global404')
  })

  it('keeps the global error strings in the catalog', () => {
    expect(esMessages.errors.globalError.title).toBe('Algo salió mal')
    expect(esMessages.errors.globalError.cta).toBe('Intentar de nuevo')
    expect(read('app/global-error.tsx')).toContain('esMessages.errors.globalError')
  })

  it('reads legal and terms metadata from the catalog', () => {
    expect(read('app/[locale]/(public)/legal/page.tsx')).toContain("namespace: 'legal.meta'")
    expect(read('app/[locale]/(public)/terms/page.tsx')).toContain("namespace: 'terms.meta'")
  })

  it('reads guest-room metadata from vdrGuest.meta', () => {
    expect(esMessages.vdrGuest.meta.title).toBe('Sala de invitado')
    expect(esMessages.vdrGuest.meta.description).toBe(
      'Accede a los documentos que te compartieron.'
    )
    expect(read('app/[locale]/vdr-guest/page.tsx')).toContain("namespace: 'vdrGuest.meta'")
  })
})
