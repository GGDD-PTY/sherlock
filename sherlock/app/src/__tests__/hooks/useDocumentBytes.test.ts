import { StrictMode, createElement, type ReactNode } from 'react'
import { render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DocumentBytesProvider,
  useDocumentBytes,
} from '@/components/documents/viewers/useDocumentBytes'

const GRANT_URL = '/api/documents/access/grant_1?token=tok&disposition=inline'

function okResponse(bytes: number[]) {
  return new Response(new Uint8Array(bytes), { status: 200 })
}

describe('useDocumentBytes', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('fetches a single-use grant once even when StrictMode replays the effect', async () => {
    fetchMock.mockImplementation(async () => okResponse([1, 2, 3]))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children)

    const { result } = renderHook(() => useDocumentBytes(GRANT_URL), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(GRANT_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (result.current.status !== 'ready') throw new Error('expected bytes')
    expect([...new Uint8Array(result.current.bytes)]).toEqual([1, 2, 3])
  })

  it('reports an error when the delivery is refused', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 403 }))

    const { result } = renderHook(() => useDocumentBytes(GRANT_URL))

    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('fetches again for a fresh grant url after the previous one settled', async () => {
    fetchMock.mockImplementation(async () => okResponse([9]))

    const first = renderHook(({ url }) => useDocumentBytes(url), {
      initialProps: { url: GRANT_URL },
    })
    await waitFor(() => expect(first.result.current.status).toBe('ready'))

    first.rerender({ url: '/api/documents/access/grant_2?token=tok2&disposition=inline' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
  it('preserves a consumed grant across responsive viewer remounts within the same opening', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse([1, 2, 3]))
      .mockResolvedValue(new Response(null, { status: 403 }))
    function Probe() {
      const state = useDocumentBytes(GRANT_URL)
      return createElement('span', null, state.status)
    }
    const view = (layout: string) =>
      createElement(
        DocumentBytesProvider,
        { activeUrl: GRANT_URL },
        createElement(Probe, { key: layout })
      )
    const mounted = render(view('desktop'))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    mounted.rerender(view('mobile'))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })

  it('preserves the PPTX rendition url across remounts within the same opening', async () => {
    // El visor PPTX pide `viewUrl&rendition=pdf`, no el grant a secas: la cache
    // va por URL pedida dentro de la apertura, o el remount quema el grant.
    fetchMock
      .mockResolvedValueOnce(okResponse([4, 5, 6]))
      .mockResolvedValue(new Response(null, { status: 403 }))
    const renditionUrl = `${GRANT_URL}&rendition=pdf`
    function Probe() {
      return createElement('span', null, useDocumentBytes(renditionUrl).status)
    }
    const view = (layout: string) =>
      createElement(
        DocumentBytesProvider,
        { activeUrl: GRANT_URL },
        createElement(Probe, { key: layout })
      )
    const mounted = render(view('desktop'))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    mounted.rerender(view('mobile'))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(renditionUrl, expect.anything())
    mounted.unmount()
  })

  it('retries with a fresh grant and releases bytes when the opening closes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockImplementation(async () => okResponse([7]))
    function Probe({ url }: { url: string }) {
      return createElement('span', null, useDocumentBytes(url).status)
    }
    const view = (url: string | null) =>
      createElement(
        DocumentBytesProvider,
        { activeUrl: url },
        url ? createElement(Probe, { url }) : null
      )
    const mounted = render(view(GRANT_URL))
    await waitFor(() => expect(mounted.getByText('error')).toBeTruthy())
    const retryUrl = '/api/documents/access/grant_retry'
    mounted.rerender(view(retryUrl))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    mounted.rerender(view(null))
    mounted.rerender(view(retryUrl))
    await waitFor(() => expect(mounted.getByText('ready')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    mounted.unmount()
  })
})
