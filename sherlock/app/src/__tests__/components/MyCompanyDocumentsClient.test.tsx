import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addDemoDocument, getDemoDocuments } from '@/lib/dev-auth/demo-browser-store'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())
const mockUseAction = vi.hoisted(() => vi.fn())
const mockUseLocale = vi.hoisted(() => vi.fn(() => 'es'))
const mockPeekHandoff = vi.hoisted(() => vi.fn())
const mockAckHandoffFiles = vi.hoisted(() => vi.fn())
const mockAckHandoffCompanyName = vi.hoisted(() => vi.fn())
const mockDiscardHandoff = vi.hoisted(() => vi.fn())
const mockTrackSellSideEventOnce = vi.hoisted(() => vi.fn())
const mockNavigation = vi.hoisted(() => ({
  pathname: '/my-company/documents',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next-intl', async () => {
  const es = (await import('@/messages/es.json')).default as Record<string, unknown>

  function lookup(path: string): string | undefined {
    const value = path
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es)
    return typeof value === 'string' ? value : undefined
  }

  function formatMessage(message: string, values?: Record<string, unknown>): string {
    return message.replaceAll(/\{\s*(\w+)\s*\}/g, (whole, name: string) =>
      values && name in values ? String(values[name]) : whole
    )
  }

  return {
    useLocale: () => mockUseLocale(),
    useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
      if (key === 'close') return 'Close'
      const path = namespace ? `${namespace}.${key}` : key
      if (!path.startsWith('vdr.')) return key
      const message = lookup(path)
      return message === undefined ? key : formatMessage(message, values)
    },
  }
})

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  useAction: mockUseAction,
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockNavigation.search),
}))

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mockNavigation.pathname,
  useRouter: () => ({
    push: mockNavigation.push,
    replace: mockNavigation.replace,
    refresh: mockNavigation.refresh,
  }),
}))

vi.mock('@/lib/mycroft/upload-handoff', () => ({
  peekHandoff: (...args: unknown[]) => mockPeekHandoff(...args),
  ackHandoffFiles: (...args: unknown[]) => mockAckHandoffFiles(...args),
  ackHandoffCompanyName: (...args: unknown[]) => mockAckHandoffCompanyName(...args),
  discardHandoff: (...args: unknown[]) => mockDiscardHandoff(...args),
}))

vi.mock('@/lib/analytics/sell-side', () => ({
  trackSellSideEventOnce: (...args: unknown[]) => mockTrackSellSideEventOnce(...args),
}))
vi.mock('@/lib/analytics/room-journey', () => ({
  trackRoomJourney: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'dev_company_001', role: 'COMPANY' },
    isSignedIn: true,
  }),
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ profile: { _id: 'demo_company_profile_001' } }),
}))

// El visor real despacha por MIME (pdfjs, Mog, docx-preview); aqui solo importa
// que el shell le entregue la URL del grant y nunca la de storage. Sin viewUrl
// el visor real cae a "sin vista previa", y el stub imita ese contrato.
vi.mock('@/components/documents/viewers/DocumentViewer', () => ({
  DocumentViewer: (props: { fileName: string; viewUrl: string; downloadUrl: string | null }) =>
    props.viewUrl ? (
      <div data-testid="document-viewer-stub" data-view-url={props.viewUrl} />
    ) : (
      <div data-testid="document-viewer-nopreview" />
    ),
  isPreviewableDocument: (mimeType: string, fileName?: string) =>
    /pdf|spreadsheetml|wordprocessingml|presentationml|^image\//.test(mimeType) ||
    /\.(pdf|xlsx|docx|pptx|png|jpe?g)$/i.test(fileName ?? ''),
}))

vi.mock('@/components/company/SupportThread', () => ({
  SupportThread: () => <section data-testid="support-thread">Support</section>,
}))
vi.mock('@/components/company/RoomProgressPanel', () => ({
  RoomProgressPanel: () => <section data-testid="room-progress-panel">Room progress</section>,
}))
vi.mock('@/components/vdr-guest/CompanyGuestPanel', () => ({ CompanyGuestPanel: () => null }))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      updateCompany: 'companies.updateCompany',
    },
    deliverables: {
      listForCompany: 'deliverables.listForCompany',
    },
    financialSnapshots: {
      getForCompany: 'financialSnapshots.getForCompany',
    },
    documents: {
      getByCompany: 'documents.getByCompany',
      update: 'documents.update',
      getDownloadUrl: 'documents.getDownloadUrl',
      getDocumentAccessGrant: 'documents.getDocumentAccessGrant',
      issueDirectUploadIntent: 'documents.issueDirectUploadIntent',
      abandonDirectUploadIntent: 'documents.abandonDirectUploadIntent',
      registerDirectUpload: 'documents.registerDirectUpload',
      inspectAndRegisterDirectUpload: 'documents.inspectAndRegisterDirectUpload',
    },
  },
}))

const DIRECT_UPLOAD_URL = 'https://happy-animal-123.convex.cloud/api/storage/upload?token=abc'

// El sobre se parquea en la landing con una llave aleatoria que viaja en el
// returnTo del alta: la sala que llega con esa llave en su URL es la visita que
// lo parqueó. La hora del parqueo solo decide si el nombre bautiza un alta
// nueva o se descarta porque la sala ya existía.
const HANDOFF_NONCE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const STASHED_AT = 1_780_000_000_000
const SIGNED_UP_AT = STASHED_AT + 90_000
const EXISTING_ROOM_CREATED_AT = STASHED_AT - 30 * 24 * 60 * 60 * 1000

// El shell del data room separa selección de acción: un documento se elige en el
// árbol y sus acciones viven en la tarjeta del centro.
async function selectRoomFile(documentName: RegExp) {
  await userEvent.click(screen.getByRole('treeitem', { name: documentName }))
}

async function roomAction(action: RegExp, documentName: RegExp) {
  await selectRoomFile(documentName)
  return screen.getByRole('button', { name: action })
}

function useAccessGrantMutation(grant: ReturnType<typeof vi.fn>) {
  mockUseMutation.mockImplementation((reference: string) =>
    reference === 'documents.getDocumentAccessGrant' ? grant : vi.fn()
  )
}

function useCompanyDocumentsQuery(documents: unknown[]) {
  mockUseQuery.mockImplementation((reference: string) =>
    reference === 'documents.getByCompany' ? documents : []
  )
}

function useUpdateCompanyMutation(updateCompany: ReturnType<typeof vi.fn>) {
  mockUseMutation.mockImplementation((reference: string) =>
    reference === 'companies.updateCompany' ? updateCompany : vi.fn()
  )
}

