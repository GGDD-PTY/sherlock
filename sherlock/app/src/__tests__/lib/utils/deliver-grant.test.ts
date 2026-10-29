// ============================================================================
// TESTS: entrega de grants sin popups
// ============================================================================
// Regresión del hilo de soporte de SAMPLE_HYDRO 2026-08-27 («no puedo bajar los PDF»,
// «no los abro desde el celular»): la entrega llegaba por `window.open` después
// de un `await`, Safari/iOS la bloqueaban y el código ignoraba el null.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadFromGrant, openFromGrant } from '@/lib/utils/deliver-grant'

const GRANT_URL = '/api/documents/access/grant_1?token=abc'

describe('downloadFromGrant', () => {
  const originalOpen = window.open

  beforeEach(() => {
    window.open = vi.fn().mockReturnValue(null) as typeof window.open
  })

  afterEach(() => {
    window.open = originalOpen
    vi.restoreAllMocks()
  })

  it('never goes through window.open, so a popup blocker cannot swallow it', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(downloadFromGrant(GRANT_URL, 'Estados financieros.pdf')).toBe(true)

    expect(window.open).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('clicks a same-origin anchor with the download attribute and the file name', () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this)
    })

    downloadFromGrant(GRANT_URL, 'Estados financieros.pdf')

    expect(clicked).toHaveLength(1)
    const anchor = clicked[0]
    expect(anchor.getAttribute('href')).toBe(GRANT_URL)
    expect(anchor.getAttribute('download')).toBe('Estados financieros.pdf')
    expect(anchor.rel).toContain('noopener')
    // El anchor es un vehículo: no se queda en el DOM.
    expect(document.body.contains(anchor)).toBe(false)
  })
})

describe('openFromGrant', () => {
  const originalOpen = window.open

  afterEach(() => {
    window.open = originalOpen
    vi.restoreAllMocks()
  })

  it('delivers the grant once through a safe new tab when the browser allows it', () => {
    const openedAssign = vi.fn()
    const openedWindow = { opener: {}, location: { assign: openedAssign } }
    window.open = vi.fn().mockReturnValue(openedWindow) as unknown as typeof window.open
    const currentAssign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign: currentAssign,
    } as unknown as Location)

    expect(openFromGrant(GRANT_URL)).toBe('tab')
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(openedWindow.opener).toBeNull()
    expect(openedAssign).toHaveBeenCalledWith(GRANT_URL)
    expect(currentAssign).not.toHaveBeenCalled()
  })

  it('falls back to same-tab navigation when the popup is blocked instead of staying silent', () => {
    window.open = vi.fn().mockReturnValue(null) as typeof window.open
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location)

    expect(openFromGrant(GRANT_URL)).toBe('same-tab')
    expect(assign).toHaveBeenCalledWith(GRANT_URL)
  })
})
