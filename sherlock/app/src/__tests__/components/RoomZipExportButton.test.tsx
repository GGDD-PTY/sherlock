import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    info: vi.fn(),
  },
}))

import { RoomZipExportButton } from '@/components/documents/shell/RoomZipExportButton'
import { ROOM_SHELL_COPY } from '@/components/documents/shell/copy'

const copy = ROOM_SHELL_COPY.es
const COMPANY_ID = 'kb26dda1f99bb802816c813f82df3936'

function renderButton(overrides: Partial<React.ComponentProps<typeof RoomZipExportButton>> = {}) {
  return render(
    <RoomZipExportButton
      locale="es"
      label={copy.downloadZip}
      pendingLabel={copy.downloadZipPending}
      successLabel={copy.downloadZipStarted}
      errorLabel={copy.downloadZipError}
      tooLargeLabel={copy.downloadZipTooLarge}
      emptyLabel={copy.downloadZipEmpty}
      testId="room-zip-export"
      {...overrides}
    />
  )
}

describe('RoomZipExportButton', () => {
  const downloads: string[] = []

  beforeEach(() => {
    downloads.length = 0
    toastError.mockReset()
    toastSuccess.mockReset()
    if (typeof URL.createObjectURL !== 'function') {
      Object.assign(URL, {
        createObjectURL: () => 'blob:test',
        revokeObjectURL: () => {},
      })
    }
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function clickAnchor(
      this: HTMLAnchorElement
    ) {
      downloads.push(this.download)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('toasts the 250 MB cap without creating a blob download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('too large', { status: 413 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')

    renderButton()
    await userEvent.click(screen.getByTestId('room-zip-export'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(copy.downloadZipTooLarge)
    })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('toasts the empty-room 404 without creating a blob download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('empty', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')

    renderButton()
    await userEvent.click(screen.getByTestId('room-zip-export'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(copy.downloadZipEmpty)
    })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('toasts a generic error on 403 and keeps the request ID in telemetry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden', requestId: 'req-zip-403' }), {
        status: 403,
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderButton({ companyId: COMPANY_ID })
    await userEvent.click(screen.getByTestId('room-zip-export'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(copy.downloadZipError)
    })
    expect(toastError.mock.calls.flat().join(' ')).not.toContain('req-zip-403')
    expect(logError).toHaveBeenCalledWith(
      'Room ZIP export request failed',
      { status: 403 },
      { requestId: 'req-zip-403' }
    )
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('forwards companyId and folder on the export URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala-SAMPLE_ENERGY.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:room-zip')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderButton({ companyId: COMPANY_ID, folder: 'room_legal' })
    await userEvent.click(screen.getByTestId('room-zip-export'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/vdr/export?locale=es&companyId=${COMPANY_ID}&folder=room_legal`,
        { method: 'GET', credentials: 'same-origin' }
      )
    })
  })

  it('names the download from filename* and ignores a second click while pending', async () => {
    let resolveFetch: (value: Response) => void = () => {}
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:room-zip')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderButton()
    const button = screen.getByTestId('room-zip-export')
    await userEvent.click(button)
    await userEvent.click(button)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    resolveFetch(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          'Content-Disposition':
            'attachment; filename="sala.zip"; filename*=UTF-8\'\'sala-ELTR%C3%93N.zip',
        },
      })
    )

    await waitFor(() => {
      expect(downloads).toEqual(['sala-ELTRÓN.zip'])
    })
    expect(button).not.toBeDisabled()
  })
  // El zip de cientos de MB es justo el caso en que el navegador todavía no
  // consumió el Blob cuando el object URL se revoca en el mismo tick del click.
  it('revoca el object URL en el siguiente turno, no al hacer click', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:room-zip')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderButton()
    fireEvent.click(screen.getByTestId('room-zip-export'))

    await act(async () => {
      pending.resolve(
        new Response(new Uint8Array([80, 75]), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="sala.zip"' },
        })
      )
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    })

    expect(downloads).toEqual(['sala.zip'])
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:room-zip')
  })

  it('confirma el final feliz con un toast y lo anuncia al lector de pantalla', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:room-zip')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    renderButton()
    await userEvent.click(screen.getByTestId('room-zip-export'))

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(copy.downloadZipStarted)
    })
    expect(screen.getByTestId('room-zip-export-status')).toHaveTextContent(copy.downloadZipStarted)
    expect(toastError).not.toHaveBeenCalled()
  })
})