describe('MyCompanyDocumentsClient', () => {
  // Precalienta la importación del grafo del componente (instrumentado por
  // cobertura en CI) para que su costo único no consuma el presupuesto de
  // 5s del primer test del archivo en un runner cargado.
  beforeAll(async () => {
    await import('@/components/company/MyCompanyDocumentsClient')
  }, 30_000)

  beforeEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
    mockUseLocale.mockReturnValue('es')
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    mockUseQuery.mockReset()
    mockUseQuery.mockReturnValue([])
    mockUseMutation.mockReset()
    mockUseMutation.mockReturnValue(vi.fn())
    mockUseAction.mockReset()
    mockUseAction.mockReturnValue(vi.fn())
    mockNavigation.search = ''
    mockNavigation.push.mockReset()
    mockNavigation.replace.mockReset()
    mockNavigation.refresh.mockReset()
    mockTrackSellSideEventOnce.mockReset()
    mockPeekHandoff.mockReset()
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    window.history.replaceState(null, '', '/my-company/documents')
    mockAckHandoffFiles.mockReset()
    mockAckHandoffFiles.mockResolvedValue(true)
    mockAckHandoffCompanyName.mockReset()
    mockAckHandoffCompanyName.mockResolvedValue(true)
    mockDiscardHandoff.mockReset()
    mockDiscardHandoff.mockResolvedValue(true)
    document.cookie = 'sherlock_intake_claim_retry=; Max-Age=0; Path=/; SameSite=Lax'
    document.cookie = 'sherlock_intake_claimed=; Max-Age=0; Path=/; SameSite=Lax'
  })

  it.each(['callback-marker', 'owned-handoff'])(
    'claims temporary custody once via %s and refreshes after success',
    async (source) => {
      if (source === 'callback-marker') {
        document.cookie = 'sherlock_intake_claim_retry=1; Max-Age=300; Path=/; SameSite=Lax'
      } else {
        mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
        mockPeekHandoff.mockResolvedValue({
          status: 'EMPTY',
          files: [],
          companyName: 'New issuer',
          stashedAt: STASHED_AT,
          nonce: HANDOFF_NONCE,
        })
      }
      const fetchMock = vi.fn()
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ authorized: true, csrfToken: 'csrf_retry', documents: [] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'SUCCEEDED', claimedDocumentCount: 2 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      vi.stubGlobal('fetch', fetchMock)

      const { MyCompanyDocumentsClient } =
        await import('@/components/company/MyCompanyDocumentsClient')
      render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        '/api/intake/session',
        expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/intake/claim',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          headers: expect.objectContaining({ 'x-intake-csrf': 'csrf_retry' }),
        })
      )
      expect(mockNavigation.refresh).toHaveBeenCalled()
      await waitFor(() => {
        expect(document.cookie).not.toContain('sherlock_intake_claim_retry=1')
        expect(document.cookie).not.toContain('sherlock_intake_claimed=')
        expect(mockTrackSellSideEventOnce).not.toHaveBeenCalledWith(
          'workspace_claimed',
          expect.anything(),
          'claim-success'
        )
        expect(mockTrackSellSideEventOnce).not.toHaveBeenCalledWith(
          'first_durable_upload',
          expect.anything(),
          'claim-success'
        )
      })
    }
  )

  it('recovers temporary custody after the first session lookup failed and the room remounted', async () => {
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: 'New issuer',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')
    const view = render(
      <MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(document.cookie).toContain('sherlock_intake_claim_retry=1')
    view.unmount()
    mockNavigation.search = ''
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: true, csrfToken: 'csrf_retry' }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'SUCCEEDED', claimedDocumentCount: 4 }))
      )
    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)
    await waitFor(() => expect(mockNavigation.refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(document.cookie).not.toContain('sherlock_intake_claim_retry=1')
  })

  it('does not post or navigate when the retained intake session is unavailable', async () => {
    document.cookie = 'sherlock_intake_claim_retry=1; Max-Age=300; Path=/; SameSite=Lax'
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ authorized: false, retainedOnly: true, csrfToken: 'csrf_retry' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')
    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(mockNavigation.refresh).not.toHaveBeenCalled()
    expect(document.cookie).toContain('sherlock_intake_claim_retry=1')
  })

  it('does not repeat the retry loop after a transient claim failure', async () => {
    document.cookie = 'sherlock_intake_claim_retry=1; Max-Age=300; Path=/; SameSite=Lax'
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: true, csrfToken: 'csrf_retry', documents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Acceso temporalmente no disponible' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')
    const view = render(
      <MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    view.rerender(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(mockNavigation.refresh).not.toHaveBeenCalled()
    expect(document.cookie).toContain('sherlock_intake_claim_retry=1')
  })

  it('keeps a company member in a strict read-only VDR without owner queries or controls', async () => {
    mockUseQuery.mockImplementation((query) => {
      if (query === 'documents.getByCompany') {
        return [
          {
            _id: 'document_member_1',
            name: 'Modelo financiero.pdf',
            folder: 'financials',
            accessLevel: 'NDA_REQUIRED',
            lifecycleStatus: 'ACTIVE',
          },
          {
            _id: 'document_member_2',
            name: 'Teaser.pdf',
            folder: '  ',
            accessLevel: 'NDA_REQUIRED',
            lifecycleStatus: 'ACTIVE',
          },
          {
            _id: 'document_member_3',
            name: 'Nota.pdf',
            folder: '',
            accessLevel: 'NDA_REQUIRED',
            lifecycleStatus: 'ACTIVE',
          },
        ]
      }
      return []
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_member_1"
        companyName="Issuer One"
        accessMode="READ_ONLY"
      />
    )

    expect(screen.getByText('Acceso de solo lectura')).toBeVisible()
    expect(screen.getByText('Modelo financiero.pdf')).toBeVisible()
    expect(screen.getByText('3. Financieros')).toBeVisible()
    expect(screen.getAllByText('Sin carpeta')).toHaveLength(2)
    expect(screen.queryByText('2. Corporativos')).not.toBeInTheDocument()
    expect(screen.queryByText('General')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subir/i })).not.toBeInTheDocument()
    expect(mockPeekHandoff).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /actividad/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /acceso/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /diligencia/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /panel/i })).not.toBeInTheDocument()

    expect(
      mockUseQuery.mock.calls.some(([query]) => String(query).startsWith('dueDiligence.'))
    ).toBe(false)
    expect(screen.queryByText(/solicitud de seguimiento/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/diligencia lista/i)).not.toBeInTheDocument()
  })

  it('keeps the admin company scope in workspace and document activity links', async () => {
    mockUseQuery.mockImplementation((query) => {
      if (query === 'documents.getByCompany') {
        return [
          {
            _id: 'document_admin_1',
            name: 'Credit agreement.pdf',
            folder: 'legal',
            accessLevel: 'NDA_REQUIRED',
            lifecycleStatus: 'ACTIVE',
          },
        ]
      }
      return []
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_admin_target"
        companyName="Issuer One"
        activityHref="/my-company/documents/activity?company=company_admin_target"
      />
    )

    expect(screen.getByRole('link', { name: 'Ver actividad' })).toHaveAttribute(
      'href',
      '/my-company/documents/activity?company=company_admin_target'
    )

    await selectRoomFile(/credit agreement\.pdf/i)
    expect(
      screen.getByRole('link', { name: 'Ver actividad: Credit agreement.pdf' })
    ).toHaveAttribute(
      'href',
      '/my-company/documents/activity?company=company_admin_target&document=document_admin_1'
    )
  })

  // La sala no tiene asistente conectado: el toolbar del cliente no lo ofrece.
  it('does not offer a room assistant in the owner toolbar', async () => {
    useCompanyDocumentsQuery([
      {
        _id: 'document_owner_1',
        name: 'Credit agreement.pdf',
        folder: 'legal',
        accessLevel: 'NDA_REQUIRED',
        lifecycleStatus: 'ACTIVE',
      },
    ])

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    // Sin `activityHref`, igual que my-company/documents/page.tsx: la bitácora
    // no es superficie de cliente.
    render(<MyCompanyDocumentsClient companyId="company_owner_1" companyName="Issuer One" />)

    expect(screen.getByTestId('room-cover-toolbar')).toBeVisible()
    // Este mock de next-intl devuelve la clave fuera de `vdr.*`: el botón se
    // llamaría `assistant.open` aquí y «Abrir asistente» en la sala real.
    expect(screen.queryByRole('button', { name: /assistant|asistente/i })).not.toBeInTheDocument()
    // Ningún disparador del panel lateral, se llame como se llame.
    expect(document.querySelector('[aria-controls="room-right-panel"]')).toBeNull()
  })

  it('keeps a production new-version upload open when direct-upload registration fails', async () => {
    const issueDirectUploadIntent = vi.fn().mockResolvedValue({
      intentId: 'intent_prod_1',
      uploadUrl: DIRECT_UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    })
    // Authz/rate limit/integridad lanzan en Convex; la UI normaliza a copy estable
    // y no cierra el diálogo cuando el registro falla.
    const registerDirectUpload = vi.fn().mockRejectedValue(new Error('Server Error'))
    mockUseAction.mockImplementation((reference: string) => {
      if (reference === 'documents.inspectAndRegisterDirectUpload') return registerDirectUpload
      return vi.fn()
    })
    mockUseMutation.mockImplementation((reference: string) => {
      if (reference === 'documents.issueDirectUploadIntent') return issueDirectUploadIntent
      return vi.fn()
    })
    mockUseQuery.mockImplementation((query) => {
      if (query === 'documents.getByCompany') {
        return [
          {
            _id: 'document_prod_1',
            name: 'Borrowing base model',
            fileType: 'application/pdf',
            folder: 'financial_model',
            accessLevel: 'NDA_REQUIRED',
            classification: 'CONFIDENTIAL',
            lifecycleStatus: 'ACTIVE',
          },
        ]
      }

      return []
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ storageId: 'storage_prod_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    expect(
      mockUseQuery.mock.calls.some(([query]) => String(query).startsWith('dueDiligence.'))
    ).toBe(false)
    await userEvent.click(
      await roomAction(/subir nueva versión: borrowing base model/i, /borrowing base model/i)
    )
    const dialog = screen.getByRole('dialog', { name: /subir nueva versión/i })
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(
      fileInput,
      new File(['prod'], 'Updated borrowing base model.pdf', {
        type: 'application/pdf',
      })
    )
    await userEvent.click(within(dialog).getByRole('button', { name: /^subir$/i }))

    await waitFor(() => {
      expect(
        screen.getByText(
          'No pudimos confirmar el resultado. No reintentes este archivo; Sherlock debe reconciliarlo.'
        )
      ).toBeVisible()
    })
    expect(toast.error).not.toHaveBeenCalledWith(
      'No pudimos confirmar el resultado. No reintentes este archivo; Sherlock debe reconciliarlo.'
    )
    const visibleErrors = JSON.stringify(vi.mocked(toast.error).mock.calls)
    expect(visibleErrors).not.toContain('storage_prod_1')
    expect(visibleErrors).not.toMatch(/[a-f0-9]{64}/i)
    expect(screen.getByRole('dialog', { name: /subir nueva versión/i })).toBeInTheDocument()
  })

  it('stops a new-version upload safely before file bytes reach storage', async () => {
    type UploadIntent = { intentId: string; uploadUrl: string; expiresAt: number }
    let resolveUploadIntent: ((intent: UploadIntent) => void) | undefined
    const issueDirectUploadIntent = vi.fn(
      async () =>
        await new Promise<UploadIntent>((resolve) => {
          resolveUploadIntent = resolve
        })
    )
    const registerDirectUpload = vi.fn()
    const abandonDirectUploadIntent = vi.fn().mockResolvedValue({ aborted: true })
    const fetchUpload = vi.fn()
    mockUseMutation.mockImplementation((reference: string) => {
      if (reference === 'documents.issueDirectUploadIntent') return issueDirectUploadIntent
      if (reference === 'documents.abandonDirectUploadIntent') return abandonDirectUploadIntent
      return vi.fn()
    })
    mockUseAction.mockImplementation((reference: string) =>
      reference === 'documents.inspectAndRegisterDirectUpload' ? registerDirectUpload : vi.fn()
    )
    mockUseQuery.mockImplementation((query) => {
      if (query === 'documents.getByCompany') {
        return [
          {
            _id: 'document_stop_1',
            name: 'Borrowing base model',
            fileType: 'application/pdf',
            folder: 'financial_model',
            accessLevel: 'NDA_REQUIRED',
            classification: 'CONFIDENTIAL',
            lifecycleStatus: 'ACTIVE',
          },
        ]
      }
      return []
    })
    vi.stubGlobal('fetch', fetchUpload)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    await userEvent.click(
      await roomAction(/subir nueva versión: borrowing base model/i, /borrowing base model/i)
    )
    const dialog = screen.getByRole('dialog', { name: /subir nueva versión/i })
    const uploadDialog = within(dialog)
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    const requestFile = new File(['%PDF-version'], 'Borrowing base v2.pdf', {
      type: 'application/pdf',
    })
    await userEvent.upload(fileInput, requestFile)
    await userEvent.click(uploadDialog.getByRole('button', { name: /^subir$/i }))
    await waitFor(() => expect(issueDirectUploadIntent).toHaveBeenCalledTimes(1))

    await userEvent.click(uploadDialog.getByRole('button', { name: /detener cargas/i }))
    resolveUploadIntent?.({
      intentId: 'intent_stopped_version_1',
      uploadUrl: DIRECT_UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    })

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        'Carga detenida. El archivo sigue listo para reintentar.'
      )
      expect(uploadDialog.getByRole('button', { name: /^subir$/i })).toBeEnabled()
    })
    expect(fetchUpload).not.toHaveBeenCalled()
    expect(abandonDirectUploadIntent).toHaveBeenCalledWith({
      intentId: 'intent_stopped_version_1',
    })
    expect(registerDirectUpload).not.toHaveBeenCalled()
    await userEvent.click(uploadDialog.getByRole('button', { name: /cancel/i }))
    await userEvent.click(
      await roomAction(/subir nueva versión: borrowing base model/i, /borrowing base model/i)
    )
    const reopenedDialog = screen.getByRole('dialog', { name: /subir nueva versión/i })
    const reopenedUpload = within(reopenedDialog)
    const reopenedFileInput = reopenedDialog.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(
      reopenedFileInput,
      new File(['%PDF-version'], 'Same safe bytes.pdf', { type: 'application/pdf' })
    )
    await waitFor(() => {
      expect(
        reopenedUpload.queryByRole('textbox', { name: /nombre del documento/i })
      ).not.toBeInTheDocument()
      expect(reopenedUpload.getByRole('button', { name: /^subir$/i })).toBeEnabled()
    })
  })

  it('stops a new-version upload and preserves an uncertain outcome once POST starts', async () => {
    const issueDirectUploadIntent = vi.fn().mockResolvedValue({
      intentId: 'intent_version_stop_1',
      uploadUrl: DIRECT_UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    })
    const registerDirectUpload = vi.fn()
    const fetchUpload = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error('missing upload AbortSignal')
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('stopped during POST', 'AbortError')),
          { once: true }
        )
      })
    })
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.issueDirectUploadIntent' ? issueDirectUploadIntent : vi.fn()
    )
    mockUseAction.mockImplementation((reference: string) =>
      reference === 'documents.inspectAndRegisterDirectUpload' ? registerDirectUpload : vi.fn()
    )
    mockUseQuery.mockImplementation((query) => {
      if (query === 'documents.getByCompany') {
        return [
          {
            _id: 'document_version_1',
            name: 'Management Presentation',
            fileType: 'application/pdf',
            folder: 'other',
            accessLevel: 'NDA_REQUIRED',
            classification: 'CONFIDENTIAL',
            lifecycleStatus: 'ACTIVE',
            currentVersionNumber: 1,
          },
        ]
      }
      return []
    })
    vi.stubGlobal('fetch', fetchUpload)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    await userEvent.click(
      await roomAction(/subir nueva versión: management presentation/i, /management presentation/i)
    )
    const dialog = screen.getByRole('dialog', { name: /subir nueva versión/i })
    const uploadDialog = within(dialog)
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    const uncertainFile = new File(['%PDF-version-2'], 'Management Presentation v2.pdf', {
      type: 'application/pdf',
    })
    await userEvent.upload(fileInput, uncertainFile)
    await userEvent.click(uploadDialog.getByRole('button', { name: /^subir$/i }))
    await waitFor(() => expect(fetchUpload).toHaveBeenCalledTimes(1))

    await userEvent.click(uploadDialog.getByRole('button', { name: /detener cargas/i }))

    await waitFor(() => {
      expect(
        uploadDialog.getByText(
          'No pudimos confirmar el resultado. No reintentes este archivo; Sherlock debe reconciliarlo.'
        )
      ).toBeVisible()
      expect(toast.error).not.toHaveBeenCalledWith(
        'No pudimos confirmar el resultado. No reintentes este archivo; Sherlock debe reconciliarlo.'
      )
      expect(uploadDialog.getByRole('button', { name: /^subir$/i })).toBeDisabled()
    })
    expect(
      uploadDialog.queryByRole('textbox', { name: /nombre del documento/i })
    ).not.toBeInTheDocument()

    await userEvent.upload(fileInput, uncertainFile)
    await waitFor(() => {
      expect(uploadDialog.getByRole('button', { name: /^subir$/i })).toBeDisabled()
    })

    await userEvent.upload(
      fileInput,
      new File(['%PDF-version-2'], 'Same bytes renamed.pdf', {
        type: 'application/pdf',
      })
    )
    await waitFor(() => {
      expect(uploadDialog.getByRole('button', { name: /^subir$/i })).toBeDisabled()
    })

    await userEvent.click(uploadDialog.getByRole('button', { name: /cancel/i }))
    await userEvent.click(
      await roomAction(/subir nueva versión: management presentation/i, /management presentation/i)
    )
    const reopenedDialog = screen.getByRole('dialog', { name: /subir nueva versión/i })
    const reopenedUpload = within(reopenedDialog)
    const reopenedFileInput = reopenedDialog.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(
      reopenedFileInput,
      new File(['%PDF-version-2'], 'Same bytes after reopen.pdf', {
        type: 'application/pdf',
      })
    )
    await waitFor(() => {
      expect(reopenedUpload.getByRole('button', { name: /^subir$/i })).toBeDisabled()
    })

    await userEvent.upload(
      reopenedFileInput,
      new File(['%PDF-version-3'], 'Different bytes.pdf', { type: 'application/pdf' })
    )
    await waitFor(() => {
      expect(reopenedUpload.getByRole('button', { name: /^subir$/i })).toBeEnabled()
    })
    expect(issueDirectUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ replaceDocumentId: 'document_version_1' })
    )
    expect(registerDirectUpload).not.toHaveBeenCalled()
  })

  it('shows terminal scanner rejections as unsafe files instead of uncertain outcomes', async () => {
    const issueDirectUploadIntent = vi.fn().mockResolvedValue({
      intentId: 'intent_malware_1',
      uploadUrl: DIRECT_UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    })
    const registerDirectUpload = vi.fn().mockResolvedValue({
      registered: false,
      code: 'MALWARE_DETECTED',
    })
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.issueDirectUploadIntent' ? issueDirectUploadIntent : vi.fn()
    )
    mockUseAction.mockImplementation((reference: string) =>
      reference === 'documents.inspectAndRegisterDirectUpload' ? registerDirectUpload : vi.fn()
    )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ storageId: 'storage_malware_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    await userEvent.click(screen.getAllByRole('button', { name: /subir documento/i })[0])
    const dialog = screen.getByRole('dialog', { name: /subir documento/i })
    const uploadDialog = within(dialog)
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(
      fileInput,
      new File(['%PDF-malware'], 'Malware.pdf', { type: 'application/pdf' })
    )
    await userEvent.click(uploadDialog.getByRole('button', { name: /^subir$/i }))

    await waitFor(() => {
      expect(
        uploadDialog.getByText(
          'No pudimos verificar este archivo de forma segura. Usa un PDF u Office válido y sin cifrado.'
        )
      ).toBeVisible()
    })
    expect(
      uploadDialog.queryByText(
        'No pudimos confirmar el resultado. No reintentes este archivo; Sherlock debe reconciliarlo.'
      )
    ).not.toBeInTheDocument()
  })

  it('uploads a bounded multi-file batch without bypassing the controlled VDR flow', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /subir documento/i }))
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(fileInput, [
      new File(['one'], 'Financial Model.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      new File(['two'], 'Management Presentation.pdf', { type: 'application/pdf' }),
    ])

    expect(screen.getByText('2 archivos seleccionados')).toBeVisible()
    expect(screen.getByText('Financial Model.xlsx')).toBeVisible()
    expect(screen.getByText('Management Presentation.pdf')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: /^subir$/i }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 documentos subidos.'))
    expect(
      getDemoDocuments({ companyId: 'demo_company_001' }).map((document) => document.name)
    ).toEqual(expect.arrayContaining(['Financial Model', 'Management Presentation']))
  })

  it('stops the active batch without starting files that are still pending', async () => {
    const issueDirectUploadIntent = vi.fn().mockImplementation(async () => ({
      intentId: `intent_${issueDirectUploadIntent.mock.calls.length}`,
      uploadUrl: DIRECT_UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    }))
    const registerDirectUpload = vi.fn()
    const fetchUpload = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('stopped', 'AbortError')),
            { once: true }
          )
        })
    )
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.issueDirectUploadIntent' ? issueDirectUploadIntent : vi.fn()
    )
    mockUseAction.mockImplementation((reference: string) =>
      reference === 'documents.inspectAndRegisterDirectUpload' ? registerDirectUpload : vi.fn()
    )
    vi.stubGlobal('fetch', fetchUpload)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    await userEvent.click(screen.getAllByRole('button', { name: /subir documento/i })[0])
    const dialog = screen.getByRole('dialog', { name: /subir documento/i })
    const uploadDialog = within(dialog)
    const fileInput = dialog.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(
      fileInput,
      Array.from(
        { length: 4 },
        (_, index) =>
          new File([`%PDF-${index}`], `Document ${index + 1}.pdf`, {
            type: 'application/pdf',
          })
      )
    )
    await userEvent.click(uploadDialog.getByRole('button', { name: /^subir$/i }))

    await waitFor(() => {
      expect(issueDirectUploadIntent).toHaveBeenCalledTimes(2)
      expect(fetchUpload).toHaveBeenCalledTimes(2)
    })
    expect(fileInput).toBeDisabled()
    for (const metadataControl of uploadDialog.getAllByRole('combobox')) {
      expect(metadataControl).toBeDisabled()
    }
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['%PDF-extra'], 'Late document.pdf', { type: 'application/pdf' })],
      },
    })
    expect(uploadDialog.getByText('4 archivos seleccionados')).toBeVisible()
    expect(uploadDialog.queryByText('Late document.pdf')).not.toBeInTheDocument()
    await userEvent.click(uploadDialog.getByRole('button', { name: /detener cargas/i }))

    await waitFor(() => {
      expect(uploadDialog.getAllByText('Requiere atención')).toHaveLength(2)
      expect(uploadDialog.getAllByText('Pendiente')).toHaveLength(2)
      expect(uploadDialog.getByRole('button', { name: /^subir$/i })).toBeEnabled()
    })
    expect(issueDirectUploadIntent).toHaveBeenCalledTimes(2)
    expect(registerDirectUpload).not.toHaveBeenCalled()
  })

  it('keeps unsupported batch files visible and does not offer an unsafe retry', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /subir documento/i }))
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['unsafe'], 'sales.zip', { type: 'application/zip' })] },
    })

    expect(screen.getByText('Requiere atención')).toBeVisible()
    expect(screen.getByText(/tipo de archivo no permitido/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /^subir$/i })).toBeDisabled()
  })

  it('does not hide an invalid row after the valid files in the same batch finish', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /subir documento/i }))
    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['safe'], 'safe.pdf', { type: 'application/pdf' }),
          new File(['unsafe'], 'unsafe.zip', { type: 'application/zip' }),
        ],
      },
    })

    await userEvent.click(screen.getByRole('button', { name: /^subir$/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 subido; 1 requiere atención.'))
    expect(screen.getByRole('dialog', { name: /subir documento/i })).toBeVisible()
    expect(screen.getByText('unsafe.zip')).toBeVisible()
    expect(screen.getByText('Requiere atención')).toBeVisible()
  })

  // Un data room que no se puede reorganizar después de la primera carga es peor
  // que una carpeta de Drive: antes de esto la única forma de corregir un archivo
  // mal clasificado era borrarlo, y eso destruye su historial de acceso.
  it('renames a document, moves it to another folder and persists the change', async () => {
    addDemoDocument({
      companyId: 'demo_company_001',
      name: 'estados 2024.pdf',
      accessLevel: 'NDA_REQUIRED',
      fileType: 'application/pdf',
      folder: 'other',
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await userEvent.click(await roomAction(/renombrar: estados 2024\.pdf/i, /estados 2024\.pdf/i))

    const nameField = screen.getByLabelText('Nombre del documento')
    await userEvent.clear(nameField)
    await userEvent.type(nameField, '2024 Financial Statements')

    await userEvent.click(screen.getByRole('button', { name: /guardar cambios/i }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Documento actualizado')
    })

    const stored = getDemoDocuments({ companyId: 'demo_company_001' })
    const updated = stored.find((doc) => doc.name === '2024 Financial Statements')
    expect(updated).toBeDefined()
    expect(stored.some((doc) => doc.name === 'estados 2024.pdf')).toBe(false)
  })

  // El emisor tiene que poder revisar su propio archivo desde la sala: el botón
  // Abrir pide un grant VIEW por getDownloadUrl (mismo flujo auditado que un
  // inversionista) y abre la URL del proxy, nunca la de storage.
  it('opens the issuer own document through a VIEW grant', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_1?token=tok',
      action: 'VIEW',
      versionId: 'version_teaser',
      displayName: 'teaser.pdf',
      detectedMimeType: 'application/pdf',
    })
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.getDocumentAccessGrant' ? getDocumentAccessGrant : vi.fn()
    )
    mockUseQuery.mockImplementation((reference: string) =>
      reference === 'documents.getByCompany'
        ? [
            {
              _id: 'doc_1',
              name: 'teaser.pdf',
              fileType: 'application/pdf',
              folder: 'teaser',
              accessLevel: 'PUBLIC',
              classification: 'PUBLIC_TEASER',
            },
          ]
        : []
    )
    const openSpy = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', openSpy)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await userEvent.click(await roomAction(/abrir: teaser\.pdf/i, /teaser\.pdf/i))

    await waitFor(() => {
      expect(getDocumentAccessGrant).toHaveBeenCalledWith({
        documentId: 'doc_1',
        action: 'VIEW',
      })
    })
    // El visor monta sobre la URL del proxy con el grant de un solo uso, jamás
    // sobre la URL permanente de storage, y no abre una pestaña nueva.
    await waitFor(() => {
      expect(screen.getByTestId('document-viewer-stub')).toHaveAttribute(
        'data-view-url',
        '/api/documents/access/grant_1?token=tok&disposition=inline'
      )
    })
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('opens ?source=<id> through a VIEW grant without pinning a version (au-02)', async () => {
    mockNavigation.search = 'source=doc_1'
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_source?token=tok',
      action: 'VIEW',
      versionId: 'version_teaser',
      displayName: 'teaser.pdf',
      detectedMimeType: 'application/pdf',
    })
    useAccessGrantMutation(getDocumentAccessGrant)
    useCompanyDocumentsQuery([
      {
        _id: 'doc_1',
        name: 'teaser.pdf',
        fileType: 'application/pdf',
        folder: 'teaser',
        accessLevel: 'PUBLIC',
        classification: 'PUBLIC_TEASER',
      },
    ])

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await waitFor(() => {
      expect(getDocumentAccessGrant).toHaveBeenCalledWith({
        documentId: 'doc_1',
        action: 'VIEW',
      })
    })
    expect(getDocumentAccessGrant.mock.calls[0]?.[0]).not.toHaveProperty('versionId')
    await waitFor(() => {
      expect(screen.getByTestId('document-viewer-stub')).toHaveAttribute(
        'data-view-url',
        '/api/documents/access/grant_source?token=tok&disposition=inline'
      )
    })
  })

  // El visor despacha cinco renderers, no solo PDF. Si el shell vuelve a decidir
  // la acción con un predicado de PDFs, la hoja de cálculo pide grant DOWNLOAD y
  // muere en el fallback de descarga en lugar de llegar al renderer de Mog, que
  // es justo lo que el cliente viene a ver de su modelo financiero.
  it('opens a spreadsheet through a VIEW grant instead of the download fallback', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_2?token=tok',
      action: 'VIEW',
      versionId: 'version_model',
      displayName: 'modelo financiero.xlsx',
      detectedMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.getDocumentAccessGrant' ? getDocumentAccessGrant : vi.fn()
    )
    mockUseQuery.mockImplementation((reference: string) =>
      reference === 'documents.getByCompany'
        ? [
            {
              _id: 'doc_2',
              name: 'modelo financiero.xlsx',
              fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              folder: 'room_financial',
              accessLevel: 'NDA_REQUIRED',
              classification: 'CONFIDENTIAL',
            },
          ]
        : []
    )
    const openSpy = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', openSpy)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await userEvent.click(
      await roomAction(/abrir: modelo financiero\.xlsx/i, /modelo financiero\.xlsx/i)
    )

    await waitFor(() => {
      expect(getDocumentAccessGrant).toHaveBeenCalledWith({
        documentId: 'doc_2',
        action: 'VIEW',
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('document-viewer-stub')).toHaveAttribute(
        'data-view-url',
        '/api/documents/access/grant_2?token=tok&disposition=inline'
      )
    })
    expect(screen.queryByTestId('document-viewer-nopreview')).toBeNull()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('surfaces an error toast when the document has no downloadable file', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue(null)
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.getDownloadUrl' ? getDownloadUrl : vi.fn()
    )
    mockUseQuery.mockImplementation((reference: string) =>
      reference === 'documents.getByCompany'
        ? [
            {
              _id: 'doc_1',
              name: 'teaser.pdf',
              fileType: 'application/pdf',
              folder: 'teaser',
              accessLevel: 'PUBLIC',
              classification: 'PUBLIC_TEASER',
            },
          ]
        : []
    )
    const openSpy = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', openSpy)

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await userEvent.click(await roomAction(/abrir: teaser\.pdf/i, /teaser\.pdf/i))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'No pudimos preparar el documento. Intenta de nuevo.'
      )
    })
    expect(screen.queryByTestId('document-viewer-stub')).toBeNull()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('never reaches storage when a demo document is opened', async () => {
    addDemoDocument({
      companyId: 'demo_company_001',
      name: 'estados 2024.pdf',
      accessLevel: 'NDA_REQUIRED',
      fileType: 'application/pdf',
      folder: 'other',
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    const getDownloadUrl = vi.fn()
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.getDownloadUrl' ? getDownloadUrl : vi.fn()
    )

    const openButton = await roomAction(/abrir: estados 2024\.pdf/i, /estados 2024\.pdf/i)
    expect(
      screen.getByRole('button', { name: /renombrar: estados 2024\.pdf/i })
    ).toBeInTheDocument()
    await userEvent.click(openButton)

    // La demo local no tiene bytes: el visor monta y lo declara, sin pedir grant.
    expect(await screen.findByTestId('document-viewer-nopreview')).toBeInTheDocument()
    expect(getDownloadUrl).not.toHaveBeenCalled()
  })

  it('warns before widening access, and sends the new level to Convex', async () => {
    const update = vi.fn().mockResolvedValue({})
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.update' ? update : vi.fn()
    )
    mockUseQuery.mockImplementation((reference: string) =>
      reference === 'documents.getByCompany'
        ? [
            {
              _id: 'doc_1',
              name: 'cap table.xlsx',
              fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              folder: 'cap_table',
              accessLevel: 'PRIVATE',
              classification: 'RESTRICTED',
            },
          ]
        : []
    )

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await userEvent.click(await roomAction(/renombrar: cap table\.xlsx/i, /cap table\.xlsx/i))

    // PRIVATE -> PUBLIC amplía el alcance: la empresa tiene que verlo antes de guardar.
    await userEvent.click(screen.getByLabelText('Nivel de acceso'))
    await userEvent.click(screen.getByRole('option', { name: /teaser/i }))

    expect(
      screen.getByText(
        'Estás ampliando el acceso. Al guardar, este archivo quedará al alcance de más personas.'
      )
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /guardar cambios/i }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc_1',
          name: 'cap table.xlsx',
          folder: 'cap_table',
          accessLevel: 'PUBLIC',
        })
      )
    })
  })

  it('sends an explicit null when the issuer removes an existing expiry', async () => {
    const update = vi.fn().mockResolvedValue({})
    mockUseMutation.mockImplementation((reference: string) =>
      reference === 'documents.update' ? update : vi.fn()
    )
    const expiry = new Date(2026, 7, 15, 23, 59, 59, 999).getTime()
    mockUseQuery.mockImplementation((reference: string) =>
      reference === 'documents.getByCompany'
        ? [
            {
              _id: 'doc_expiring',
              name: 'term sheet.pdf',
              fileType: 'application/pdf',
              folder: 'legal',
              accessLevel: 'PRIVATE',
              classification: 'LEGAL',
              expiresAt: expiry,
            },
          ]
        : []
    )

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Agroindustrias Espavé Capital Raise"
      />
    )

    await userEvent.click(await roomAction(/renombrar: term sheet\.pdf/i, /term sheet\.pdf/i))
    const expiryField = screen.getByLabelText('Fecha de vencimiento')
    expect(expiryField).toHaveValue('2026-08-15')
    await userEvent.clear(expiryField)
    await userEvent.click(screen.getByRole('button', { name: /guardar cambios/i }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc_expiring', expiresAt: null })
      )
    })
  })

  it('keeps the company room free of deal-era workflow tabs', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByText('Diligencia')).not.toBeInTheDocument()
    expect(screen.queryByText('Q&A')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /marketplace|inversionista/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /marketplace|inversionista/i })
    ).not.toBeInTheDocument()
  })

  // [F] 2026-09-03 23:30: el sitio ships solo en español, así que la evidencia
  // de sala de ejemplo se pinnea en un único idioma y no en un par es/en.
  it('marks the room as a sample in the active room header', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    expect(screen.getByTestId('local-demo-evidence')).toHaveTextContent(
      'Documentos de ejemplo. Sube los tuyos para empezar.'
    )
  })

  // [F] 2026-09-01 (DECISIONS): el cliente aterriza en su VDR con los documentos
  // ya subidos; el diálogo de subida deja de pedir el archivo por segunda vez.
  it('uploads the parked landing intake into the room without a second confirmation', async () => {
    const parked = new File(['teaser'], 'teaser.pdf', { type: 'application/pdf' })
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 7, file: parked }],
      companyName: null,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => expect(mockAckHandoffFiles).toHaveBeenCalledWith([7]))
    expect(toast.success).toHaveBeenCalledWith('1 documento subido.')
    expect(
      getDemoDocuments({ companyId: 'demo_company_001' }).map((document) => document.name)
    ).toContain('teaser.pdf')
    expect(mockPeekHandoff).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
  })

  // El sobre de IndexedDB es el camino de respaldo del mismo gesto, así que
  // tiene que dejar la sala igual que el claim del intake temporal: nombre
  // completo con extensión y carpeta ruteada por el nombre. Hasta el 2026-09-03
  // dejaba todo en "other" y sin extensión, y la casilla de Financieros del
  // checklist seguía pendiente con los estados financieros ya en la sala.
  it('routes the parked landing intake by file name and keeps the extension', async () => {
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [
        {
          id: 31,
          file: new File(['ina'], 'INA_GRMELO_2024_FY_v01.pdf', { type: 'application/pdf' }),
        },
        { id: 32, file: new File(['acta'], 'Pacto social.pdf', { type: 'application/pdf' }) },
      ],
      companyName: null,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 documentos subidos.'))
    const landed = getDemoDocuments({ companyId: 'demo_company_001' })
    expect(landed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'INA_GRMELO_2024_FY_v01.pdf',
          folder: 'room_financial',
        }),
        expect.objectContaining({ name: 'Pacto social.pdf', folder: 'room_corporate' }),
      ])
    )
  })

  // El fracaso sí necesita al cliente: la subida automática cuenta su resultado y
  // el diálogo vuelve solo para reintentar lo que quedó en rojo.
  it('opens the upload dialog only to retry the parked files that failed', async () => {
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [
        { id: 11, file: new File(['safe'], 'safe.pdf', { type: 'application/pdf' }) },
        { id: 12, file: new File(['unsafe'], 'unsafe.zip', { type: 'application/zip' }) },
      ],
      companyName: null,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 subido; 1 requiere atención.'))
    expect(await screen.findByRole('dialog', { name: /subir documento/i })).toBeVisible()
    expect(screen.getByText('unsafe.zip')).toBeVisible()
    expect(screen.getByText('Requiere atención')).toBeVisible()
    expect(mockAckHandoffFiles).toHaveBeenCalledWith([11])
    expect(mockAckHandoffFiles).not.toHaveBeenCalledWith([11, 12])
  })

  // El ack del handoff toca IndexedDB, así que la subida asienta un turno del
  // event loop después del último render que ella misma provocó. Sin un render
  // propio del asentado, lo fallido quedaba huérfano y el diálogo no volvía.
  it('reopens the dialog for failed files when the acknowledgement crosses an event-loop turn', async () => {
    mockAckHandoffFiles.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 0))
    )
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [
        { id: 21, file: new File(['safe'], 'safe.pdf', { type: 'application/pdf' }) },
        { id: 22, file: new File(['unsafe'], 'unsafe.zip', { type: 'application/zip' }) },
      ],
      companyName: null,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 subido; 1 requiere atención.'))
    expect(await screen.findByRole('dialog', { name: /subir documento/i })).toBeVisible()
    expect(screen.getByText('unsafe.zip')).toBeVisible()
    expect(mockAckHandoffFiles).toHaveBeenCalledWith([21])
  })

  // El nombre sobrevive a los bytes: la tanda temporal ya reconoció sus archivos
  // antes de que la sala abriera y el nombre todavía la tiene que nombrar.
  it('names the room once from the company the client typed on the landing', async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: 'Espavé Holdings',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    const view = render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )

    await waitFor(() =>
      expect(updateCompany).toHaveBeenCalledWith({
        companyId: 'company_prod_1',
        name: 'Espavé Holdings',
      })
    )
    await waitFor(() => expect(mockAckHandoffCompanyName).toHaveBeenCalledTimes(1))
    // La sala muestra el nombre en su encabezado; anunciarlo además en un toast
    // repetiría el mismo hecho y sería copy fuera de `src/messages/`.
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()

    view.rerender(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )
    expect(updateCompany).toHaveBeenCalledTimes(1)
    expect(mockPeekHandoff).toHaveBeenCalledTimes(1)
  })

  it('leaves the parked company name for a later visit when the rename fails', async () => {
    const updateCompany = vi.fn().mockRejectedValue(new Error('CONVEX_UNAVAILABLE'))
    useUpdateCompanyMutation(updateCompany)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: 'Espavé Holdings',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )

    await waitFor(() => expect(updateCompany).toHaveBeenCalledTimes(1))
    expect(mockAckHandoffCompanyName).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  // La sala de ejemplo no se renombra: su portada tampoco ofrece el botón.
  it('does not rename the sample room from a parked company name', async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 13, file: new File(['teaser'], 'teaser.pdf', { type: 'application/pdf' }) }],
      companyName: 'Espavé Holdings',
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => expect(mockAckHandoffFiles).toHaveBeenCalledWith([13]))
    expect(updateCompany).not.toHaveBeenCalled()
    expect(mockAckHandoffCompanyName).not.toHaveBeenCalled()
  })

  it('does not claim a parked landing intake in a read-only company room', async () => {
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [
        {
          id: 8,
          file: new File(['teaser'], 'teaser.pdf', { type: 'application/pdf' }),
        },
      ],
      companyName: 'Espavé Holdings',
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_member_1"
        companyName="Issuer One"
        accessMode="READ_ONLY"
      />
    )

    expect(screen.getByText('Acceso de solo lectura')).toBeVisible()
    expect(mockPeekHandoff).not.toHaveBeenCalled()
    expect(mockAckHandoffCompanyName).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not consume a parked landing intake when an admin operates a client room', async () => {
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [
        {
          id: 9,
          file: new File(['foreign'], 'otra-empresa.pdf', { type: 'application/pdf' }),
        },
      ],
      companyName: 'Otra Empresa',
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_client_1"
        companyName="Cliente Ajeno"
        isDemo
        adminOperator
      />
    )

    expect(await screen.findByRole('heading', { name: 'Data Room' })).toBeVisible()
    expect(mockPeekHandoff).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  // La llave del sobre viaja en la URL del alta, así que la visita que lo
  // parqueó lo recibe aunque el cliente ya tuviera sala: example1993 vuelve a la
  // landing con SAMPLE_ENERGY abierto, suelta tres PDF, escribe un nombre y aterriza en
  // su sala. Los archivos suben; el nombre no renombra una sala que ya existía.
  it("uploads the parked files into the owner's existing room without renaming it", async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 31, file: new File(['nuevo'], 'nuevo.pdf', { type: 'application/pdf' }) }],
      companyName: 'prueba',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Sample Hydro, S.A."
        companyCreatedAt={EXISTING_ROOM_CREATED_AT}
      />
    )

    // Sin backend de subida en el test, el intento termina en el diálogo de
    // reintento con el archivo: la prueba de que el sobre se reclamó.
    expect(await screen.findByRole('dialog', { name: /subir documento/i })).toBeVisible()
    expect(screen.getByText('nuevo.pdf')).toBeVisible()
    expect(updateCompany).not.toHaveBeenCalled()
    expect(mockDiscardHandoff).not.toHaveBeenCalled()
    // El nombre se consume para que una visita posterior no lo vuelva a intentar.
    await waitFor(() => expect(mockAckHandoffCompanyName).toHaveBeenCalledTimes(1))
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })

  // Sin llave en la URL no hay visita que reclame: el dueño entrando directo a
  // su sala, u otro usuario en el mismo navegador, no hereda el sobre. Tampoco
  // lo borra: no es suyo para tirarlo, y el flujo que sí lo parqueó puede seguir
  // vivo en otra pestaña.
  it('leaves the parked intake untouched when the visit carries no handoff nonce', async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 32, file: new File(['ajeno'], 'ajeno.pdf', { type: 'application/pdf' }) }],
      companyName: 'prueba',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )

    await waitFor(() => expect(consoleWarn).toHaveBeenCalled())
    expect(mockDiscardHandoff).not.toHaveBeenCalled()
    expect(updateCompany).not.toHaveBeenCalled()
    expect(mockAckHandoffFiles).not.toHaveBeenCalled()
    expect(mockAckHandoffCompanyName).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
    consoleWarn.mockRestore()
  })

  // Dos pestañas, dos flujos: A aterriza con su llave y el sobre vivo es el que
  // parqueó B. Borrarlo aquí le quitaría a B los archivos que todavía va a
  // reclamar en su propia sala. El sobre se cierra por su TTL o por el reclamo
  // que sí le toca; esta visita solo se limpia la llave de su URL.
  it("leaves the parked intake untouched when the URL nonce is not the envelope's", async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockNavigation.search = '?handoff=1b4e28ba-2fa1-4d3b-9c6e-0f8a7d6c5b4a'
    window.history.replaceState(
      null,
      '',
      '/my-company/documents?handoff=1b4e28ba-2fa1-4d3b-9c6e-0f8a7d6c5b4a'
    )
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 33, file: new File(['ajeno'], 'ajeno.pdf', { type: 'application/pdf' }) }],
      companyName: 'prueba',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )

    await waitFor(() => expect(consoleWarn).toHaveBeenCalled())
    expect(mockDiscardHandoff).not.toHaveBeenCalled()
    expect(updateCompany).not.toHaveBeenCalled()
    expect(mockAckHandoffFiles).not.toHaveBeenCalled()
    expect(mockAckHandoffCompanyName).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
    // La llave que no empareja sale de la URL de esta visita: no vuelve a
    // presentarse en un reload ni en un enlace copiado.
    await waitFor(() =>
      expect(
        mockNavigation.replace.mock.calls.some(([href]) => !String(href).includes('handoff='))
      ).toBe(true)
    )
    consoleWarn.mockRestore()
  })

  // La sala que sí nació de ese sobre lo aplica completo: nombre y bytes.
  it.each([false, true])(
    'claims the parked intake in the room its own sign-up created (StrictMode=%s)',
    async (reactStrictMode) => {
      const updateCompany = vi.fn().mockResolvedValue({})
      mockUseMutation.mockImplementation((reference: string) =>
        reference === 'companies.updateCompany' ? updateCompany : vi.fn()
      )
      mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
      window.history.replaceState(null, '', `/my-company/documents?handoff=${HANDOFF_NONCE}`)
      mockPeekHandoff.mockResolvedValue({
        status: 'READY',
        files: [{ id: 34, file: new File(['teaser'], 'teaser.pdf', { type: 'application/pdf' }) }],
        companyName: 'Espavé Holdings',
        stashedAt: STASHED_AT,
        nonce: HANDOFF_NONCE,
      })

      const { MyCompanyDocumentsClient } =
        await import('@/components/company/MyCompanyDocumentsClient')

      render(
        <MyCompanyDocumentsClient
          companyId="company_prod_1"
          companyName="Untitled company"
          companyCreatedAt={SIGNED_UP_AT}
        />,
        { reactStrictMode }
      )

      await waitFor(() =>
        expect(updateCompany).toHaveBeenCalledWith({
          companyId: 'company_prod_1',
          name: 'Espavé Holdings',
        })
      )
      expect(await screen.findByRole('dialog', { name: /subir documento/i })).toBeVisible()
      expect(screen.getByText('teaser.pdf')).toBeVisible()
      expect(mockDiscardHandoff).not.toHaveBeenCalled()
      // El reclamo asentó: archivos encolados y sobre consumido. Solo ahí sale la
      // llave de la URL.
      await waitFor(() =>
        expect(mockNavigation.replace).toHaveBeenCalledWith('/my-company/documents', {
          scroll: false,
        })
      )
    }
  )

  // `_creationTime` es reloj del servidor y `stashedAt` reloj del navegador: un
  // reloj tres minutos adelantado no convierte un alta nueva en sala previa.
  it('renames a company born from the handoff even when the browser clock ran ahead', async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'EMPTY',
      files: [],
      companyName: 'Espavé Holdings',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={STASHED_AT - 3 * 60_000}
      />
    )

    await waitFor(() =>
      expect(updateCompany).toHaveBeenCalledWith({
        companyId: 'company_prod_1',
        name: 'Espavé Holdings',
      })
    )
    await waitFor(() => expect(mockAckHandoffCompanyName).toHaveBeenCalledTimes(1))
    expect(mockDiscardHandoff).not.toHaveBeenCalled()
  })

  // Una sala que no sabe cuándo nació no puede probar que es un alta nueva: los
  // bytes entran por la llave, el nombre se descarta.
  it('uploads the parked files but keeps the name when the room cannot date its own creation', async () => {
    const updateCompany = vi.fn().mockResolvedValue({})
    useUpdateCompanyMutation(updateCompany)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockNavigation.search = `?handoff=${HANDOFF_NONCE}`
    mockPeekHandoff.mockResolvedValue({
      status: 'READY',
      files: [{ id: 35, file: new File(['teaser'], 'teaser.pdf', { type: 'application/pdf' }) }],
      companyName: 'Espavé Holdings',
      stashedAt: STASHED_AT,
      nonce: HANDOFF_NONCE,
    })

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_prod_1" companyName="Issuer One" />)

    expect(await screen.findByRole('dialog', { name: /subir documento/i })).toBeVisible()
    expect(screen.getByText('teaser.pdf')).toBeVisible()
    expect(updateCompany).not.toHaveBeenCalled()
    expect(mockDiscardHandoff).not.toHaveBeenCalled()
    consoleWarn.mockRestore()
  })

  // La llave sale de la URL cuando ya cumplió, no antes. La sala normaliza su
  // URL en el primer efecto, mucho antes de que el peek resuelva: si esa
  // normalización se llevara la llave, una sala lenta más un reload dejaría al
  // sobre sin nadie que lo pueda reclamar. Mientras el reclamo esté pendiente la
  // llave viaja en cada replace; al asentar se limpia y el resto del estado de
  // la sala sobrevive.
  it('keeps the handoff nonce in the URL while the claim is pending and drops it once settled', async () => {
    mockNavigation.search = `?room=company&handoff=${HANDOFF_NONCE}`
    window.history.replaceState(
      null,
      '',
      `/my-company/documents?room=company&handoff=${HANDOFF_NONCE}`
    )
    let resolvePeek: (value: unknown) => void = () => {}
    mockPeekHandoff.mockReturnValue(
      new Promise((resolve) => {
        resolvePeek = resolve
      })
    )

    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="company_prod_1"
        companyName="Untitled company"
        companyCreatedAt={SIGNED_UP_AT}
      />
    )

    await waitFor(() => expect(mockNavigation.replace).toHaveBeenCalled())
    expect(
      mockNavigation.replace.mock.calls.every(([href]) =>
        String(href).includes(`handoff=${HANDOFF_NONCE}`)
      )
    ).toBe(true)

    resolvePeek({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })

    await waitFor(() =>
      expect(mockNavigation.replace).toHaveBeenCalledWith('/my-company/documents?room=company', {
        scroll: false,
      })
    )
  })

  it('does not open the upload dialog when nothing was parked on the landing', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(
      <MyCompanyDocumentsClient
        companyId="demo_company_001"
        companyName="Agroindustrias Espavé Capital Raise"
        isDemo
      />
    )

    await waitFor(() => {
      expect(mockPeekHandoff).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('dialog', { name: /subir documento/i })).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
