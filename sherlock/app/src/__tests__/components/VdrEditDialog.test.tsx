import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { VDR_COPY } from '@/components/company/vdr/config'
import { VdrEditDialog } from '@/components/company/vdr/VdrDocumentDialogs'
import { VDR_DOCUMENT_FOLDERS, VDR_SHELL_FOLDERS } from '@/lib/vdr/document-taxonomy'

const copy = VDR_COPY.es

// Los callbacks van como no-ops tipados: ninguna prueba de este archivo mira
// lo que se llamó, solo lo que el diálogo le ofrece a quien lo abre.
const noop = () => {}

function renderDialog(overrides: Partial<React.ComponentProps<typeof VdrEditDialog>> = {}) {
  const props: React.ComponentProps<typeof VdrEditDialog> = {
    copy,
    locale: 'es',
    open: true,
    onOpenChange: noop,
    document: {
      _id: 'doc-1',
      name: 'Estados financieros',
      folder: 'room_financial',
      accessLevel: 'PRIVATE',
    },
    name: 'Estados financieros',
    folder: 'room_financial',
    accessLevel: 'PRIVATE',
    expiresAt: '',
    isSaving: false,
    onNameChange: noop,
    onFolderChange: noop,
    onAccessChange: noop,
    onExpiresAtChange: noop,
    onSave: noop,
    ...overrides,
  }

  return render(<VdrEditDialog {...props} />)
}

describe('VdrEditDialog folder catalogue', () => {
  it('offers the client only the five numbered folders of the room', async () => {
    renderDialog()

    await userEvent.click(screen.getByLabelText(copy.category))
    const options = within(screen.getByRole('listbox')).getAllByRole('option')

    expect(options.map((option) => option.textContent)).toEqual(
      VDR_SHELL_FOLDERS.map((folder) => folder.label.es)
    )
  })

  it('keeps the full legacy catalogue for the team', async () => {
    renderDialog({ adminOperator: true })

    await userEvent.click(screen.getByLabelText(copy.category))
    const options = within(screen.getByRole('listbox')).getAllByRole('option')

    expect(options).toHaveLength(VDR_DOCUMENT_FOLDERS.length)
    expect(options.map((option) => option.textContent)).toContain('Quality of Earnings')
  })

  it('shows a legacy folder as the room draws it when the client opens the dialog', () => {
    renderDialog({
      folder: 'qoe',
      document: { _id: 'doc-1', name: 'Estados financieros', folder: 'qoe' },
    })

    expect(screen.getByLabelText(copy.category)).toHaveTextContent('3. Financieros')
  })
})
