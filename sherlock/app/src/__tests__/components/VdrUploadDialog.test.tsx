import { createRef } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AdminVdrCapabilityProvider } from '@/components/company/vdr/AdminVdrCapabilityContext'
import { VDR_COPY } from '@/components/company/vdr/config'
import { VdrUploadDialog } from '@/components/company/vdr/VdrUploadDialog'
import type { VdrQueuedUpload } from '@/lib/documents/upload-queue'
import { VDR_SHELL_FOLDERS } from '@/lib/vdr/document-taxonomy'

const copy = VDR_COPY.es

const pendingFile = new File(['pdf'], 'estados-financieros.pdf', { type: 'application/pdf' })

const pendingQueue: VdrQueuedUpload[] = [
  {
    id: 'queue-1',
    file: pendingFile,
    name: 'estados-financieros',
    status: 'PENDING',
  },
]

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof VdrUploadDialog>> = {},
  options: { adminCompanyId?: string | null } = {}
) {
  const onAccessChange = vi.fn()
  const onClassificationChange = vi.fn()
  const onFolderChange = vi.fn()
  const onUpload = vi.fn()
  const props: React.ComponentProps<typeof VdrUploadDialog> = {
    copy,
    locale: 'es',
    roomTitle: 'SAMPLE_ENERGY',
    open: true,
    onOpenChange: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    selectedFile: null,
    uploadQueue: pendingQueue,
    allowMultiple: true,
    docName: 'estados-financieros',
    folder: 'other',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    isUploading: false,
    singleUploadReconciliationRequired: false,
    onFileSelect: vi.fn(),
    onNameChange: vi.fn(),
    onFolderChange,
    onAccessChange,
    onClassificationChange,
    onCancel: vi.fn(),
    onStop: vi.fn(),
    onRemoveFile: vi.fn(),
    onUpload,
    ...overrides,
  }

  const view = render(
    <AdminVdrCapabilityProvider companyId={options.adminCompanyId ?? null}>
      <VdrUploadDialog {...props} />
    </AdminVdrCapabilityProvider>
  )

  return { ...view, onAccessChange, onClassificationChange, onFolderChange, onUpload, props }
}

describe('VdrUploadDialog company one-step upload', () => {
  it('renders COMPANY with one file input and one folder selector, without access or confidentiality', () => {
    renderDialog()

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(1)
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1)
    expect(within(dialog).getByLabelText('Carpeta')).toBeVisible()
    expect(within(dialog).queryByLabelText(copy.documentName)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(copy.accessLevel)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(copy.classification)).not.toBeInTheDocument()
    expect(within(dialog).queryByText(copy.accessNda)).not.toBeInTheDocument()
  })

  it('keeps the hidden file input out of the layout so the dialog never scrolls sideways', () => {
    renderDialog()

    // jsdom no mide cajas: lo que se puede fijar es que el control oculto no
    // lleve ninguna clase de ancho del kit. Con `w-full` medía 510px en
    // `position: absolute` y el diálogo desbordaba 23px hacia la derecha.
    const input = screen.getByRole('dialog').querySelector('input[type="file"]')
    expect(input).toHaveClass('sr-only')
    expect(input?.className).not.toMatch(/\bw-full\b/)
  })

  it('lists the five shell folders plus automatic routing for COMPANY', async () => {
    renderDialog()

    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: 'Ruteo automático' })).toBeInTheDocument()
    for (const folder of VDR_SHELL_FOLDERS) {
      expect(screen.getByRole('option', { name: folder.label.es })).toBeInTheDocument()
    }
    expect(screen.queryByRole('option', { name: copy.accessNda })).not.toBeInTheDocument()
  })

  it('submits the current access and confidentiality defaults without showing them', async () => {
    const { onAccessChange, onClassificationChange, onUpload } = renderDialog()

    await userEvent.click(screen.getByRole('button', { name: copy.upload }))

    expect(onAccessChange).toHaveBeenCalledWith('NDA_REQUIRED')
    expect(onClassificationChange).toHaveBeenCalledWith('CONFIDENTIAL')
    expect(onUpload).toHaveBeenCalledTimes(1)
  })

  it('keeps the full admin form, including access and confidentiality', () => {
    renderDialog({ folder: 'other' }, { adminCompanyId: 'company_admin_1' })

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(1)
    expect(within(dialog).getByLabelText(copy.documentName)).toBeVisible()
    expect(within(dialog).getByLabelText(copy.category)).toBeVisible()
    expect(within(dialog).getByLabelText(copy.accessLevel)).toBeVisible()
    expect(within(dialog).getByLabelText(copy.classification)).toBeVisible()
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(3)
  })

  it('persists a chosen shell folder and maps automatic routing to other', async () => {
    const { onFolderChange } = renderDialog()

    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(screen.getByRole('option', { name: '3. Financieros' }))
    expect(onFolderChange).toHaveBeenCalledWith('room_financial')
  })

  it('maps automatic routing to the landing folder', async () => {
    const { onFolderChange } = renderDialog({ folder: 'room_legal' })

    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(screen.getByRole('option', { name: 'Ruteo automático' }))
    expect(onFolderChange).toHaveBeenCalledWith('other')
  })

  it('reads version title, replace copy and stop from the catalog', () => {
    renderDialog({
      versionOfName: 'Estados financieros',
      allowMultiple: false,
      selectedFile: pendingFile,
      uploadQueue: [],
      isUploading: true,
    })

    expect(screen.getByRole('dialog', { name: 'Subir nueva versión' })).toBeInTheDocument()
    expect(screen.getByText('Reemplaza Estados financieros sin perder el historial.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Detener cargas' })).toBeVisible()
  })

  it('does not overwrite access or confidentiality when COMPANY replaces a version', async () => {
    const { onAccessChange, onClassificationChange, onUpload } = renderDialog({
      versionOfName: 'Estados financieros',
      allowMultiple: false,
      selectedFile: pendingFile,
      uploadQueue: [],
      folder: 'room_financial',
      accessLevel: 'PRIVATE',
      classification: 'RESTRICTED',
    })

    await userEvent.click(screen.getByRole('button', { name: copy.upload }))

    expect(onAccessChange).not.toHaveBeenCalled()
    expect(onClassificationChange).not.toHaveBeenCalled()
    expect(onUpload).toHaveBeenCalledTimes(1)
  })
})
