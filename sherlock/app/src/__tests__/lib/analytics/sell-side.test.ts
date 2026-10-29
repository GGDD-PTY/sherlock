import { beforeEach, describe, expect, it, vi } from 'vitest'

const track = vi.hoisted(() => vi.fn())

vi.mock('@/lib/analytics/posthog', () => ({ track }))

import { trackSellSideEventOnce } from '@/lib/analytics/sell-side'

describe('trackSellSideEventOnce', () => {
  beforeEach(() => {
    track.mockReset()
    window.sessionStorage.clear()
  })

  it('deduplicates in memory without reading or writing browser storage', () => {
    const storageAccess = vi.spyOn(window, 'sessionStorage', 'get')

    trackSellSideEventOnce('workspace_entered', { locale: 'es', mode: 'PERMANENT' }, 'company-room')
    trackSellSideEventOnce('workspace_entered', { locale: 'es', mode: 'PERMANENT' }, 'company-room')

    expect(track).toHaveBeenCalledOnce()
    expect(storageAccess).not.toHaveBeenCalled()
  })

  it('emits a privacy-safe event once per dedupe key', () => {
    const properties = {
      locale: 'es',
      mode: 'TEMPORARY',
      fileCount: 2,
      email: 'private@example.com',
      documentName: 'secret-model.xlsx',
    } as const

    trackSellSideEventOnce('files_selected', properties, 'selection-1')
    trackSellSideEventOnce('files_selected', properties, 'selection-1')

    expect(track).toHaveBeenCalledOnce()
    expect(track).toHaveBeenCalledWith({
      event: 'files_selected',
      properties: { locale: 'es', mode: 'TEMPORARY', fileCount: 2 },
    })
  })

  it('does not emit success analytics for a synthetic demo', () => {
    trackSellSideEventOnce(
      'deliverable_viewed',
      { locale: 'es', mode: 'DEMO', surface: 'PREPARATION_PACKAGE' },
      'demo-package'
    )

    expect(track).not.toHaveBeenCalled()
  })
})
