import { describe, expect, it } from 'vitest'

import sitemap from '@/app/sitemap'

const paths = () => sitemap().map((entry) => new URL(entry.url).pathname)

describe('public sitemap', () => {
  // [F] 2026-09-03 23:30: el sitio ships solo en español y el locale `en`
  // desapareció. El sitemap anuncia un único prefijo: una entrada `/en/` sería
  // una URL que no existe.
  it('indexes the public informational surfaces in the only locale', () => {
    expect(paths()).toEqual(expect.arrayContaining(['/es', '/es/ayuda']))
    expect(paths().every((path) => path === '/es' || path.startsWith('/es/'))).toBe(true)
  })

  // /help y /roadmap se fundieron en /ayuda y solo redirigen: anunciar un
  // redirect quema presupuesto de rastreo, igual que el `/mycroft` retirado.
  it('never advertises the retired help and roadmap paths', () => {
    for (const path of ['/es/help', '/en/help', '/es/roadmap', '/en/roadmap']) {
      expect(paths()).not.toContain(path)
    }
  })

  // [F] 2026-09-07 09:00: `/data-room` se borró — era una página que solo
  // redirigía a la sala. El sitemap no puede anunciar una URL que responde 404,
  // igual que con el `/mycroft` retirado.
  it('never advertises the deleted /data-room gateway', () => {
    expect(paths()).not.toContain('/es/data-room')
    expect(paths()).not.toContain('/en/data-room')
  })

  // Los tres documentos legales son públicos y sustantivos: dejar uno fuera del
  // sitemap lo esconde del indexado que sí reciben sus hermanos.
  it('indexes every public legal document', () => {
    expect(paths()).toEqual(expect.arrayContaining(['/es/privacy', '/es/terms', '/es/legal']))
  })

  // El catálogo del marketplace quedó despublicado en el código, sin bandera de
  // ambiente que lo reabra: el sitemap no puede volver a anunciarlo.
  it('never advertises the unpublished marketplace catalogs', () => {
    expect(paths()).not.toContain('/es/deals')
    expect(paths()).not.toContain('/en/deals')
    expect(paths()).not.toContain('/es/companies')
    expect(paths()).not.toContain('/en/companies')
    expect(paths()).not.toContain('/es/investors')
    expect(paths()).not.toContain('/en/investors')
  })

  // El intake dejó de vivir en /mycroft y ES la home: el path viejo solo
  // redirige. Anunciar un redirect en el sitemap quema el presupuesto de
  // rastreo y confunde la señal canónica de la home.
  it('never advertises the retired /mycroft intake path', () => {
    expect(paths()).not.toContain('/es/mycroft')
    expect(paths()).not.toContain('/en/mycroft')
  })
})
