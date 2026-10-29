// @vitest-environment node
// El servidor de Next evalúa los módulos 'use client' para el SSR. Un global
// del navegador a nivel de módulo (HTMLIFrameElement, window, document) rompe
// la carga del chunk entero y el visor se cae a render de cliente con React
// #419. Medido en prod el 2026-09-10 tras el llenado de Effect (a2032faa0).
import { describe, expect, it } from 'vitest'

describe('ViewerChrome en un runtime sin DOM', () => {
  it('se importa sin tocar globales del navegador', async () => {
    expect(typeof globalThis.HTMLIFrameElement).toBe('undefined')
    await expect(import('@/components/documents/viewers/ViewerChrome')).resolves.toBeTruthy()
  })
})
