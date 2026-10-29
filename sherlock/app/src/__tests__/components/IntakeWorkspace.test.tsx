import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IntakeWorkspace } from '@/components/mycroft/IntakeWorkspace'
import { ackHandoffFiles, peekHandoff } from '@/lib/mycroft/upload-handoff'
import { MAX_CSV_UPLOAD_BYTES } from '@/lib/storage/upload-limits'
import esMessages from '@/messages/es.json'
import { FakeXMLHttpRequest, installFakeXhr, respondStorageImmediately } from '../utils/fake-xhr'

vi.unmock('next-intl')

vi.mock('@/lib/mycroft/upload-handoff', () => ({
  ackHandoffFiles: vi.fn().mockResolvedValue(true),
  peekHandoff: vi.fn().mockResolvedValue({
    status: 'EMPTY',
    files: [],
    companyName: null,
    stashedAt: null,
    nonce: null,
  }),
}))

// Hora en que la landing parqueó el sobre; la sala la compara contra su propia
// fecha de creación antes de aplicarlo.
const HANDOFF_STASHED_AT = 1_780_000_000_000

function renderWorkspace(locale: 'es', authorized = false) {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      <IntakeWorkspace
        initialWorkspace={
          authorized
            ? {
                authorized: true,
                accessExpiresAt: Date.now() + 60_000,
                documents: [
                  {
                    id: 'intake_document_1',
                    displayName: 'FY 2024.xlsx',
                    declaredMimeType:
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    byteSize: 128,
                    inspectionStatus: 'CLEAN',
                    claimable: true,
                    createdAt: Date.now(),
                  },
                ],
              }
            : null
        }
      />
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// Los bytes viajan por XHR (progreso por bytes); intent y registro siguen por
// fetch. El XHR falso responde de inmediato salvo que un test lo detenga.
beforeEach(() => {
  installFakeXhr()
  respondStorageImmediately()
  vi.mocked(ackHandoffFiles).mockReset().mockResolvedValue(true)
  vi.mocked(peekHandoff).mockReset().mockResolvedValue({
    status: 'EMPTY',
    files: [],
    companyName: null,
    stashedAt: null,
    nonce: null,
  })
})

describe('IntakeWorkspace', () => {
  it('offers optional identity and skip in Panamanian Spanish', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authorized: false, csrfToken: 'csrf-bootstrap' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWorkspace('es')

    expect(
      screen.getByRole('heading', { name: 'Prepara tus documentos antes de registrarte' })
    ).toBeVisible()
    expect(screen.getByLabelText('Nombre de la empresa o persona (opcional)')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continuar sin nombre' })).toBeVisible()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/intake/session', expect.anything())
    )
  })

  it('sends and retains an optional identity name when a session is rotated', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorized: false, csrfToken: 'csrf-bootstrap' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorized: true, documents: [] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    renderWorkspace('es')
    await waitFor(() =>
      expect(screen.getByLabelText('Nombre de la empresa o persona (opcional)')).toBeVisible()
    )

    const nameInput = screen.getByLabelText('Nombre de la empresa o persona (opcional)')
    fireEvent.change(nameInput, { target: { value: 'Acme Panamá' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ name: 'Acme Panamá' })
    expect(await screen.findByText('Nombre guardado: Acme Panamá')).toBeVisible()
  })

  // El caso hermano montaba la sala en inglés para atrapar una fuga de español.
  // Retirado el locale, la fuga que importa es la contraria: una cadena inglesa
  // sobreviviendo en la única cara que se sirve.
  it('renders the Spanish workspace without an English leak', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )

    const { container } = renderWorkspace('es')

    expect(screen.getByRole('button', { name: 'Continuar sin nombre' })).toBeVisible()
    expect(container.textContent).not.toContain('Continue without a name')
  })

  it('shows staged documents and explicit access/deletion controls', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )

    renderWorkspace('es', true)

    expect(screen.getByText('FY 2024.xlsx')).toBeVisible()
    expect(screen.getByText('Verificado')).toBeVisible()
    expect(screen.getByText(/Acceso temporal hasta/)).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Habla con el equipo' })).toBeVisible()
    expect(screen.getByLabelText('Mensaje para el equipo')).toBeVisible()
    expect(
      screen.getByRole('link', { name: 'Crear cuenta y conservar el Data Room' })
    ).toHaveAttribute('href', '/sign-up?returnTo=%2Fes%2Fmy-company%2Fdocuments')
    expect(screen.getByRole('button', { name: 'Terminar acceso' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Eliminar mis datos temporales' })).toBeVisible()
  })

  it('shows the investment-advice disclaimer next to the claim CTA', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    )

    renderWorkspace('es', true)

    const claim = screen.getByRole('link', { name: 'Crear cuenta y conservar el Data Room' })
    const disclaimer = screen.getByText('Esto no es asesoría de inversión.')
    expect(disclaimer).toBeVisible()
    expect(disclaimer).toHaveClass('text-muted-foreground')
    expect(
      claim.compareDocumentPosition(disclaimer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('advertises CSV in the temporary picker with truthful per-format limits', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )

    renderWorkspace('es', true)

    expect(screen.getByLabelText('Agrega PDF, Excel, Word, PowerPoint o CSV')).toHaveAttribute(
      'accept',
      '.pdf,.xls,.xlsx,.doc,.docx,.ppt,.pptx,.csv'
    )
    expect(screen.getByText('CSV: 20 MB. PDF y Office: 50 MB.')).toBeVisible()
  })

  it('rejects CSV above 20 MB before hashing or requesting an upload intent', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (input === '/api/intake/support') {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authorized: true,
          csrfToken: 'csrf-session',
          accessExpiresAt: Date.now() + 60_000,
          documents: [],
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['balance'], 'balance.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: MAX_CSV_UPLOAD_BYTES + 1 })
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0))
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })

    renderWorkspace('es', true)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()
    )
    fireEvent.change(screen.getByLabelText('Agrega PDF, Excel, Word, PowerPoint o CSV'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Subir documentos' }))

    expect(
      await screen.findByText('Un CSV supera 20 MB o cualquier otro archivo supera 50 MB.')
    ).toBeVisible()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(false)
  })

  it.each(['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'])(
    'normalizes CSV MIME alias %s to text/csv before temporary upload',
    async (declaredType) => {
      const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
        if (input === '/api/intake/support') {
          return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
        }
        if (input === '/api/intake/uploads') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              intentId: 'intent_csv',
              uploadUrl: 'https://test.convex.cloud/api/storage/upload',
            }),
          })
        }
        if (input === '/api/intake/uploads/register') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              document: {
                id: 'document_csv',
                displayName: 'balance.csv',
                declaredMimeType: 'text/csv',
                byteSize: 7,
                inspectionStatus: 'CLEAN',
                claimable: true,
                createdAt: Date.now(),
              },
            }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'csrf-session',
            accessExpiresAt: Date.now() + 60_000,
            documents: [],
          }),
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const file = new File(['balance'], 'balance.csv', { type: declaredType })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(new TextEncoder().encode('balance').buffer),
      })

      renderWorkspace('es', true)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()
      )
      fireEvent.change(screen.getByLabelText('Agrega PDF, Excel, Word, PowerPoint o CSV'), {
        target: { files: [file] },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Subir documentos' }))

      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(true)
      )
      const intentCall = fetchMock.mock.calls.find(([input]) => input === '/api/intake/uploads')
      expect(JSON.parse(String(intentCall?.[1]?.body))).toMatchObject({
        fileName: 'balance.csv',
        declaredMimeType: 'text/csv',
      })
    }
  )

  it('rejects an incompatible MIME declaration for a .csv before hashing or upload', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (input === '/api/intake/support') {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authorized: true,
          csrfToken: 'csrf-session',
          accessExpiresAt: Date.now() + 60_000,
          documents: [],
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['not-an-image'], 'balance.csv', { type: 'image/png' })
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0))
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })

    renderWorkspace('es', true)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()
    )
    fireEvent.change(screen.getByLabelText('Agrega PDF, Excel, Word, PowerPoint o CSV'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Subir documentos' }))

    expect(
      await screen.findByText(
        'Este tipo de archivo no es compatible. Usa PDF, Excel, Word, PowerPoint o CSV.'
      )
    ).toBeVisible()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(false)
  })

  it('shows the English unsupported-type message when a handoff retry is incompatible', async () => {
    const failed = new File(['not-an-image'], 'balance.csv', { type: 'image/png' })
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0))
    Object.defineProperty(failed, 'arrayBuffer', { value: arrayBuffer })
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [{ id: 9, file: failed }],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: null,
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (input === '/api/intake/support') {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authorized: true,
          csrfToken: 'csrf-session',
          accessExpiresAt: Date.now() + 60_000,
          documents: [],
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWorkspace('es', true)
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar balance.csv' }))

    expect(
      await screen.findByText(
        'Este tipo de archivo no es compatible. Usa PDF, Excel, Word, PowerPoint o CSV.'
      )
    ).toBeVisible()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(ackHandoffFiles).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads')).toBe(false)
  })

  it('keeps deletion available in retained-only state after ending access', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/intake/support') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ messages: [] }),
        }) as Promise<Response>
      }
      if (input === '/api/intake/session' && init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ revoked: true }),
        }) as Promise<Response>
      }
      if (input === '/api/intake/data' && init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deleted: true }),
        }) as Promise<Response>
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authorized: true,
          csrfToken: 'csrf-session',
          documents: [],
        }),
      }) as Promise<Response>
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWorkspace('es', true)

    const endAccess = await screen.findByRole('button', { name: 'Terminar acceso' })
    await waitFor(() => expect(endAccess).toBeEnabled())
    fireEvent.click(endAccess)

    const endedCopy =
      'El acceso temporal terminó. Tus documentos siguen guardados. Puedes eliminarlos con el botón Eliminar mis datos temporales.'
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Eliminar mis datos temporales' })).toBeEnabled()
    )
    expect(screen.getAllByText(endedCopy)).toHaveLength(2)
    const deleteData = screen.getByRole('button', { name: 'Eliminar mis datos temporales' })
    expect(deleteData).toBeEnabled()

    fireEvent.click(deleteData)
    await waitFor(() =>
      expect(screen.getByText('Tus datos temporales fueron eliminados.')).toBeVisible()
    )
    expect(
      screen.queryByText(
        'El acceso temporal terminó. Tus documentos siguen guardados. Puedes eliminarlos con el botón Eliminar mis datos temporales.'
      )
    ).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/intake/data',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('shows an honest pending preparation state and one next action without an assessment', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )

    renderWorkspace('es', true)

    expect(screen.getByRole('heading', { name: 'Estado de preparación' })).toBeVisible()
    expect(screen.getByText('El análisis de tus documentos está pendiente.')).toBeVisible()
    expect(screen.getByText('El inventario de evidencia todavía no está disponible.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Agregar documentos' })).toBeVisible()
  })

  it('renders projected assessment evidence, confidence, review state, and one next action', async () => {
    const assessment = {
      id: 'assessment_1',
      intakeSessionId: 'intake_session_1',
      status: 'NEEDS_REVIEW',
      source: 'EXTERNAL',
      findings: [
        {
          category: 'financialStatements',
          evidenceDocumentIds: ['intake_document_1'],
          confidence: 0.82,
          reviewState: 'PENDING',
        },
      ],
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (input === '/api/intake/support') {
          return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'csrf-session',
            documents: [],
            assessment,
          }),
        })
      })
    )

    renderWorkspace('es')

    expect(await screen.findByRole('heading', { name: 'Evaluación de preparación' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Inventario de evidencia' })).toBeVisible()
    expect(screen.getByText('Estados financieros')).toBeVisible()
    expect(screen.getByText('82% de confianza')).toBeVisible()
    expect(screen.getByText('1 documento con evidencia')).toBeVisible()
    expect(screen.getByText('Pendiente de revisión')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Hablar con el equipo' })).toBeVisible()
  })

  it('clears a stale initial workspace when refresh reports an expired or revoked session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ authorized: false, retainedOnly: true, csrfToken: 'csrf-expired' }),
      })
    )

    renderWorkspace('es', true)

    await waitFor(() => expect(screen.queryByText('FY 2024.xlsx')).not.toBeInTheDocument())
    expect(
      screen.getByText(
        'El acceso temporal terminó. Tus documentos siguen guardados. Puedes eliminarlos con el botón Eliminar mis datos temporales.'
      )
    ).toBeVisible()
  })

  it('preserves a hydrated workspace when refresh fails transiently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: 'temporary failure' }),
      })
    )

    renderWorkspace('es', true)

    expect(await screen.findByText('FY 2024.xlsx')).toBeVisible()
    expect(
      await screen.findByText('No pudimos completar la solicitud. Intenta de nuevo.')
    ).toBeVisible()
  })

  it('shows a failed handoff with retry and remove actions while keeping staged documents', async () => {
    const failed = new File(['model'], 'fallido.pdf', { type: 'application/pdf' })
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [{ id: 7, file: failed }],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: null,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (input === '/api/intake/support') {
          return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'csrf-session',
            documents: [
              {
                id: 'intake_document_1',
                displayName: 'FY 2024.xlsx',
                declaredMimeType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                byteSize: 128,
                inspectionStatus: 'CLEAN',
                claimable: true,
                createdAt: Date.now(),
              },
            ],
            companyName: null,
          }),
        })
      })
    )

    renderWorkspace('es', true)

    expect(await screen.findByText('fallido.pdf')).toBeVisible()
    expect(screen.getByText('FY 2024.xlsx')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reintentar fallido.pdf' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Quitar fallido.pdf' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Quitar fallido.pdf' }))
    await waitFor(() => expect(ackHandoffFiles).toHaveBeenCalledWith([7]))
    expect(screen.queryByText('fallido.pdf')).not.toBeInTheDocument()
  })

  it('retries a failed handoff and keeps the previously staged document visible', async () => {
    const failed = new File(['model'], 'fallido.pdf', { type: 'application/pdf' })
    const retried = {
      id: 'intake_document_2',
      displayName: 'fallido.pdf',
      declaredMimeType: 'application/pdf',
      byteSize: 5,
      inspectionStatus: 'CLEAN',
      claimable: true,
      createdAt: Date.now(),
    }
    vi.mocked(peekHandoff).mockResolvedValue({
      status: 'READY',
      files: [{ id: 8, file: failed }],
      companyName: null,
      stashedAt: HANDOFF_STASHED_AT,
      nonce: null,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (input === '/api/intake/support') {
          return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
        }
        if (input === '/api/intake/uploads') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              intentId: 'intent_2',
              uploadUrl: 'https://test.convex.cloud/api/storage/upload',
            }),
          })
        }
        if (input === '/api/intake/uploads/register') {
          return Promise.resolve({ ok: true, json: async () => ({ document: retried }) })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'csrf-session',
            documents: [
              {
                id: 'intake_document_1',
                displayName: 'FY 2024.xlsx',
                declaredMimeType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                byteSize: 128,
                inspectionStatus: 'CLEAN',
                claimable: true,
                createdAt: Date.now(),
              },
              ...(input === '/api/intake/session' ? [retried] : []),
            ],
            companyName: null,
          }),
        })
      })
    )

    renderWorkspace('es', true)

    const retry = await screen.findByRole('button', { name: 'Reintentar fallido.pdf' })
    fireEvent.click(retry)

    await waitFor(() => expect(ackHandoffFiles).toHaveBeenCalledWith([8]))
    expect(await screen.findByText('FY 2024.xlsx')).toBeVisible()
    expect(screen.getByText('fallido.pdf')).toBeVisible()
  })

  // F13 (auditoría 2026-09-06): el lote pendiente muestra el estado de cada
  // archivo, sus bytes y se puede cancelar sin perder lo ya recibido.
  describe('carga con estado por archivo', () => {
    const MB = 1024 * 1024

    function sizedPdf(name: string, sizeBytes: number): File {
      const file = new File([name], name, { type: 'application/pdf', lastModified: 1 })
      Object.defineProperty(file, 'size', { value: sizeBytes })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(new TextEncoder().encode(name).buffer),
      })
      return file
    }

    // Sesión autorizada, un intent por archivo (salvo que el test lo rechace)
    // y un registro que confirma; los documentos registrados vuelven en el
    // refresh para que la lista del Data Room los muestre.
    function stubWorkspaceFetch(rejectIntentAt?: number) {
      let intents = 0
      const registered: Array<Record<string, unknown>> = []
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/intake/support') {
          return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) })
        }
        if (url === '/api/intake/uploads') {
          intents += 1
          if (intents === rejectIntentAt) {
            return Promise.resolve({ ok: false, json: async () => ({ error: 'unavailable' }) })
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              intentId: `intent_${intents}`,
              uploadUrl: 'https://test.convex.cloud/api/storage/upload',
            }),
          })
        }
        if (url === '/api/intake/uploads/register') {
          const { intentId } = JSON.parse(String(init?.body)) as { intentId: string }
          const document = {
            id: `document_${intentId}`,
            displayName: `${intentId}.pdf`,
            declaredMimeType: 'application/pdf',
            byteSize: 1,
            inspectionStatus: 'CLEAN',
            claimable: true,
            createdAt: Date.now(),
          }
          registered.push(document)
          return Promise.resolve({ ok: true, json: async () => ({ document }) })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'csrf-session',
            accessExpiresAt: Date.now() + 60_000,
            documents: [...registered],
          }),
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    async function selectAndUpload(files: File[]) {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()
      )
      fireEvent.change(screen.getByLabelText('Agrega PDF, Excel, Word, PowerPoint o CSV'), {
        target: { files },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Subir documentos' }))
    }

    it('shows each batch file state with a byte progress bar and a cancel action', async () => {
      stubWorkspaceFetch()
      FakeXMLHttpRequest.onSend = (xhr) => xhr.progress(2 * MB, 4 * MB)

      renderWorkspace('es', true)
      await selectAndUpload([sizedPdf('estados.pdf', 4 * MB), sizedPdf('modelo.pdf', 2 * MB)])

      expect(await screen.findByText('Subiendo 2 MB de 4 MB')).toBeVisible()
      expect(screen.getByText('En cola')).toBeVisible()
      const fileBar = screen.getByRole('progressbar', { name: 'estados.pdf' })
      expect(fileBar).toHaveAttribute('aria-valuenow', String(2 * MB))
      expect(fileBar).toHaveAttribute('aria-valuemax', String(4 * MB))
      const totalBar = screen.getByRole('progressbar', { name: 'Subiendo 2 MB de 6 MB' })
      expect(totalBar).toHaveAttribute('aria-valuenow', String(2 * MB))
      expect(totalBar).toHaveAttribute('aria-valuemax', String(6 * MB))
      expect(screen.getByRole('button', { name: 'Cancelar carga' })).toBeEnabled()
    })

    it('cancels the batch in flight and keeps the received document in the Data Room', async () => {
      const fetchMock = stubWorkspaceFetch()
      FakeXMLHttpRequest.onSend = (xhr) => {
        if (FakeXMLHttpRequest.instances.length === 1) {
          xhr.respond(200, { storageId: 'storage_1' })
          return
        }
        xhr.progress(1 * MB, 4 * MB)
      }

      renderWorkspace('es', true)
      await selectAndUpload([
        sizedPdf('recibido.pdf', 1 * MB),
        sizedPdf('en-vuelo.pdf', 4 * MB),
        sizedPdf('en-cola.pdf', 1 * MB),
      ])

      expect(await screen.findByText('Subiendo 1 MB de 4 MB')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar carga' }))

      expect(
        await screen.findByText('Se guardaron 1 de 3. Puedes seguir cuando quieras.')
      ).toBeVisible()
      expect(FakeXMLHttpRequest.instances[1]?.aborted).toBe(true)
      expect(screen.getByText('Recibido')).toBeVisible()
      expect(screen.getAllByText('Cancelado')).toHaveLength(2)
      // El de la cola nunca pidió intent; el recibido ya está en el Data Room.
      expect(
        fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads')
      ).toHaveLength(2)
      expect(await screen.findByText('intent_1.pdf')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Cancelar carga' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()

      // Volver a subir la misma selección: solo los que terminaron cancelados
      // piden supersedir su intent; el primer intento nunca mandó el flag.
      respondStorageImmediately()
      fireEvent.click(screen.getByRole('button', { name: 'Subir documentos' }))
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads')
        ).toHaveLength(5)
      )
      const intentBodies = fetchMock.mock.calls
        .filter(([input]) => input === '/api/intake/uploads')
        .map(
          ([, init]) =>
            JSON.parse(String(init?.body)) as { fileName: string; supersedePending?: boolean }
        )
      expect(intentBodies.map((body) => body.fileName)).toEqual([
        'recibido.pdf',
        'en-vuelo.pdf',
        'recibido.pdf',
        'en-vuelo.pdf',
        'en-cola.pdf',
      ])
      expect(intentBodies.map((body) => body.supersedePending)).toEqual([
        undefined,
        undefined,
        undefined,
        true,
        true,
      ])
    })

    // F13 (residuo): el flag se busca por huella del archivo, no por índice.
    // Cancelar, agregar un archivo y reintentar mueve el cancelado de posición;
    // aun así tiene que pedir supersedir su intent, y el nuevo no.
    it('re-selecting the cancelled file in another position still supersedes its intent', async () => {
      const fetchMock = stubWorkspaceFetch()
      FakeXMLHttpRequest.onSend = (xhr) => xhr.progress(1 * MB, 4 * MB)
      const cancelledFile = sizedPdf('en-vuelo.pdf', 4 * MB)

      renderWorkspace('es', true)
      await selectAndUpload([cancelledFile])
      // La fila y el resumen dicen lo mismo con un solo archivo: basta con uno visible.
      expect((await screen.findAllByText('Subiendo 1 MB de 4 MB'))[0]).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar carga' }))
      expect(
        await screen.findByText('Se guardaron 0 de 1. Puedes seguir cuando quieras.')
      ).toBeVisible()

      // Nueva selección: un archivo nuevo delante y el cancelado detrás (índice
      // 0 → 1). La misma huella (nombre, tamaño, lastModified) lo reconoce.
      respondStorageImmediately()
      await selectAndUpload([sizedPdf('nuevo.pdf', 1 * MB), sizedPdf('en-vuelo.pdf', 4 * MB)])
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads')
        ).toHaveLength(3)
      )
      const intentBodies = fetchMock.mock.calls
        .filter(([input]) => input === '/api/intake/uploads')
        .map(
          ([, init]) =>
            JSON.parse(String(init?.body)) as { fileName: string; supersedePending?: boolean }
        )
      expect(intentBodies.map((body) => [body.fileName, body.supersedePending])).toEqual([
        ['en-vuelo.pdf', undefined],
        ['nuevo.pdf', undefined],
        ['en-vuelo.pdf', true],
      ])
    })

    it('summarises a batch that finished with a failed file and keeps it listed to retry', async () => {
      stubWorkspaceFetch(2)

      renderWorkspace('es', true)
      await selectAndUpload([sizedPdf('recibido.pdf', 1 * MB), sizedPdf('fallido.pdf', 1 * MB)])

      expect(
        await screen.findByText('Recibimos 1 de 2. Vuelve a intentar los que faltan.')
      ).toBeVisible()
      expect(screen.getByText('Recibido')).toBeVisible()
      expect(screen.getByText('No se pudo subir')).toBeVisible()
      expect(screen.getByText('fallido.pdf')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Subir documentos' })).toBeEnabled()
    })
  })
})
