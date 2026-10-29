import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockRequest = vi.fn()
const mockTransition = vi.fn()
const mockAttachRendition = vi.fn()
const mockRecordAssessment = vi.fn()
const mockLoadWorkspace = vi.fn()
const mockUseLocale = vi.fn(() => 'es')

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}))

vi.mock('convex/server', () => ({
  makeFunctionReference: (name: string) => name,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    deliverables: {
      listForCompany: 'deliverables:listForCompany',
      request: 'deliverables:request',
      transition: 'deliverables:transition',
      attachRendition: 'deliverables:attachRendition',
    },
    documents: {
      getByCompany: 'documents:getByCompany',
    },
    intake: {
      recordIntakeAssessment: 'intake:recordIntakeAssessment',
    },
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('next-intl', async () => {
  const es = (await import('@/messages/es.json')).default as Record<string, unknown>

  return {
    useLocale: () => mockUseLocale(),
    useTranslations: (namespace: string) => (key: string) => {
      const messages = es
      let value: unknown = messages
      for (const part of [...namespace.split('.'), ...key.split('.')]) {
        value = (value as Record<string, unknown> | undefined)?.[part]
      }
      return typeof value === 'string' ? value : `${namespace}.${key}`
    },
  }
})

import { AdminPreparationWorkspace } from '@/components/admin/AdminPreparationWorkspace'

const COMPANY_ID = 'company_1' as Id<'companies'>
const DELIVERABLE_ID = 'deliverable_model' as Id<'deliverables'>

describe('AdminPreparationWorkspace', () => {
  beforeEach(() => {
    mockUseLocale.mockReset().mockReturnValue('es')
    mockUseQuery.mockReset().mockImplementation((reference: unknown) => {
      if (reference === 'deliverables:listForCompany') {
        return [
          {
            deliverableId: DELIVERABLE_ID,
            kind: 'MODEL',
            status: 'DRAFT_READY',
            producedBy: 'TEAM',
            renditions: [],
            sources: [],
            updatedAt: 1_900_000_000_000,
          },
        ]
      }
      if (reference === 'documents:getByCompany') {
        return [
          {
            _id: 'document_1',
            name: 'Modelo base.xlsx',
            fileType: 'XLSX',
            currentVersionId: 'version_1',
            currentVersionNumber: 2,
          },
        ]
      }
      return undefined
    })
    mockUseMutation.mockReset().mockImplementation((reference: unknown) => {
      if (reference === 'deliverables:request') return mockRequest
      if (reference === 'deliverables:transition') return mockTransition
      if (reference === 'deliverables:attachRendition') return mockAttachRendition
      if (reference === 'intake:recordIntakeAssessment') return mockRecordAssessment
      if (reference === 'intake:getAdminIntakeWorkspace') return mockLoadWorkspace
      return vi.fn()
    })
    mockRequest.mockResolvedValue({ deliverableId: 'deliverable_teaser', status: 'REQUESTED' })
    mockTransition.mockResolvedValue({ deliverableId: DELIVERABLE_ID, status: 'IN_REVIEW' })
    mockAttachRendition.mockResolvedValue({ deliverableId: DELIVERABLE_ID, renditionCount: 1 })
    mockRecordAssessment.mockResolvedValue({
      id: 'assessment_1',
      intakeSessionId: 'intake_session_1',
      status: 'READY',
      source: 'TEAM',
      findings: [],
      createdAt: 1_900_000_000_000,
      updatedAt: 1_900_000_000_000,
    })
    mockLoadWorkspace.mockResolvedValue({
      intakeSessionId: 'intake_session_1',
      status: 'ACTIVE',
      claimedCompanyId: null,
      identityName: 'Agro Demo',
      documents: [
        {
          id: 'intake_document_1',
          displayName: 'Estados 2024.pdf',
          declaredMimeType: 'application/pdf',
          byteSize: 10,
          inspectionStatus: 'CLEAN',
          claimable: true,
          createdAt: 1_900_000_000_000,
        },
      ],
      assessment: {
        id: 'assessment_1',
        intakeSessionId: 'intake_session_1',
        status: 'NEEDS_REVIEW',
        source: 'EXTERNAL',
        findings: [
          {
            category: 'financialStatements',
            evidenceDocumentIds: ['intake_document_1'],
            confidence: 0.8,
            reviewState: 'PENDING',
          },
        ],
        createdAt: 1_900_000_000_000,
        updatedAt: 1_900_000_000_000,
      },
    })
  })

  it('lists the eight kinds of the suite and lets the team request Q&A and IRL', async () => {
    render(<AdminPreparationWorkspace companyId={COMPANY_ID} />)

    for (const kind of [
      'MODEL',
      'TEASER',
      'CIM',
      'MGMT_PRESENTATION',
      'DEBT_DECK',
      'EQUITY_DECK',
      'QA',
      'IRL',
    ]) {
      expect(screen.getByTestId(`admin-deliverable-${kind}`)).toBeVisible()
    }

    const irl = screen.getByTestId('admin-deliverable-IRL')
    expect(
      within(irl).getByRole('heading', { name: 'Lista de requerimientos (IRL)' })
    ).toBeVisible()
    fireEvent.click(within(irl).getByRole('button', { name: 'Solicitar' }))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith({ companyId: COMPANY_ID, kind: 'IRL' })
    })
  })

  it('requests a missing slot and exposes only the next valid human transition', async () => {
    render(<AdminPreparationWorkspace companyId={COMPANY_ID} />)

    const teaser = screen.getByTestId('admin-deliverable-TEASER')
    fireEvent.click(within(teaser).getByRole('button', { name: 'Solicitar' }))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        kind: 'TEASER',
      })
    })

    const model = screen.getByTestId('admin-deliverable-MODEL')
    expect(within(model).getByRole('button', { name: 'Pasar a revisión' })).toBeVisible()
    expect(within(model).queryByRole('button', { name: 'Aprobar' })).not.toBeInTheDocument()
    fireEvent.click(within(model).getByRole('button', { name: 'Pasar a revisión' }))

    await waitFor(() => {
      expect(mockTransition).toHaveBeenCalledWith({
        deliverableId: DELIVERABLE_ID,
        to: 'IN_REVIEW',
      })
    })
  })

  it('attaches a custody document to the selected rendition format', async () => {
    render(<AdminPreparationWorkspace companyId={COMPANY_ID} />)

    const model = screen.getByTestId('admin-deliverable-MODEL')
    fireEvent.change(within(model).getByLabelText('Formato'), { target: { value: 'XLSX' } })
    fireEvent.click(within(model).getByRole('checkbox', { name: /Modelo base\.xlsx/ }))
    fireEvent.click(within(model).getByRole('button', { name: 'Adjuntar' }))

    await waitFor(() => {
      expect(mockAttachRendition).toHaveBeenCalledWith({
        deliverableId: DELIVERABLE_ID,
        format: 'XLSX',
        documentId: 'document_1',
        inputManifest: ['version_1'],
      })
    })
  })

  it('loads assessment-only intake review through the audited mutation and keeps the readback', async () => {
    render(
      <AdminPreparationWorkspace intakeSessionId={'intake_session_1' as Id<'intakeSessions'>} />
    )

    await waitFor(() => {
      expect(mockLoadWorkspace).toHaveBeenCalledWith({
        intakeSessionId: 'intake_session_1',
      })
    })
    // El `waitFor` de arriba solo prueba que la mutation salió; el repintado
    // con su respuesta llega después. Solo, el archivo pasaba siempre; en el
    // gate completo, con 6337 tests repartidos en paralelo, el DOM todavía
    // decía «Cargando preparación…» y el caso moría en «Estados 2024.pdf».
    // ENVIRONMENT, no un bug del componente: se espera el estado cargado.
    await screen.findAllByText('Estados 2024.pdf', {}, { timeout: 5000 })

    expect(screen.queryByTestId('admin-deliverable-MODEL')).not.toBeInTheDocument()
    const assessment = screen.getByTestId('admin-intake-assessment')
    expect(assessment).toBeVisible()
    expect(assessment.closest('section')).toHaveAttribute(
      'aria-labelledby',
      'admin-preparation-heading'
    )
    expect(screen.getByRole('heading', { name: 'Evaluación de intake' })).toHaveAttribute(
      'id',
      'admin-preparation-heading'
    )
    expect(screen.getAllByText('Estados 2024.pdf')).not.toHaveLength(0)
    expect(
      within(screen.getByTestId('admin-intake-assessment-readback')).getByText(/Requiere revisión/)
    ).toBeVisible()
    expect(
      within(screen.getByTestId('admin-intake-assessment-readback')).getByText(/Pendiente/)
    ).toBeVisible()
  })

  it('keeps the selected company scope and shows a safe error when the audited loader fails', async () => {
    mockLoadWorkspace.mockRejectedValueOnce(new Error('load failed'))

    render(
      <AdminPreparationWorkspace
        companyId={COMPANY_ID}
        intakeSessionId={'intake_session_1' as Id<'intakeSessions'>}
      />
    )

    await waitFor(() => {
      expect(mockLoadWorkspace).toHaveBeenCalledWith({
        intakeSessionId: 'intake_session_1',
        companyId: COMPANY_ID,
      })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'La evaluación temporal no está disponible.'
    )
    expect(screen.queryByText('Estados 2024.pdf')).not.toBeInTheDocument()
  })

  it('records a team intake assessment with explicit review evidence', async () => {
    render(
      <AdminPreparationWorkspace
        companyId={COMPANY_ID}
        intakeSessionId={'intake_session_1' as Id<'intakeSessions'>}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Estados 2024.pdf' })).toBeVisible()
    })
    expect(mockLoadWorkspace).toHaveBeenCalledTimes(1)

    const initialWorkspace = await mockLoadWorkspace.mock.results[0]?.value
    mockLoadWorkspace.mockResolvedValue({
      ...initialWorkspace,
      assessment: {
        ...initialWorkspace.assessment,
        id: 'assessment_2',
        status: 'READY',
        source: 'TEAM',
        findings: [],
        updatedAt: 1_900_000_000_001,
      },
    })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Estados 2024.pdf' }))
    fireEvent.change(screen.getByLabelText('Confianza (0 a 1)'), {
      target: { value: '0.75' },
    })
    fireEvent.change(screen.getByLabelText('Revisión'), { target: { value: 'CONFIRMED' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar evaluación' }))

    await waitFor(() => {
      expect(mockRecordAssessment).toHaveBeenCalledWith({
        intakeSessionId: 'intake_session_1',
        source: 'TEAM',
        findings: [
          {
            category: 'financialStatements',
            evidenceDocumentIds: ['intake_document_1'],
            confidence: 0.75,
            reviewState: 'CONFIRMED',
          },
        ],
      })
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Evaluación registrada: Lista')
    await waitFor(() => {
      expect(mockLoadWorkspace).toHaveBeenCalledTimes(2)
      expect(
        within(screen.getByTestId('admin-intake-assessment-readback')).getByText(/Lista/)
      ).toBeVisible()
    })
    expect(mockLoadWorkspace).toHaveBeenCalledTimes(2)
    expect(mockLoadWorkspace).toHaveBeenNthCalledWith(2, {
      intakeSessionId: 'intake_session_1',
      companyId: COMPANY_ID,
    })
  })

  it('downloads one shell folder as a zip with the company id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala-SAMPLE_ENERGY.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:admin-folder')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      render(<AdminPreparationWorkspace companyId={COMPANY_ID} />)
      await userEvent.click(screen.getByRole('combobox', { name: 'Carpeta a descargar' }))
      await userEvent.click(screen.getByRole('option', { name: '3. Financieros' }))
      await userEvent.click(screen.getByTestId('admin-folder-zip-export'))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/vdr/export?locale=es&companyId=${COMPANY_ID}&folder=room_financial`,
          { method: 'GET', credentials: 'same-origin' }
        )
      })
    } finally {
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('downloads the room zip with the company id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sala-SAMPLE_ENERGY.zip"' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:admin-zip')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      render(<AdminPreparationWorkspace companyId={COMPANY_ID} />)
      fireEvent.click(screen.getByTestId('admin-zip-export'))

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/vdr/export?locale=es&companyId=${COMPANY_ID}`,
          { method: 'GET', credentials: 'same-origin' }
        )
      })
    } finally {
      createObjectURL.mockRestore()
      revokeObjectURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
