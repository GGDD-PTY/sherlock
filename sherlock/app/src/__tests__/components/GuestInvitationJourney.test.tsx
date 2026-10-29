import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GuestInvitationJourney } from '@/components/vdr-guest/GuestInvitationJourney'

const HANDLE = 'h'.repeat(64)
const CHALLENGE = 'c'.repeat(64)

function patchHistoryInstance(): {
  prototype: ReturnType<typeof vi.fn>
  instance: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const descriptor = Object.getOwnPropertyDescriptor(History.prototype, 'replaceState')
  const native = descriptor?.value as History['replaceState'] | undefined
  if (typeof native !== 'function' || !descriptor) {
    throw new Error('History.prototype.replaceState no está en este entorno')
  }
  const prototype = vi.fn(native)
  Object.defineProperty(History.prototype, 'replaceState', { ...descriptor, value: prototype })
  const instance = vi.fn(native)
  window.history.replaceState = instance as History['replaceState']
  return {
    prototype,
    instance,
    restore: () => {
      Object.defineProperty(History.prototype, 'replaceState', descriptor)
      Reflect.deleteProperty(window.history, 'replaceState')
    },
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

describe('GuestInvitationJourney', () => {
  beforeEach(() => {
    delete window.__SHERLOCK_VDR_GUEST_HANDLE__
    sessionStorage.removeItem('__SHERLOCK_VDR_GUEST_HANDLE__')
    window.history.replaceState({}, '', '/es/vdr-guest')
  })

  afterEach(() => {
    cleanup()
    delete window.__SHERLOCK_VDR_GUEST_HANDLE__
    sessionStorage.removeItem('__SHERLOCK_VDR_GUEST_HANDLE__')
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.history.replaceState({}, '', '/')
  })

  it('captures the opaque fragment in memory and clears it before the first API request', async () => {
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const fetchMock = vi.fn().mockImplementation(() => {
      expect(window.location.hash).toBe('')
      return Promise.resolve(jsonResponse({ authenticated: false }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByLabelText('Email invitado')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Tu invitación te permite acceder solo a los documentos que el equipo te haya compartido.'
      )
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/es/vdr-guest')
    expect(window.__SHERLOCK_VDR_GUEST_HANDLE__).toBeUndefined()
    expect(sessionStorage.getItem('__SHERLOCK_VDR_GUEST_HANDLE__')).toBeNull()
    expect(document.body.textContent).not.toContain(HANDLE)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vdr/guest/session',
      expect.objectContaining({ method: 'GET', cache: 'no-store' })
    )
  })

  it('consumes the pre-hydration memory handoff and deletes it before any API request', async () => {
    window.__SHERLOCK_VDR_GUEST_HANDLE__ = HANDLE
    window.history.replaceState({}, '', '/es/vdr-guest?source=mail')
    const fetchMock = vi.fn().mockImplementation(() => {
      expect(window.__SHERLOCK_VDR_GUEST_HANDLE__).toBeUndefined()
      expect(window.location.search).toBe('')
      return Promise.resolve(jsonResponse({ authenticated: false }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByLabelText('Email invitado')).toBeInTheDocument()
    expect(window.__SHERLOCK_VDR_GUEST_HANDLE__).toBeUndefined()
    expect(sessionStorage.getItem('__SHERLOCK_VDR_GUEST_HANDLE__')).toBeNull()
    expect(document.body.textContent).not.toContain(HANDLE)
  })

  // o5-04-8: Next 16.3.3 parchea `window.history.replaceState` y despacha
  // ACTION_RESTORE. El componente llama el prototipo nativo; el método de la
  // instancia (el parche) no se toca. La guarda sigue: barra limpia, no llama.
  it('does not call history.replaceState when hash and search are already empty', async () => {
    window.__SHERLOCK_VDR_GUEST_HANDLE__ = HANDLE
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('')
    const history = patchHistoryInstance()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })))

    try {
      render(<GuestInvitationJourney locale="es" />)

      expect(await screen.findByLabelText('Email invitado')).toBeInTheDocument()
      expect(history.prototype).not.toHaveBeenCalled()
      expect(history.instance).not.toHaveBeenCalled()
      expect(window.__SHERLOCK_VDR_GUEST_HANDLE__).toBeUndefined()
    } finally {
      history.restore()
    }
  })

  it('clears a leftover fragment via History.prototype, not the instance replaceState', async () => {
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const history = patchHistoryInstance()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })))

    try {
      render(<GuestInvitationJourney locale="es" />)

      expect(await screen.findByLabelText('Email invitado')).toBeInTheDocument()
      expect(history.prototype).toHaveBeenCalled()
      expect(history.instance).not.toHaveBeenCalled()
      expect(window.location.hash).toBe('')
      expect(document.body.textContent).not.toContain(HANDLE)
    } finally {
      history.restore()
    }
  })

  // o5-04-2: el handle es un bearer. No se guarda en sessionStorage ni se deja
  // en window después de capturarlo; vive solo en el ref.
  it('does not persist the invitation handle in sessionStorage or on window after capture', async () => {
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ authenticated: false })))
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByLabelText('Email invitado')).toBeInTheDocument()
    expect(window.__SHERLOCK_VDR_GUEST_HANDLE__).toBeUndefined()
    expect(sessionStorage.getItem('__SHERLOCK_VDR_GUEST_HANDLE__')).toBeNull()
  })

  it('requests a generic OTP and verifies into the HttpOnly-cookie-backed state', async () => {
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, challengeToken: CHALLENGE, expiresInSeconds: 600 }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({ verified: true, expiresAt: Date.now() + 60_000, roomAccessGranted: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: ['NDA', 'ROOM_GRANT'],
        })
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<GuestInvitationJourney locale="es" />)
    await userEvent.type(await screen.findByLabelText('Email invitado'), 'fixture-bff21e9f@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Enviar código de un solo uso' }))
    await userEvent.type(await screen.findByLabelText('Código de seis dígitos'), '481516')
    await userEvent.click(screen.getByRole('button', { name: 'Verificar email' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tu identidad fue confirmada' })
    ).toBeInTheDocument()
    expect(screen.getByText('No se proyectan documentos en esta etapa.')).toBeInTheDocument()
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    const verifyBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(requestBody).toEqual({ invitationHandle: HANDLE, email: 'fixture-bff21e9f@example.com' })
    expect(verifyBody).toEqual({
      invitationHandle: HANDLE,
      challengeToken: CHALLENGE,
      code: '481516',
    })
    expect(window.location.hash).toBe('')
    expect(document.body.textContent).not.toContain(HANDLE)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/vdr/guest/room',
      expect.objectContaining({ method: 'GET', cache: 'no-store' })
    )
  })

  it('keeps resend disabled for 60 seconds after a code is sent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const nextChallenge = 'n'.repeat(64)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, challengeToken: CHALLENGE, expiresInSeconds: 600 }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, challengeToken: nextChallenge, expiresInSeconds: 600 }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({ verified: true, expiresAt: Date.now() + 60_000, roomAccessGranted: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: ['NDA'],
        })
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<GuestInvitationJourney locale="es" />)
    await userEvent.type(await screen.findByLabelText('Email invitado'), 'fixture-bff21e9f@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Enviar código de un solo uso' }))

    const resend = await screen.findByRole('button', { name: 'Solicitar otro código' })
    expect(resend).toBeDisabled()
    expect(screen.getByText('Puedes solicitar otro código en 60 segundos.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(resend).toBeDisabled()
    expect(screen.getByText('Puedes solicitar otro código en 1 segundo.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(resend).toBeEnabled()
    expect(screen.queryByText(/Puedes solicitar otro código en/)).not.toBeInTheDocument()
    vi.useRealTimers()

    await userEvent.click(resend)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const resendBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(resendBody).toEqual({ invitationHandle: HANDLE, email: 'fixture-bff21e9f@example.com' })
    expect(resendBody).not.toHaveProperty('challengeToken')

    await userEvent.type(screen.getByLabelText('Código de seis dígitos'), '481516')
    await userEvent.click(screen.getByRole('button', { name: 'Verificar email' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4))
    const verifyBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body))
    expect(verifyBody.challengeToken).toBe(nextChallenge)
  })

  it('resolves an existing guest cookie and enumerates every still-pending access gate', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: [
            'MUTUAL_OPT_IN',
            'HUMAN_MATCH_APPROVAL',
            'NDA',
            'ROOM_GRANT',
          ],
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tu identidad fue confirmada' })
    ).toBeInTheDocument()
    expect(screen.getByText('Interés mutuo confirmado')).toBeInTheDocument()
    expect(screen.getByText('Revisión y aprobación humana')).toBeInTheDocument()
    expect(screen.getByText('NDA vigente')).toBeInTheDocument()
    expect(screen.getByText('Permiso explícito de Data Room')).toBeInTheDocument()
    expect(screen.getByText('No se proyectan documentos en esta etapa.')).toBeInTheDocument()
  })

  it('logs out through the API and leaves no local guest credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: ['ROOM_GRANT'],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ loggedOut: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<GuestInvitationJourney locale="es" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión segura' }))

    expect(await screen.findByText('Sesión cerrada')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/vdr/guest/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{}' })
    )
  })

  // El camino cambia de estado sin navegar. Greptile P2 del PR #613: sin región
  // viva, un invitado con lector de pantalla no se entera de que la sesión
  // cerró, de que el acceso terminó ni de que apareció el reintento.
  it('announces the new title and description of an asynchronous state change', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })))

    render(<GuestInvitationJourney locale="es" />)

    const title = await screen.findByText('Enlace no disponible')
    const live = title.closest('[role="status"]')
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute('aria-atomic', 'true')
    expect(live).toHaveTextContent('Enlace no disponible')
    expect(live).toHaveTextContent(/Abre el enlace original de la invitación/)
  })

  it('raises the unreachable-session screen as an alert, not a polite status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401)))

    render(<GuestInvitationJourney locale="es" />)

    const title = await screen.findByText('Acceso temporalmente no disponible')
    const live = title.closest('[role="alert"]')
    expect(live).not.toBeNull()
    expect(live).toHaveTextContent('Acceso temporalmente no disponible')
    expect(live).toHaveTextContent(/No se pudo comprobar la sesión de forma segura/)
    expect(screen.getByRole('button', { name: 'Intentar nuevamente' })).toBeInTheDocument()
  })

  it('rejects path/query-style access when no valid fragment or session exists', async () => {
    window.history.replaceState({}, '', '/es/vdr-guest?invitationHandle=leaked')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })))

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByText('Enlace no disponible')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email invitado')).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('renders an authorized room projection as an organized read-only document library', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          expiresAt: Date.now() + 60_000,
          roomAccessGranted: true,
          requiredGates: [],
          room: { title: 'Expansión regional' },
          documents: [
            {
              name: 'Estados financieros.pdf',
              fileType: 'PDF',
              fileSize: 4096,
              folder: 'Finanzas',
              classification: 'CONFIDENTIAL',
              downloadable: false,
            },
            {
              name: 'Pacto de accionistas.pdf',
              fileType: 'PDF',
              fileSize: 8192,
              folder: 'Legal',
              classification: 'LEGAL',
              downloadable: false,
            },
          ],
          documentsTruncated: false,
          downloadDeliveryAvailable: false,
          requestId: 'guest-room-test-request',
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByRole('heading', { name: 'Expansión regional' })).toBeInTheDocument()
    expect(screen.getByText('Estados financieros.pdf')).toBeInTheDocument()
    expect(screen.getByText('Pacto de accionistas.pdf')).toBeInTheDocument()
    expect(screen.getByText('Finanzas')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Legal' })).toBeInTheDocument()
    expect(
      screen.getByText(/entrega segura de archivos todavía no está disponible/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /descargar/i })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/vdr/guest/room',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    )
  })

  it('retains the truthful gate view when room access remains pending', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: ['REAL_INTEREST', 'RISK_DISCLOSURE', 'ROOM_GRANT'],
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByText('Tu identidad fue confirmada')).toBeInTheDocument()
    expect(screen.getByText('Interés real confirmado')).toBeInTheDocument()
    expect(screen.getByText('Divulgación de riesgo aceptada')).toBeInTheDocument()
    expect(screen.getByText('Permiso explícito de Data Room')).toBeInTheDocument()
    expect(screen.queryByText('Estados financieros.pdf')).not.toBeInTheDocument()
  })

  it('fails closed if access is revoked between session resolution and room projection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          roomAccessGranted: false,
          requiredGates: [],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }, 401))
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    expect(await screen.findByText('El acceso finalizó')).toBeInTheDocument()
    expect(screen.getByText(/ya no tiene una autorización activa/i)).toBeInTheDocument()
    expect(screen.queryByText('Estados financieros.pdf')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /descargar/i })).not.toBeInTheDocument()
  })

  it('leaves no room data visible when the authorized projection cannot be loaded', async () => {
    window.history.replaceState({}, '', `/es/vdr-guest#${HANDLE}`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, challengeToken: CHALLENGE, expiresInSeconds: 600 }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({ verified: true, expiresAt: Date.now() + 60_000, roomAccessGranted: false })
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'Acceso temporalmente no disponible' }, 503))
    vi.stubGlobal('fetch', fetchMock)

    render(<GuestInvitationJourney locale="es" />)

    await userEvent.type(await screen.findByLabelText('Email invitado'), 'fixture-bff21e9f@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Enviar código de un solo uso' }))
    await userEvent.type(await screen.findByLabelText('Código de seis dígitos'), '481516')
    await userEvent.click(screen.getByRole('button', { name: 'Verificar email' }))

    expect(await screen.findByText('Acceso temporalmente no disponible')).toBeInTheDocument()
    expect(screen.queryByText('Estados financieros.pdf')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /descargar/i })).not.toBeInTheDocument()
  })
})
