import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  RoomDropConflictDialog,
  type RoomDropConflictDialogCopy,
} from '@/components/documents/shell/RoomDropConflictDialog'

const COPY: RoomDropConflictDialogCopy = {
  title: 'Cambiar la carpeta del lote',
  description: (currentFolder, nextFolder) =>
    `El lote abierto en ${currentFolder} pasará completo a ${nextFolder} y agregará los archivos nuevos.`,
  close: 'Cerrar confirmación',
  cancel: 'Conservar lote actual',
  confirm: 'Cambiar carpeta y agregar',
  pending: 'Cambiando carpeta',
}

function StatefulDialog({
  onConfirm = vi.fn(),
  currentFolderLabel = '1. Finanzas',
  nextFolderLabel = '4. Operaciones',
  copy = COPY,
}: {
  onConfirm?: () => void
  currentFolderLabel?: string
  nextFolderLabel?: string
  copy?: RoomDropConflictDialogCopy
}) {
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState(false)
  const returnFocusRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button ref={returnFocusRef} type="button">
        4. Operaciones
      </button>
      <RoomDropConflictDialog
        open={open}
        pending={pending}
        currentFolderLabel={currentFolderLabel}
        nextFolderLabel={nextFolderLabel}
        copy={copy}
        returnFocusRef={returnFocusRef}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          onConfirm()
          setPending(true)
        }}
      />
    </>
  )
}

describe('RoomDropConflictDialog', () => {
  it('names both folders and explains that the whole batch moves before new files are added', () => {
    render(<StatefulDialog />)

    const dialog = screen.getByRole('dialog', { name: COPY.title })
    expect(dialog).toHaveTextContent('1. Finanzas')
    expect(dialog).toHaveTextContent('4. Operaciones')
    expect(dialog).toHaveTextContent('lote abierto')
    expect(dialog).toHaveTextContent('pasará completo')
    expect(dialog).toHaveTextContent('agregará los archivos nuevos')
  })

  it('cancels without confirming and restores focus to the drop target', async () => {
    const onConfirm = vi.fn()
    render(<StatefulDialog onConfirm={onConfirm} />)

    await userEvent.click(screen.getByRole('button', { name: COPY.cancel }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '4. Operaciones' })).toHaveFocus()
  })

  it('blocks close, Escape, outside interaction, and both actions while pending', async () => {
    const onConfirm = vi.fn()
    render(<StatefulDialog onConfirm={onConfirm} />)

    await userEvent.click(screen.getByRole('button', { name: COPY.confirm }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: COPY.close })).toBeDisabled()
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeDisabled()
    expect(screen.getByRole('button', { name: COPY.pending })).toBeDisabled()

    await userEvent.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)

    expect(screen.getByRole('dialog', { name: COPY.title })).toBeInTheDocument()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('reflows long copy and keeps its controls reachable in a short viewport', () => {
    const longCopy: RoomDropConflictDialogCopy = {
      ...COPY,
      description: (currentFolder, nextFolder) =>
        `${COPY.description(currentFolder, nextFolder)} ${'Revisa el lote completo antes de continuar. '.repeat(24)}`,
    }
    render(
      <StatefulDialog
        currentFolderLabel={`1. ${'Finanzas'.repeat(20)}`}
        nextFolderLabel={`4. ${'Operaciones'.repeat(20)}`}
        copy={longCopy}
      />
    )

    const dialog = screen.getByRole('dialog', { name: COPY.title })
    expect(dialog).toHaveClass(
      'max-w-[calc(100%-2rem)]',
      'max-h-[calc(100dvh-2rem)]',
      'min-w-0',
      'overflow-x-hidden',
      'overflow-y-auto'
    )
    expect(dialog).not.toHaveClass('overflow-hidden')
    expect(screen.getByText(/El lote abierto/)).toHaveClass('[overflow-wrap:anywhere]')
    const actions = screen.getByTestId('room-drop-conflict-actions')
    expect(dialog).toContainElement(actions)
    expect(actions).toHaveClass('flex-col-reverse', 'sm:flex-row')
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeEnabled()
    expect(screen.getByRole('button', { name: COPY.confirm })).toBeEnabled()
  })
})
