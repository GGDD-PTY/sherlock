import { IDBFactory } from 'fake-indexeddb'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

import { MycroftLanding } from '@/components/mycroft/MycroftLanding'
import { peekHandoff } from '@/lib/mycroft/upload-handoff'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    configurable: true,
    writable: true,
  })
})

const originalLocation = window.location
const assign = vi.fn<(url: string | URL) => void>()
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('indexedDB', new IDBFactory())
  Object.defineProperty(window, 'location', {
    value: { href: originalLocation.href, origin: originalLocation.origin, assign },
    configurable: true,
    writable: true,
  })
  fetchMock.mockImplementation(async (input, init) => {
    if (input === '/api/intake/destination') {
      return new Response(JSON.stringify({ error: 'Unauthorized', requestId: 'anonymous' }), {
        status: 401,
      })
    }
    if (input !== '/api/intake/session') throw new Error('Unexpected upload after quota denial')
    return init?.method === 'POST'
      ? new Response(JSON.stringify({ code: 'INTAKE_SESSION_LIMIT' }), { status: 429 })
      : new Response(JSON.stringify({ authorized: false, csrfToken: 'bootstrap-csrf' }), {
          status: 200,
        })
  })
})

function jsonRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON request body')
  return JSON.parse(body)
}

function signupDestination(signup: URL): URL {
  const returnTo = signup.searchParams.get('returnTo')
  if (returnTo === null) throw new Error('Signup destination is missing')
  return new URL(returnTo, signup.origin)
}

it('preserves company name, document bytes and nonce through hosted signup when session creation returns 429', async () => {
  render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      <MycroftLanding secureHref="/es/sign-up?returnTo=%2Fes%2Fmy-company%2Fdocuments" />
    </NextIntlClientProvider>
  )
  fireEvent.change(screen.getByLabelText('Nombre de tu empresa'), {
    target: { value: 'Empresa de prueba' },
  })
  fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
    target: {
      files: [new File(['documento financiero'], 'estados.pdf', { type: 'application/pdf' })],
    },
  })
  fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))

  const signup = new URL(assign.mock.calls[0][0], 'https://sherlock.capital')
  expect(signup.pathname).toBe('/es/sign-up')
  const destination = signupDestination(signup)
  expect(destination.pathname).toBe('/es/my-company/documents')
  const handoff = await peekHandoff()
  expect(handoff.status).toBe('READY')
  expect(handoff.nonce).toMatch(/^[0-9a-f-]{36}$/)
  expect(destination.searchParams.get('handoff')).toBe(handoff.nonce)
  expect(handoff.companyName).toBe('Empresa de prueba')
  expect(handoff.files.map(({ file }) => file.name)).toEqual(['estados.pdf'])
  expect(await handoff.files[0].file.text()).toBe('documento financiero')
  expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST'])
  expect(jsonRequestBody(fetchMock.mock.calls[2][1]?.body)).toEqual({
    name: 'Empresa de prueba',
  })
  expect(screen.queryByText('Recibido', { exact: true })).not.toBeInTheDocument()
})
