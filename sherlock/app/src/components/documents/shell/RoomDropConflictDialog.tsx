'use client'

import { Loader2, X } from 'lucide-react'
import type { RefObject } from 'react'
import { Effect, Schema } from 'effect'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { runClientSync } from '@/lib/effect/client-runtime'

export type RoomDropConflictDialogCopy = {
  title: string
  description: (currentFolderLabel: string, nextFolderLabel: string) => string
  close: string
  cancel: string
  confirm: string
  pending: string
}

type Props = {
  open: boolean
  pending: boolean
  currentFolderLabel: string
  nextFolderLabel: string
  copy: RoomDropConflictDialogCopy
  returnFocusRef: RefObject<HTMLElement | null>
  onCancel: () => void
  onConfirm: () => void
}

const isOpenIntent = Schema.is(Schema.Boolean)

const dismissIfIdle = Effect.fn('RoomDropConflictDialog.dismissIfIdle')(function* (
  nextOpen: unknown,
  pending: boolean,
  onCancel: () => void
) {
  if (isOpenIntent(nextOpen) && !nextOpen && !pending) onCancel()
  return yield* Effect.void
})

const preventPendingDismiss = Effect.fn('RoomDropConflictDialog.preventPendingDismiss')(function* (
  event: Event,
  pending: boolean
) {
  if (pending) event.preventDefault()
  return yield* Effect.void
})

const restoreReturnFocus = Effect.fn('RoomDropConflictDialog.restoreReturnFocus')(function* (
  event: Event,
  returnTarget: HTMLElement | null
) {
  if (!returnTarget) return yield* Effect.void
  event.preventDefault()
  returnTarget.focus({ preventScroll: true })
  return yield* Effect.void
})

export function RoomDropConflictDialog({
  open,
  pending,
  currentFolderLabel,
  nextFolderLabel,
  copy,
  returnFocusRef,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        runClientSync(dismissIfIdle(nextOpen, pending, onCancel))
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] min-w-0 overflow-x-hidden overflow-y-auto p-4 sm:max-w-lg sm:p-6"
        onEscapeKeyDown={(event) => {
          runClientSync(preventPendingDismiss(event, pending))
        }}
        onPointerDownOutside={(event) => {
          runClientSync(preventPendingDismiss(event, pending))
        }}
        onInteractOutside={(event) => {
          runClientSync(preventPendingDismiss(event, pending))
        }}
        onCloseAutoFocus={(event) => {
          runClientSync(restoreReturnFocus(event, returnFocusRef.current))
        }}
      >
        <DialogClose
          type="button"
          aria-label={copy.close}
          disabled={pending}
          className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none"
        >
          <X aria-hidden="true" className="size-4" />
        </DialogClose>

        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="[overflow-wrap:anywhere]">{copy.title}</DialogTitle>
          <DialogDescription className="min-w-0 leading-6 [overflow-wrap:anywhere]">
            {copy.description(currentFolderLabel, nextFolderLabel)}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter
          data-testid="room-drop-conflict-actions"
          className="min-w-0 flex-col-reverse sm:flex-row"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full whitespace-normal sm:w-auto"
              disabled={pending}
            >
              {copy.cancel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="min-h-11 w-full whitespace-normal sm:w-auto"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            <span aria-live="polite">{pending ? copy.pending : copy.confirm}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
