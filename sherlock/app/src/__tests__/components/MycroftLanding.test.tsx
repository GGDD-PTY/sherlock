import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MycroftLanding } from '@/components/mycroft/MycroftLanding'
import { readLandingDestination } from '@/lib/intake/landing-destination'
import {
  ackHandoffFiles,
  discardHandoff,
  discardHandoffWithNonce,
  peekHandoff,
  stashHandoff,
} from '@/lib/mycroft/upload-handoff'
import { MAX_CSV_UPLOAD_BYTES, MAX_DIRECT_UPLOAD_BYTES } from '@/lib/storage/upload-limits'
import { getPublicAppUrl } from '@/lib/site/brand'
import esMessages from '@/messages/es.json'
import { FakeXMLHttpRequest, installFakeXhr, respondStorageImmediately } from '../utils/fake-xhr'

vi.unmock('next-intl')
vi.mock('@/lib/intake/landing-destination', () => ({
  readLandingDestination: vi.fn().mockResolvedValue({ status: 'NONE' }),
}))

vi.mock('@/lib/mycroft/upload-handoff', () => ({
  stashHandoff: vi.fn().mockResolvedValue(true),
  peekHandoff: vi.fn().mockResolvedValue({
    status: 'EMPTY',
    files: [],
    companyName: null,
    stashedAt: null,
    nonce: null,
  }),
  ackHandoffFiles: vi.fn().mockResolvedValue(true),
  discardHandoff: vi.fn().mockResolvedValue(true),
  discardHandoffWithNonce: vi.fn().mockResolvedValue(true),
}))

// Hora en que la landing parqueó el sobre; la sala la usa solo para decidir si
// el nombre bautiza un alta nueva.
const HANDOFF_STASHED_AT = 1_780_000_000_000
const HANDOFF_NONCE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function roomSecureHref(locale: 'es') {
  return `/${locale}/sign-up?returnTo=${encodeURIComponent(`/${locale}/my-company/documents`)}`
}

// La continuación lleva la llave del sobre dentro del returnTo, que es lo que
// WorkOS y /dev-login devuelven intacto a la sala. Devuelve esa llave.
function continuedWithHandoffNonce(assign: ReturnType<typeof vi.fn>, locale: 'es' = 'es') {
  expect(assign).toHaveBeenCalledTimes(1)
  const url = new URL(String(assign.mock.calls[0]?.[0]), 'https://sherlock.capital')
  expect(url.pathname).toBe(`/${locale}/sign-up`)
  const returnTo = new URL(url.searchParams.get('returnTo') ?? '', 'https://sherlock.capital')
  expect(returnTo.pathname).toBe(`/${locale}/my-company/documents`)
  const nonce = returnTo.searchParams.get('handoff')
  expect(nonce).toMatch(UUID)
  return nonce as string
}

function renderLanding(locale: 'es' = 'es', secureHref: string = roomSecureHref(locale)) {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      <MycroftLanding secureHref={secureHref} />
    </NextIntlClientProvider>
  )
}

// El nombre es requerido desde [F] 2026-09-14: toda continuación empieza
// escribiéndolo, igual que el cliente.
function fillCompanyName(name = 'Ferretería Demo') {
  fireEvent.change(screen.getByLabelText('Nombre de tu empresa'), {
    target: { value: name },
  })
}

