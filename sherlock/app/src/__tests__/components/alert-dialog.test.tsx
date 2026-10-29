// ============================================================================
// TESTS: AlertDialogCancel — la variante de botón atada al catálogo
// ============================================================================
// `AlertDialogCancel` pinta con `buttonVariants({ variant: CANCEL_VARIANT })`,
// donde `CANCEL_VARIANT = Schema.decodeSync(ButtonVariantSchema)('outline')`
// corre al cargar el módulo. Si alguien renombra la variante `outline` en
// `button.tsx` sin tocar acá, el decode revienta al importar el módulo en vez
// de dejar el botón sin clases y sin aviso. Ver research/BUGS.md #9.
// ============================================================================

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'

describe('AlertDialogCancel', () => {
  it('renders with the outline button variant', () => {
    render(
      <AlertDialog open>
        <AlertDialogTrigger>abrir</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    )

    const cancel = screen.getByText('Cancelar')
    for (const cls of buttonVariants({ variant: 'outline' }).split(' ')) {
      expect(cancel).toHaveClass(cls)
    }
  })
})
