import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import GlobalError from '@/app/global-error'

// El boundary raíz servía dos caras y elegía una leyendo `document.documentElement.lang`
// y `navigator.language`. [F] 2026-09-03: el sitio es solo en español, así que la
// pantalla se arma en español desde el servidor y ningún idioma del navegador la mueve.
describe('global error copy', () => {
  const html = renderToString(
    createElement(GlobalError, {
      error: new Error('boom'),
      reset: () => undefined,
    })
  )

  it('declares Spanish on the document it renders', () => {
    expect(html).toContain('<html lang="es">')
    expect(html).not.toContain('lang="und"')
    expect(html).not.toContain('lang="en"')
  })

  it('renders an immediate and actionable Spanish fallback', () => {
    expect(html).toContain('role="alert"')
    expect(html).toContain('Algo salió mal')
    expect(html).toContain('Intentar de nuevo')
    expect(html).toContain('<button')
  })

  it('never ships the English or bilingual copy the two-locale card used', () => {
    expect(html).not.toContain('Something went wrong')
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('Reference')
  })
})