describe('MycroftLanding', () => {
  // Los bytes viajan por XHR (progreso por bytes); intent y registro siguen
  // por fetch. El XHR falso responde de inmediato salvo que un test lo
  // detenga a mano para observar el progreso o cancelarlo.
  beforeEach(() => {
    installFakeXhr()
    respondStorageImmediately()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.mocked(stashHandoff).mockResolvedValue(true)
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    vi.mocked(ackHandoffFiles).mockResolvedValue(true)
    vi.mocked(discardHandoff).mockReset().mockResolvedValue(true)
    vi.mocked(discardHandoffWithNonce).mockReset().mockResolvedValue(true)
    vi.mocked(readLandingDestination).mockReset().mockResolvedValue({ status: 'NONE' })
  })

  it('offers only the supported direct-upload formats', () => {
    renderLanding('es')
    fillCompanyName()

    expect(screen.getByLabelText('Seleccionar documentos')).toHaveAttribute(
      'accept',
      '.pdf,.xlsx,.xls,.csv,.docx,.doc,.pptx,.ppt'
    )
    expect(screen.getByRole('list', { name: 'Formatos de documentos' })).toHaveTextContent(
      'PDFExcelWordPowerPointCSV'
    )
  })

  it('shows the owned Data Room before uploading when the session already has one', async () => {
    vi.mocked(readLandingDestination).mockResolvedValue({
      status: 'FOUND',
      companyName: 'Sample Foods, S.A.',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    renderLanding('es')
    fillCompanyName()
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

    expect(await screen.findByTestId('landing-destination-notice')).toHaveTextContent(
      'El Data Room de Sample Foods, S.A. recibirá tus documentos. Si es otra empresa, cierra sesión y empieza de nuevo.'
    )
    expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    expect(stashHandoff).not.toHaveBeenCalled()
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.includes('/api/intake/uploads')
      })
    ).toBe(false)
    fetchMock.mockRestore()
  })

  it('uploads only after the destination notice is confirmed', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    vi.mocked(readLandingDestination).mockResolvedValue({
      status: 'FOUND',
      companyName: 'Sample Foods, S.A.',
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    renderLanding('es')
    fillCompanyName()
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
    const button = await screen.findByRole('button', { name: 'Subir documentos' })
    expect(assign).not.toHaveBeenCalled()
    expect(stashHandoff).not.toHaveBeenCalled()
    fireEvent.click(button)
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    continuedWithHandoffNonce(assign)
    expect(stashHandoff).toHaveBeenCalledWith(expect.objectContaining({ files: [file] }))
    fetchMock.mockRestore()
  })

  it('signs out without uploading from the destination notice', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    vi.mocked(readLandingDestination).mockResolvedValue({
      status: 'FOUND',
      companyName: 'Sample Foods, S.A.',
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    renderLanding('es')
    fillCompanyName()
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
    const button = await screen.findByRole('button', { name: 'Cerrar sesión' })
    expect(assign).not.toHaveBeenCalled()
    expect(stashHandoff).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(assign).toHaveBeenCalledWith('/logout')
    expect(stashHandoff).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('checks the destination again after a confirmed upload cannot preserve the handoff', async () => {
    vi.mocked(readLandingDestination)
      .mockResolvedValueOnce({ status: 'FOUND', companyName: 'Sample Foods, S.A.' })
      .mockResolvedValueOnce({ status: 'UNAVAILABLE' })
    vi.mocked(stashHandoff).mockResolvedValue(false)
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    renderLanding('es')
    fillCompanyName()
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Subir documentos' }))
    await waitFor(() => expect(stashHandoff).toHaveBeenCalledOnce())
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
    await waitFor(() => expect(readLandingDestination).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos verificar el Data Room de destino.'
    )
    expect(stashHandoff).toHaveBeenCalledOnce()
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.includes('/api/intake/uploads')
      })
    ).toBe(false)
    fetchMock.mockRestore()
  })

  it.each([
    { action: 'Quitar todos', retainedCount: 0 },
    { action: 'Quitar estados.pdf', retainedCount: 1 },
  ])(
    'does not continue when $action changes the selection during the destination lookup',
    async ({ action, retainedCount }) => {
      let finishLookup = () => {}
      vi.mocked(readLandingDestination).mockReturnValue(
        new Promise((resolve) => {
          finishLookup = () => resolve({ status: 'NONE' })
        })
      )
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
      const retained = new File(['balance'], 'balance.pdf', { type: 'application/pdf' })

      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file, retained] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
      await waitFor(() => expect(readLandingDestination).toHaveBeenCalledOnce())

      fireEvent.click(screen.getByRole('button', { name: action }))
      await act(async () => finishLookup())

      expect(stashHandoff).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(screen.queryByText('estados.pdf')).not.toBeInTheDocument()
      expect(screen.queryAllByText('balance.pdf')).toHaveLength(retainedCount)
      fetchMock.mockRestore()
    }
  )

  it('preserves the selection and retries when the destination is unavailable', async () => {
    vi.mocked(readLandingDestination).mockResolvedValue({ status: 'UNAVAILABLE' })
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    renderLanding('es')
    fillCompanyName()
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos verificar el Data Room de destino. La selección sigue aquí; inténtalo de nuevo.'
    )
    expect(screen.getByText('estados.pdf')).toBeInTheDocument()
    expect(stashHandoff).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
    await waitFor(() => expect(readLandingDestination).toHaveBeenCalledTimes(2))
    expect(stashHandoff).not.toHaveBeenCalled()
  })

  it('places the one primary selector before the format and limit instructions', () => {
    renderLanding('es')
    fillCompanyName()

    const dossier = screen.getByTestId('mycroft-upload-dossier')
    const selector = within(dossier).getByText('Seleccionar documentos', { selector: 'button' })
    const formats = within(dossier).getByRole('list', { name: 'Formatos de documentos' })

    expect(
      selector.compareDocumentPosition(formats) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      within(dossier).getAllByText('Seleccionar documentos', { selector: 'button' })
    ).toHaveLength(1)
  })

  // [F] 2026-09-14, mock B: el disclaimer vive en el footer compartido.
  it('does not show an investment-advice disclaimer on the landing', () => {
    renderLanding('es')
    fillCompanyName()

    expect(screen.queryByText('Esto no es asesoría de inversión.')).toBeNull()
  })

  it('renders the selector with the ochre variant', () => {
    renderLanding('es')
    fillCompanyName()

    expect(screen.getByText('Seleccionar documentos', { selector: 'button' })).toHaveAttribute(
      'data-variant',
      'ochre'
    )
  })

  it('keeps the technical file input out of Tab order while the visible selector opens it', () => {
    renderLanding('es')
    fillCompanyName()

    const dossier = screen.getByTestId('mycroft-upload-dossier')
    const input = within(dossier).getByLabelText('Seleccionar documentos')
    const selector = within(dossier).getByText('Seleccionar documentos', { selector: 'button' })
    const clickInput = vi.spyOn(input, 'click')

    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('tabindex', '-1')
    expect(selector).toHaveAttribute('type', 'button')

    fireEvent.click(selector)

    expect(clickInput).toHaveBeenCalledOnce()
  })

  // [F] 2026-09-14: una sola pantalla, sin lead ni secciones repetidas.
  it('keeps the headline, example and deliverables without repeating the pitch', () => {
    renderLanding('es')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Sube tus documentos. Recibe tu modelo financiero.'
    )
    expect(
      screen.getByRole('table', { name: 'Modelo_v1.xlsx, Ejemplo ilustrativo' })
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Qué recibes' })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Tres pasos. El primero lo das tú.' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Maintainer y Reviewer preparan y revisan cada entrega con nuestro software.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Maintainer y Reviewer revisan lo que subes/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Hasta 20 archivos|250 MB/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Empieza tu Data Room' })).not.toBeInTheDocument()
  })

  // El nombre de la empresa se pide arriba, no detrás de una selección de
  // archivos, y es requerido: sin él no hay destino que buscar ([F] 2026-09-14).
  it('requires the company name before any file is selected', () => {
    renderLanding('es')
    fillCompanyName()

    const field = screen.getByLabelText('Nombre de tu empresa')
    expect(field).toHaveAttribute('type', 'text')
    expect(field).toHaveAttribute('required')
    expect(field).toHaveAttribute('aria-required', 'true')
    expect(field).toHaveAttribute('placeholder', 'Escribe el nombre de tu empresa')
    expect(screen.queryByRole('link', { name: /Siguiente/i })).toBeNull()
  })

  // La puerta es de verdad: con el nombre vacío no se busca destino, no se
  // guarda el sobre y no se llama a la API.
  it('blocks continuation without a company name and asks for it', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    renderLanding('es')
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })

    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Escribe el nombre de tu empresa para seguir.'
    )
    expect(assign).not.toHaveBeenCalled()
    expect(stashHandoff).not.toHaveBeenCalled()
    expect(readLandingDestination).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  // El mock B enlaza al MCP del cliente; no restaura conectores retirados.
  it('keeps file selection local and does not announce unsupported connectors', () => {
    renderLanding('es')
    fillCompanyName()

    expect(screen.getByTestId('mycroft-upload-dossier')).toBeInTheDocument()
    expect(screen.queryByTestId('mycroft-channel-mcp')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mycroft-channel-drive')).not.toBeInTheDocument()
    expect(screen.queryByText('Google Drive')).not.toBeInTheDocument()
  })

  it('leads with the headline and keeps the selector local', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderLanding('es')
    fillCompanyName()

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /^Sube tus documentos\.\s+Recibe tu modelo financiero\.$/,
      })
    ).toBeInTheDocument()
    const file = new File(['financials'], 'estados-financieros.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })

    expect(screen.getByText('estados-financieros.pdf')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Siguiente/i })).toHaveLength(1)
    for (const link of screen.getAllByRole('link', { name: /Siguiente/i })) {
      expect(link).toHaveAttribute('href', roomSecureHref('es'))
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('uses the provided secureHref for the continuation CTA', () => {
    renderLanding('es', '/es/ayuda')
    fillCompanyName()

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: {
        files: [new File(['model'], 'model.xlsx', { type: 'application/vnd.ms-excel' })],
      },
    })

    expect(screen.getAllByRole('link', { name: /Siguiente/i })).toHaveLength(1)
    for (const link of screen.getAllByRole('link', {
      name: /Siguiente/i,
    })) {
      expect(link).toHaveAttribute('href', '/es/ayuda')
    }
  })

  it('links the MCP instructions to the help anchor', () => {
    renderLanding('es')

    expect(screen.getByRole('link', { name: 'Cómo conectarlo' })).toHaveAttribute(
      'href',
      '/ayuda#mcp'
    )
  })

  it('copies the public MCP URL and resets the acknowledgement after two seconds', async () => {
    vi.useFakeTimers()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    try {
      renderLanding('es')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copiar' }))
      })
      // El endpoint sale del host del deployment (QA post-deploy de #776: staging
      // copiaba el de producción).
      expect(writeText).toHaveBeenCalledWith(
        new URL('/api/vdr-mcp', `${getPublicAppUrl().replace(/\/$/, '')}/`).href
      )
      expect(screen.getByRole('button', { name: 'Copiado' })).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole('button', { name: 'Copiar' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers manual copying when the clipboard refuses the URL', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('permission denied'))
    renderLanding('es')
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No pudimos copiar. Selecciona la URL y cópiala manualmente.'
    )
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeInTheDocument()
  })

  it.each(['captura.png', 'contexto.md', 'notas.txt', 'documentos.zip'])(
    'rejects unsupported document format %s before custody or continuation',
    (name) => {
      renderLanding('es')
      fillCompanyName()

      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [new File(['context'], name)] },
      })

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Uno de los archivos no es compatible. Usa PDF, Excel, Word, PowerPoint o CSV.'
      )
      expect(screen.queryByText(name)).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /Siguiente/i })).toBeNull()
      expect(vi.mocked(stashHandoff)).not.toHaveBeenCalled()
    }
  )

  it('rejects CSV above 20 MB before temporary intake or handoff', () => {
    renderLanding('es')
    fillCompanyName()
    const file = new File(['balance'], 'balance.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: MAX_CSV_UPLOAD_BYTES + 1 })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Un CSV supera 20 MB o cualquier otro archivo supera 50 MB.'
    )
    expect(screen.queryByText('balance.csv')).not.toBeInTheDocument()
  })

  it('rejects unsupported files before showing a continuation action', () => {
    renderLanding('es')
    fillCompanyName()

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [new File(['unsafe'], 'archivo.exe')] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Uno de los archivos no es compatible. Usa PDF, Excel, Word, PowerPoint o CSV.'
    )
    expect(screen.queryByRole('link', { name: /Siguiente/i })).toBeNull()
  })

  it('shows sub-megabyte sizes in KB and never renders "0 MB"', () => {
    renderLanding('es')
    fillCompanyName()
    const tiny = new File(['pequeño'], 'estados.pdf', { type: 'application/pdf' })
    const big = new File(['x'], 'modelo.xlsx', { type: 'application/vnd.ms-excel' })
    Object.defineProperty(tiny, 'size', { value: 477 })
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [tiny, big] },
    })

    expect(screen.getByText('1 KB')).toBeInTheDocument()
    expect(screen.getByText('2 MB')).toBeInTheDocument()
    expect(screen.getByText(/Total: 2 MB/)).toBeInTheDocument()
    expect(screen.queryByText(/\b0 MB/)).toBeNull()
  })

  it('rejects a file over the 50 MB direct-upload ceiling before stashing', () => {
    renderLanding('es')
    fillCompanyName()
    const oversized = new File(['x'], 'deck.pdf', { type: 'application/pdf' })
    Object.defineProperty(oversized, 'size', { value: MAX_DIRECT_UPLOAD_BYTES + 1 })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [oversized] },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Un CSV supera 20 MB o cualquier otro archivo supera 50 MB.'
    )
    expect(screen.queryByRole('link', { name: /Siguiente/i })).toBeNull()
    expect(vi.mocked(stashHandoff)).not.toHaveBeenCalled()
  })

  it('accepts a twenty-first file and preserves the first twenty', () => {
    renderLanding('es')
    fillCompanyName()
    const firstBatch = Array.from(
      { length: 20 },
      (_, index) => new File(['x'], `doc-${index}.pdf`, { type: 'application/pdf' })
    )

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: firstBatch },
    })
    expect(screen.getByText('20 documentos')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [new File(['x'], 'doc-20.pdf', { type: 'application/pdf' })] },
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('21 documentos')).toBeInTheDocument()
    expect(screen.getByText('doc-0.pdf')).toBeInTheDocument()
    expect(screen.getByText('doc-20.pdf')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Siguiente/i }).length).toBeGreaterThan(0)
  })

  it('accepts a batch above 250 MB and preserves the existing selection', () => {
    renderLanding('es')
    fillCompanyName()
    const retained = new File(['x'], 'retained.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [retained] },
    })

    const oversizedBatch = Array.from({ length: 6 }, (_, index) => {
      const file = new File(['x'], `model-${index}.xlsx`, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      Object.defineProperty(file, 'size', { value: 45 * 1024 * 1024 })
      return file
    })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: oversizedBatch },
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('retained.pdf')).toBeInTheDocument()
    expect(screen.getByText('model-0.xlsx')).toBeInTheDocument()
  })

  it('keeps one copy when the same file is selected again', () => {
    renderLanding('es')
    fillCompanyName()
    const file = new File(['financials'], 'estados.pdf', {
      type: 'application/pdf',
      lastModified: 123,
    })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })

    expect(screen.getByText('1 documento')).toBeInTheDocument()
    expect(screen.getAllByText('estados.pdf')).toHaveLength(1)
  })

  it('keeps one copy when a picker returns duplicate files in the same batch', () => {
    renderLanding('es')
    fillCompanyName()
    const first = new File(['financials'], 'estados.pdf', {
      type: 'application/pdf',
      lastModified: 123,
    })
    const duplicate = new File(['financials'], 'estados.pdf', {
      type: 'application/pdf',
      lastModified: 123,
    })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [first, duplicate] },
    })

    expect(screen.getByText('1 documento')).toBeInTheDocument()
    expect(screen.getAllByText('estados.pdf')).toHaveLength(1)
  })

  // La lista usaba `nombre:tamaño:lastModified` como `key` de React — la misma
  // llave con que se dedupea. Dos filas que la compartieran colapsaban en una
  // sola mientras el conteo seguía diciendo `files.length`. Ahora cada archivo
  // aceptado lleva un id propio y el conteo y las filas salen del MISMO arreglo.
  it('renders exactly one row per counted document, and removing one drops only that row', () => {
    renderLanding('es')
    fillCompanyName()
    const first = new File(['uno'], 'estados.pdf', { type: 'application/pdf', lastModified: 111 })
    const second = new File(['dos'], 'estados.pdf', { type: 'application/pdf', lastModified: 222 })

    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [first, second] },
    })

    const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
    expect(screen.getByText('2 documentos')).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(within(list).getAllByRole('button', { name: 'Quitar estados.pdf' })[0])

    expect(screen.getByText('1 documento')).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
  })

  // Volver a soltar el mismo archivo no hacía NADA visible: parecía que la
  // página se había tragado el gesto. El rechazo se dice en línea y se va solo.
  it('says the file is already listed for three seconds and then clears the notice', () => {
    vi.useFakeTimers()
    try {
      renderLanding('es')
      fillCompanyName()
      const file = new File(['financials'], 'estados.pdf', {
        type: 'application/pdf',
        lastModified: 123,
      })

      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      expect(screen.queryByTestId('intake-duplicate-notice')).not.toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })

      expect(screen.getByTestId('intake-duplicate-notice')).toHaveTextContent('Ya está en la lista')
      // El duplicado no entra: la lista y el conteo siguen en uno.
      expect(screen.getByText('1 documento')).toBeInTheDocument()
      expect(
        within(screen.getByRole('list', { name: 'Documentos seleccionados' })).getAllByRole(
          'listitem'
        )
      ).toHaveLength(1)

      act(() => {
        vi.advanceTimersByTime(3_000)
      })

      expect(screen.queryByTestId('intake-duplicate-notice')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stages a mode-on selection and continues to the hosted claim path without URL authority', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [{ id: 0, file }],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: HANDOFF_NONCE,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, csrfToken: 'csrf-bootstrap' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent_1',
            uploadUrl: 'https://test.convex.cloud/api/storage/upload',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ registered: true, document: { id: 'intake_document_1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.change(screen.getByLabelText('Nombre de tu empresa'), {
        target: { value: 'Acme Panamá' },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      const nonce = continuedWithHandoffNonce(assign)
      expect(stashHandoff).toHaveBeenCalledWith({
        files: [file],
        companyName: 'Acme Panamá',
        nonce,
      })
      expect(ackHandoffFiles).toHaveBeenCalledWith([0])
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        name: 'Acme Panamá',
      })
      expect(assign.mock.calls.flat().join(' ')).not.toContain('token')
      expect(assign.mock.calls.flat().join(' ')).not.toContain('authority')
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  it('uses enabled temporary intake even when IndexedDB continuity is unavailable', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    vi.mocked(stashHandoff).mockResolvedValue(false)
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, csrfToken: 'csrf-bootstrap' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent_no_idb',
            uploadUrl: 'https://test.convex.cloud/api/storage/upload',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ registered: true, document: { id: 'document_no_idb' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      // Sin sobre no hay llave que presentar: la sala no tiene nada que reclamar.
      await waitFor(() => expect(assign).toHaveBeenCalledWith(roomSecureHref('es')))
      expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(true)
      expect(assign).not.toHaveBeenCalledWith('/es/intake')
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  it('acknowledges only durably staged files when a mode-on batch partially fails', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    const uploaded = new File(['financials'], 'subido.pdf', { type: 'application/pdf' })
    const failed = new File(['model'], 'fallido.xls', { type: 'application/vnd.ms-excel' })
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [
        { id: 0, file: uploaded },
        { id: 1, file: failed },
      ],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: HANDOFF_NONCE,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, csrfToken: 'csrf-bootstrap' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent_uploaded',
            uploadUrl: 'https://test.convex.cloud/api/storage/upload',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ registered: true, document: { id: 'intake_uploaded' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [uploaded, failed] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      continuedWithHandoffNonce(assign)
      expect(ackHandoffFiles).toHaveBeenCalledTimes(1)
      expect(ackHandoffFiles).toHaveBeenCalledWith([0])
      expect(ackHandoffFiles).not.toHaveBeenCalledWith([1])
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  it.each(['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'])(
    'stages CSV MIME alias %s as text/csv in the enabled temporary intake',
    async (declaredType) => {
      const originalLocation = window.location
      const assign = vi.fn()
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, assign },
        writable: true,
        configurable: true,
      })
      const file = new File(['context'], 'contexto.csv', { type: declaredType })
      vi.mocked(peekHandoff).mockResolvedValue({
        status: 'READY',
        files: [{ id: 0, file }],
        companyName: null,
        stashedAt: HANDOFF_STASHED_AT,
        nonce: HANDOFF_NONCE,
      })
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        // Con nombre la sesión se rota antes de pedir el intent ([F] 2026-09-14).
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ authorized: true, csrfToken: 'csrf-rotated', documents: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              intentId: 'intent_csv',
              uploadUrl: 'https://test.convex.cloud/api/storage/upload',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ registered: true, document: { id: 'document_csv' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [file] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

        await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
        continuedWithHandoffNonce(assign)
        expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(true)
        const intentCall = fetchMock.mock.calls.find(([input]) => input === '/api/intake/uploads')
        expect(JSON.parse(String(intentCall?.[1]?.body))).toMatchObject({
          fileName: 'contexto.csv',
          declaredMimeType: 'text/csv',
        })
        expect(ackHandoffFiles).toHaveBeenCalledWith([0])
      } finally {
        fetchMock.mockRestore()
        Object.defineProperty(window, 'location', {
          value: originalLocation,
          writable: true,
          configurable: true,
        })
      }
    }
  )

  it('preserves the permanent WorkOS continuation when intake mode is off', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))

    try {
      renderLanding('es')
      fillCompanyName()
      const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })

      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      const nonce = continuedWithHandoffNonce(assign)
      expect(vi.mocked(stashHandoff)).toHaveBeenCalledWith({
        files: [file],
        companyName: 'Ferretería Demo',
        nonce,
      })
      expect(ackHandoffFiles).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Un campo con solo espacios no es un nombre: cuenta como vacío y la
  // continuación se queda en la landing pidiendo el nombre.
  it('blocks continuation when the company name is only whitespace', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    renderLanding('es')
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
      target: { files: [file] },
    })
    fireEvent.change(screen.getByLabelText('Nombre de tu empresa'), {
      target: { value: '   ' },
    })

    fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Escribe el nombre de tu empresa para seguir.'
    )
    expect(assign).not.toHaveBeenCalled()
    expect(stashHandoff).not.toHaveBeenCalled()
    expect(readLandingDestination).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  // Un teléfono con muchos megabytes tarda más que cualquier reloj razonable. Antes esto
  // corría el stash contra un timeout de 8 s: el intake seguía con la lista
  // vacía, el stash terminaba después y los mismos bytes llegaban dos veces —
  // por el claim y por el handoff — porque el ingest de la sala no dedupea.
  it('waits for the parked bytes instead of racing them against a timeout', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    let releaseStash: (stashed: boolean) => void = () => {}
    vi.mocked(stashHandoff).mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseStash = resolve
      })
    )
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [{ id: 0, file }],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: HANDOFF_NONCE,
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      expect(await screen.findByText('Preparando tus documentos…')).toBeVisible()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()

      releaseStash(true)

      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      continuedWithHandoffNonce(assign)
      expect(vi.mocked(discardHandoff)).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Si el navegador de verdad no pudo guardar nada, los bytes viajan solo por
  // intake y el sobre viejo se tira: un camino para los bytes, nunca dos.
  it('discards any parked intake when the stash itself fails', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    vi.mocked(stashHandoff).mockResolvedValue(false)
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, csrfToken: 'csrf-bootstrap' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent_sin_idb',
            uploadUrl: 'https://test.convex.cloud/api/storage/upload',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ registered: true, document: { id: 'intake_sin_idb' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await waitFor(() => expect(assign).toHaveBeenCalledWith(roomSecureHref('es')))
      expect(vi.mocked(discardHandoff)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(peekHandoff)).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Mientras el sobre se guarda, la selección es la que va a viajar: quitar un
  // archivo, vaciar la lista o agregar otro en ese instante pisaba el flujo en
  // curso con una lista distinta a la que ya se estaba parqueando.
  it('freezes the selection while the documents are being prepared', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    vi.mocked(stashHandoff).mockReturnValue(new Promise<boolean>(() => {}))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      expect(await screen.findByText('Preparando tus documentos…')).toBeVisible()
      expect(screen.getByLabelText('Nombre de tu empresa')).toBeDisabled()
      expect(screen.getByLabelText('Seleccionar documentos')).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Seleccionar documentos' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Quitar todos' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Quitar estados.pdf' })).toBeDisabled()

      fireEvent.click(screen.getByRole('button', { name: 'Quitar todos' }))
      fireEvent.drop(screen.getByText('Arrastra tus documentos aquí o selecciónalos'), {
        dataTransfer: {
          files: [new File(['otro'], 'otro.pdf', { type: 'application/pdf' })],
        },
      })
      expect(screen.getByText('estados.pdf')).toBeVisible()
      expect(screen.queryByText('otro.pdf')).not.toBeInTheDocument()
      expect(assign).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // iOS Safari restaura la página desde el bfcache con el estado de React
  // intacto: Atrás desde WorkOS dejaba el botón en "Preparando…" para siempre.
  it('restores the continuation button when the page comes back from the bfcache', async () => {
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      expect(screen.getByText('Preparando tus documentos…')).toBeVisible()

      const restored = new Event('pageshow')
      Object.defineProperty(restored, 'persisted', { value: true })
      fireEvent(window, restored)

      expect(await screen.findByRole('link', { name: /Siguiente/i })).toBeVisible()
      expect(screen.getByLabelText('Nombre de tu empresa')).toBeEnabled()

      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(2))
      expect(vi.mocked(stashHandoff)).toHaveBeenCalledTimes(2)
    } finally {
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Safari 14 tras cerrar pestañas: `indexedDB.open` no dispara ningún evento y
  // el stash nunca resuelve, así que el botón se quedaba colgado. Con la cota, el
  // flujo sigue por intake sin llave (ese sobre tardío no se puede reclamar) y,
  // si intake está apagado, la selección se queda aquí con un error claro.
  it('gives up on a hung stash after thirty seconds and keeps the selection with a clear error', async () => {
    vi.useFakeTimers()
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    vi.mocked(stashHandoff).mockReturnValue(new Promise<boolean>(() => {}))
    vi.mocked(discardHandoff).mockReturnValue(new Promise<boolean>(() => {}))
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('Preparando tus documentos…')).toBeVisible()

      await vi.advanceTimersByTimeAsync(29_000)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(screen.getByText('Preparando tus documentos…')).toBeVisible()

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchMock).toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tu navegador no pudo conservar los archivos para continuar. La selección sigue aquí; inténtalo de nuevo.'
      )
      expect(screen.getByText('estados.pdf')).toBeVisible()
      expect(screen.getByRole('link', { name: /Siguiente/i })).toBeVisible()
      expect(vi.mocked(discardHandoff)).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  it('continues through temporary intake without a handoff key when the stash hangs', async () => {
    vi.useFakeTimers()
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    vi.mocked(stashHandoff).mockReturnValue(new Promise<boolean>(() => {}))
    vi.mocked(discardHandoff).mockReturnValue(new Promise<boolean>(() => {}))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, csrfToken: 'csrf-bootstrap' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent_colgado',
            uploadUrl: 'https://test.convex.cloud/api/storage/upload',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ registered: true, document: { id: 'intake_colgado' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await vi.advanceTimersByTimeAsync(30_000)
      // Después de la cota, el intake hashea con `file.arrayBuffer()` y
      // `crypto.subtle.digest`: trabajo real que el reloj falso no conduce. Veinte
      // ticks en cero alcanzaban solo con WebCrypto ya caliente por los tests de
      // arriba; corrido solo, este test pedía más de cien vueltas del event loop y
      // en Blacksmith falló igual (PR Gate 34913214555). `vi.waitFor` sondea con el
      // reloj real y avanza el falso 10 ms por intento, sin llegar a los 2,5 s de
      // la sonda de sesión.
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(roomSecureHref('es')), {
        timeout: 2_000,
        interval: 10,
      })
      expect(vi.mocked(peekHandoff)).not.toHaveBeenCalled()
      expect(vi.mocked(discardHandoff)).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Vencer la cota suelta la continuación, no cancela IndexedDB: el stash puede
  // terminar después y escribir un sobre que ninguna visita puede reclamar (la
  // continuación ya se fue sin llave) y que la sala tampoco borra. Se borra aquí,
  // bajo su propia llave.
  it('deletes the envelope of a stash that lands after its budget expired', async () => {
    vi.useFakeTimers()
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    let resolveStash: (value: boolean) => void = () => {}
    vi.mocked(stashHandoff).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveStash = resolve
      })
    )
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

      await vi.advanceTimersByTimeAsync(30_000)
      for (let tick = 0; tick < 20; tick += 1) await vi.advanceTimersByTimeAsync(0)
      expect(vi.mocked(discardHandoffWithNonce)).not.toHaveBeenCalled()

      // El stash llega tarde y sí alcanzó a escribir: ese sobre no se queda.
      resolveStash(true)
      for (let tick = 0; tick < 20; tick += 1) await vi.advanceTimersByTimeAsync(0)

      const parkedNonce = vi.mocked(stashHandoff).mock.calls[0]?.[0].nonce
      expect(parkedNonce).toMatch(UUID)
      expect(vi.mocked(discardHandoffWithNonce)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(discardHandoffWithNonce)).toHaveBeenCalledWith(parkedNonce)
      expect(assign).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      fetchMock.mockRestore()
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  // Cmd/Ctrl-click abría la sala en otra pestaña sin esperar al sobre: la
  // pestaña nueva llegaba con la llave a un IndexedDB vacío y el stash tardío
  // quedaba huérfano. El gesto de continuar espera el sobre siempre.
  it('waits for the stash before opening the room in a new tab', async () => {
    const replace = vi.fn()
    const popup = { location: { replace }, closed: false, opener: window, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    let resolveStash: (value: boolean) => void = () => {}
    vi.mocked(stashHandoff).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveStash = resolve
      })
    )
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
    const file = new File(['financials'], 'estados.pdf', { type: 'application/pdf' })

    try {
      renderLanding('es')
      fillCompanyName()
      fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }), { metaKey: true })

      await waitFor(() => expect(vi.mocked(stashHandoff)).toHaveBeenCalledTimes(1))
      expect(open).toHaveBeenCalledWith('about:blank', '_blank')
      expect(popup.opener).toBeNull()
      expect(replace).not.toHaveBeenCalled()
      expect(screen.getByText('Preparando tus documentos…')).toBeVisible()

      resolveStash(true)
      await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
      expect(open).toHaveBeenCalledTimes(1)
      const [href] = replace.mock.calls[0]
      const url = new URL(String(href), 'https://sherlock.capital')
      const returnTo = new URL(url.searchParams.get('returnTo') ?? '', 'https://sherlock.capital')
      expect(returnTo.searchParams.get('handoff')).toBe(
        vi.mocked(stashHandoff).mock.calls[0]?.[0].nonce
      )
      // Esta pestaña se queda en la landing y el formulario vuelve a estar vivo.
      await waitFor(() => expect(screen.getByLabelText('Nombre de tu empresa')).toBeEnabled())
    } finally {
      open.mockRestore()
      fetchMock.mockRestore()
    }
  })

  // F13 (auditoría 2026-09-06): el cliente ve qué archivo va, cuántos bytes
  // llegaron y puede cancelar sin perder lo que ya recibió el servidor.
  describe('carga con estado por archivo', () => {
    const MB = 1024 * 1024

    function sizedPdf(name: string, sizeBytes: number, content = name): File {
      const file = new File([content], name, { type: 'application/pdf', lastModified: 1 })
      Object.defineProperty(file, 'size', { value: sizeBytes })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(new TextEncoder().encode(content).buffer),
      })
      return file
    }

    // Sesión ya autorizada y un servidor de intake fiel en lo que importa: un
    // intent nuevo por archivo (un ISSUED viejo se supersede en el servidor),
    // `document` directo cuando la huella ya está registrada, y un registro
    // que confirma. Lo que varía por test es el XHR de los bytes.
    function stubIntakeFetch(options: { beforeRegister?: () => Promise<void> } = {}) {
      let intents = 0
      const shaByIntent = new Map<string, string>()
      const registeredShas = new Set<string>()
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/intake/session') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        if (url === '/api/intake/uploads') {
          const { declaredSha256 } = JSON.parse(String(init?.body)) as { declaredSha256: string }
          if (registeredShas.has(declaredSha256)) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  alreadyRegistered: true,
                  document: { id: `doc_${declaredSha256}` },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            )
          }
          intents += 1
          shaByIntent.set(`intent_${intents}`, declaredSha256)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                intentId: `intent_${intents}`,
                uploadUrl: 'https://test.convex.cloud/api/storage/upload',
              }),
              { status: 201, headers: { 'Content-Type': 'application/json' } }
            )
          )
        }
        if (url === '/api/intake/uploads/register') {
          await options.beforeRegister?.()
          const { intentId } = JSON.parse(String(init?.body)) as { intentId: string }
          registeredShas.add(shaByIntent.get(intentId) ?? intentId)
          return Promise.resolve(
            new Response(
              JSON.stringify({ registered: true, document: { id: `doc_${intentId}` } }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            )
          )
        }
        return Promise.reject(new TypeError(`unexpected fetch ${url}`))
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    function intentBodies(fetchMock: ReturnType<typeof stubIntakeFetch>) {
      return fetchMock.mock.calls
        .filter(([input]) => input === '/api/intake/uploads')
        .map(
          ([, init]) =>
            JSON.parse(String(init?.body)) as { fileName: string; supersedePending?: boolean }
        )
    }

    function intentFileNames(fetchMock: ReturnType<typeof stubIntakeFetch>) {
      return intentBodies(fetchMock).map((body) => body.fileName)
    }

    function stubLocation() {
      const originalLocation = window.location
      const assign = vi.fn()
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, assign },
        writable: true,
        configurable: true,
      })
      return {
        assign,
        restore: () =>
          Object.defineProperty(window, 'location', {
            value: originalLocation,
            writable: true,
            configurable: true,
          }),
      }
    }

    it('shows each file state and a byte progress bar while a file uploads', async () => {
      const location = stubLocation()
      stubIntakeFetch()
      const enVuelo = sizedPdf('estados.pdf', 4 * MB)
      const enCola = sizedPdf('modelo.pdf', 2 * MB)
      // El XHR reporta la mitad y se queda ahí: la fila tiene que decirlo.
      FakeXMLHttpRequest.onSend = (xhr) => xhr.progress(2 * MB, 4 * MB)

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [enVuelo, enCola] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

        const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
        expect(await within(list).findByText('Subiendo 2 MB de 4 MB')).toBeVisible()
        expect(within(list).getByText('En cola')).toBeVisible()

        const fileBar = screen.getByRole('progressbar', { name: 'estados.pdf' })
        expect(fileBar).toHaveAttribute('aria-valuenow', String(2 * MB))
        expect(fileBar).toHaveAttribute('aria-valuemin', '0')
        expect(fileBar).toHaveAttribute('aria-valuemax', String(4 * MB))
        expect(fileBar.firstElementChild).toHaveStyle({ width: '50%' })
        expect(fileBar.closest('[aria-live]:not([aria-live="off"])')).toBeNull()

        // La barra agregada suma los bytes recibidos de toda la selección.
        const totalBar = screen.getByRole('progressbar', { name: 'Subiendo 2 MB de 6 MB' })
        expect(totalBar).toHaveAttribute('aria-valuenow', String(2 * MB))
        expect(totalBar).toHaveAttribute('aria-valuemax', String(6 * MB))
        expect(screen.getByRole('button', { name: 'Cancelar carga' })).toBeEnabled()
        expect(location.assign).not.toHaveBeenCalled()
      } finally {
        location.restore()
      }
    })

    it('cancels the upload in flight and keeps what the server already received', async () => {
      const location = stubLocation()
      const fetchMock = stubIntakeFetch()
      const recibido = sizedPdf('recibido.pdf', 1 * MB)
      const enVuelo = sizedPdf('en-vuelo.pdf', 4 * MB)
      const enCola = sizedPdf('en-cola.pdf', 1 * MB)
      vi.mocked(peekHandoff).mockResolvedValue({
        status: 'READY',
        files: [
          { id: 0, file: recibido },
          { id: 1, file: enVuelo },
          { id: 2, file: enCola },
        ],
        companyName: null,
        stashedAt: HANDOFF_STASHED_AT,
        nonce: HANDOFF_NONCE,
      })
      // El primero llega; el segundo se queda a medias hasta que se cancele.
      FakeXMLHttpRequest.onSend = (xhr) => {
        if (FakeXMLHttpRequest.instances.length === 1) {
          xhr.respond(200, { storageId: 'storage_1' })
          return
        }
        xhr.progress(1 * MB, 4 * MB)
      }

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [recibido, enVuelo, enCola] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

        const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
        expect(await within(list).findByText('Subiendo 1 MB de 4 MB')).toBeVisible()
        expect(within(list).getByText('Recibido')).toBeVisible()

        fireEvent.click(screen.getByRole('button', { name: 'Cancelar carga' }))

        expect(
          await screen.findByText('Se guardaron 1 de 3. Puedes seguir cuando quieras.')
        ).toBeVisible()
        expect(FakeXMLHttpRequest.instances[1]?.aborted).toBe(true)
        expect(within(list).getByText('Recibido')).toBeVisible()
        expect(within(list).getAllByText('Cancelado')).toHaveLength(2)
        // El de la cola nunca pidió intent; el recibido quedó reconocido.
        expect(intentFileNames(fetchMock)).toEqual(['recibido.pdf', 'en-vuelo.pdf'])
        expect(ackHandoffFiles).toHaveBeenCalledTimes(1)
        expect(ackHandoffFiles).toHaveBeenCalledWith([0])
        expect(location.assign).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'Cancelar carga' })).not.toBeInTheDocument()
        expect(screen.getByLabelText('Nombre de tu empresa')).toBeEnabled()
        expect(screen.getByText('recibido.pdf')).toBeVisible()
        expect(screen.getByText('en-cola.pdf')).toBeVisible()

        // Volver a intentar: el cancelado vuelve a pedir intent (el servidor
        // supersede el ISSUED viejo y da URL nueva), sube y termina recibido;
        // el ya recibido vuelve como `document` sin abrir XHR.
        respondStorageImmediately()
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
        await waitFor(() => expect(location.assign).toHaveBeenCalledTimes(1))
        continuedWithHandoffNonce(location.assign)
        expect(intentFileNames(fetchMock)).toEqual([
          'recibido.pdf',
          'en-vuelo.pdf',
          'recibido.pdf',
          'en-vuelo.pdf',
          'en-cola.pdf',
        ])
        // Solo un archivo que ya terminó cancelado pide supersedir su intent;
        // el primer intento y el ya recibido no mandan el flag.
        expect(intentBodies(fetchMock).map((body) => body.supersedePending)).toEqual([
          undefined,
          undefined,
          undefined,
          true,
          true,
        ])
        expect(FakeXMLHttpRequest.instances).toHaveLength(4)
        expect(FakeXMLHttpRequest.instances[2]?.body).toBe(enVuelo)
        expect(within(list).getAllByText('Recibido')).toHaveLength(3)
        expect(within(list).queryByText('Cancelado')).not.toBeInTheDocument()
        expect(ackHandoffFiles).toHaveBeenLastCalledWith([2])
      } finally {
        location.restore()
      }
    })

    // Con los bytes ya en el proveedor, el intent puede estar INSPECTING en el
    // servidor: cancelar en ese instante no cancela nada y bloqueaba el
    // archivo media hora. El registro termina y ese archivo cuenta como
    // guardado; la cola sí se cancela.
    it('lets a file whose bytes already landed finish registering when the user cancels', async () => {
      const location = stubLocation()
      let releaseRegister: () => void = () => {}
      const registerGate = new Promise<void>((resolve) => {
        releaseRegister = resolve
      })
      stubIntakeFetch({ beforeRegister: () => registerGate })
      const completo = sizedPdf('completo.pdf', 1 * MB)
      const enCola = sizedPdf('en-cola.pdf', 1 * MB)
      FakeXMLHttpRequest.onSend = (xhr) => {
        xhr.progress(1 * MB, 1 * MB)
        xhr.respond(200, { storageId: 'storage_1' })
      }

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [completo, enCola] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

        const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
        // La barra está al 100 % y el registro todavía no respondió.
        expect(await within(list).findByText('Subiendo 1 MB de 1 MB')).toBeVisible()
        expect(within(list).getByText('En cola')).toBeVisible()

        fireEvent.click(screen.getByRole('button', { name: 'Cancelar carga' }))
        releaseRegister()

        expect(
          await screen.findByText('Se guardaron 1 de 2. Puedes seguir cuando quieras.')
        ).toBeVisible()
        expect(within(list).getByText('Recibido')).toBeVisible()
        expect(within(list).getByText('Cancelado')).toBeVisible()
        expect(FakeXMLHttpRequest.instances).toHaveLength(1)
        expect(location.assign).not.toHaveBeenCalled()
      } finally {
        location.restore()
      }
    })

    // iOS Safari restaura la página desde el bfcache con el estado de React
    // intacto. Soltar `abortRef` sin abortar dejaba el XHR subiendo detrás de
    // un formulario ya libre, y un segundo Siguiente corría en paralelo.
    it('aborts the upload in flight when the page comes back from the bfcache and lets a fresh run own the form', async () => {
      const location = stubLocation()
      const fetchMock = stubIntakeFetch()
      const enVuelo = sizedPdf('en-vuelo.pdf', 4 * MB)
      const enCola = sizedPdf('en-cola.pdf', 1 * MB)
      FakeXMLHttpRequest.onSend = (xhr) => xhr.progress(1 * MB, 4 * MB)

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [enVuelo, enCola] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
        const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
        expect(await within(list).findByText('Subiendo 1 MB de 4 MB')).toBeVisible()

        const restored = new Event('pageshow')
        Object.defineProperty(restored, 'persisted', { value: true })
        fireEvent(window, restored)

        // La carga en vuelo se cancela y el formulario vuelve a estar libre.
        expect(FakeXMLHttpRequest.instances[0]?.aborted).toBe(true)
        expect(await screen.findByRole('link', { name: /Siguiente/i })).toBeVisible()
        expect(screen.getByLabelText('Nombre de tu empresa')).toBeEnabled()
        expect(screen.queryByRole('button', { name: 'Cancelar carga' })).not.toBeInTheDocument()
        expect(location.assign).not.toHaveBeenCalled()

        // Un segundo Siguiente corre solo, con su propia corrida.
        respondStorageImmediately()
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))
        await waitFor(() => expect(location.assign).toHaveBeenCalledTimes(1))
        continuedWithHandoffNonce(location.assign)
        expect(vi.mocked(stashHandoff)).toHaveBeenCalledTimes(2)
        expect(intentFileNames(fetchMock)).toEqual(['en-vuelo.pdf', 'en-vuelo.pdf', 'en-cola.pdf'])
        expect(within(list).getAllByText('Recibido')).toHaveLength(2)
        // La corrida vieja terminó tarde y no pintó su cancelación encima.
        expect(within(list).queryByText('Cancelado')).not.toBeInTheDocument()
        expect(screen.queryByText(/Se guardaron/)).not.toBeInTheDocument()
      } finally {
        location.restore()
      }
    })

    it('summarises a batch that finished with failures when nothing could be stashed', async () => {
      const location = stubLocation()
      vi.mocked(stashHandoff).mockResolvedValue(false)
      const recibido = sizedPdf('recibido.pdf', 1 * MB)
      const fallido = sizedPdf('fallido.pdf', 1 * MB)
      let intents = 0
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/intake/session') {
            return Promise.resolve(
              new Response(
                JSON.stringify({ authorized: true, csrfToken: 'csrf-session', documents: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            )
          }
          if (url === '/api/intake/uploads') {
            intents += 1
            return Promise.resolve(
              intents === 1
                ? new Response(
                    JSON.stringify({
                      intentId: 'intent_1',
                      uploadUrl: 'https://test.convex.cloud/api/storage/upload',
                    }),
                    { status: 201, headers: { 'Content-Type': 'application/json' } }
                  )
                : new Response(JSON.stringify({ error: 'unavailable' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                  })
            )
          }
          return Promise.resolve(
            new Response(JSON.stringify({ registered: true, document: { id: 'doc_1' } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        })
      )

      try {
        renderLanding('es')
        fillCompanyName()
        fireEvent.change(screen.getByLabelText('Seleccionar documentos'), {
          target: { files: [recibido, fallido] },
        })
        fireEvent.click(screen.getByRole('link', { name: /Siguiente/i }))

        expect(
          await screen.findByText('Recibimos 1 de 2. Vuelve a intentar los que faltan.')
        ).toBeVisible()
        const list = screen.getByRole('list', { name: 'Documentos seleccionados' })
        expect(within(list).getByText('Recibido')).toBeVisible()
        expect(within(list).getByText('No se pudo subir')).toBeVisible()
        // Una sola voz: el resumen con la cuenta reemplaza al alert genérico.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(location.assign).not.toHaveBeenCalled()
        expect(screen.getByRole('link', { name: /Siguiente/i })).toBeVisible()
      } finally {
        location.restore()
      }
    })
  })

  // STALE_TEST O2-06: la landing pública no consulta sesión. El aviso de
  // cuenta del equipo exigía `useCurrentUser` y arrastraba Convex a `/es`.
  it('always shows the uploader, even without a session', () => {
    renderLanding()
    fillCompanyName()

    expect(screen.getByTestId('mycroft-upload-dossier')).toBeVisible()
    expect(screen.queryByTestId('mycroft-team-account-notice')).not.toBeInTheDocument()
  })
})
