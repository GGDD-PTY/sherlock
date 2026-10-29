// ============================================================================
// TESTS: orden de capas entre menús, toast y diálogos (AU-11)
// ============================================================================
// Gana lo que el usuario abrió: menús, submenús, popovers y selects van en
// `z-[110]`, el viewport de sonner en 100 (lo fija `toaster-viewport.test.tsx`)
// y diálogos, alert-dialogs y sheets, overlay y contenido, en `z-50`. Los
// primitivos vienen de shadcn: un `shadcn add --overwrite` devuelve un menú a
// `z-50`, el toast vuelve a tapar el menú Cuenta abierto y el test del viewport
// sigue verde. Cada caso abre el primitivo real y lee la capa en el nodo que
// Radix monta en el portal.
// ============================================================================

import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'

const ABOVE_TOAST_LAYER = 'z-[110]'
const BELOW_TOAST_LAYER = 'z-50'

type OpenSurface = {
  surface: string
  slots: readonly string[]
  ui: ReactElement
}

const ABOVE_TOAST: readonly OpenSurface[] = [
  {
    surface: 'dropdown menu and its submenu',
    slots: ['dropdown-menu-content', 'dropdown-menu-sub-content'],
    ui: (
      <DropdownMenu open>
        <DropdownMenuTrigger>Cuenta</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Tema</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Oscuro</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    surface: 'popover',
    slots: ['popover-content'],
    ui: (
      <Popover open>
        <PopoverTrigger>Filtros</PopoverTrigger>
        <PopoverContent>Filtrar por carpeta</PopoverContent>
      </Popover>
    ),
  },
  {
    surface: 'select',
    slots: ['select-content'],
    ui: (
      <Select open defaultValue="deuda">
        <SelectTrigger aria-label="Transacción">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="deuda">Deuda</SelectItem>
          <SelectItem value="equity">Equity</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
]

const BELOW_TOAST: readonly OpenSurface[] = [
  {
    surface: 'dialog',
    slots: ['dialog-overlay', 'dialog-content'],
    ui: (
      <Dialog open>
        <DialogContent>
          <DialogTitle>Renombrar documento</DialogTitle>
          <DialogDescription>El nombre nuevo se ve en toda la sala.</DialogDescription>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    surface: 'alert dialog',
    slots: ['alert-dialog-overlay', 'alert-dialog-content'],
    ui: (
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Archivar documento</AlertDialogTitle>
          <AlertDialogDescription>Lo puedes restaurar después.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  {
    surface: 'sheet',
    slots: ['sheet-overlay', 'sheet-content'],
    ui: (
      <Sheet open>
        <SheetContent>
          <SheetTitle>Detalle del documento</SheetTitle>
          <SheetDescription>Versiones y actividad.</SheetDescription>
        </SheetContent>
      </Sheet>
    ),
  },
]

// Todas las utilidades `z-*` de cada nodo, con o sin variante (`sm:z-10`): una
// segunda capa rompe el caso igual que un cambio de la primera. Se devuelven por
// `data-slot` para que el diff diga cuál de los nodos cambió.
function zLayersBySlot(slots: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    slots.map((slot) => {
      const node = document.querySelector(`[data-slot="${slot}"]`)
      if (!node) throw new Error(`${slot} no se montó`)
      const layers = Array.from(node.classList).filter((cls) =>
        cls.split(':').pop()?.startsWith('z-')
      )
      return [slot, layers]
    })
  )
}

function sameLayer(slots: readonly string[], layer: string): Record<string, string[]> {
  return Object.fromEntries(slots.map((slot) => [slot, [layer]]))
}

describe('UI layer order (AU-11)', () => {
  it.each(ABOVE_TOAST)('stacks an open $surface above the toast', ({ slots, ui }) => {
    render(ui)
    expect(zLayersBySlot(slots)).toEqual(sameLayer(slots, ABOVE_TOAST_LAYER))
  })

  it.each(BELOW_TOAST)('keeps an open $surface below the toast', ({ slots, ui }) => {
    render(ui)
    expect(zLayersBySlot(slots)).toEqual(sameLayer(slots, BELOW_TOAST_LAYER))
  })
})
