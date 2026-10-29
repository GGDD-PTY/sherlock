import { useState } from 'react'
import { useMutation } from 'convex/react'
import { toast } from 'sonner'
import { Effect, Exit } from 'effect'

import { runClientEffectExit } from '@/lib/effect/client-runtime'
import { ApiResponseError, logApiError, readApiError } from '@/lib/vdr/read-api-error'

import { api } from '@/../convex/_generated/api'
import { adminVdrTarget } from '@/../convex/_adminVdr/capabilityFormat'
import type { Id } from '@/../convex/_generated/dataModel'
import { isDeniedDocumentAccess } from '@/../convex/_documents/accessResult'
import { useAuth } from '@/hooks/useAuth'
import { removeDemoDocument, updateDemoDocument } from '@/lib/dev-auth/demo-browser-store'
import {
  inferClassificationFromAccessLevel,
  type DocumentClassification,
} from '@/lib/documents/classification'
import { openFromGrant } from '@/lib/utils/deliver-grant'
import { businessErrorMessage, localizedErrorMessage, VDR_COPY } from './config'
import {
  endOfLocalDayTimestamp,
  runVdrDocumentCommand,
  toDateInputValue,
  vdrClassificationOr,
  vdrCommandCause,
} from './helpers'
import {
  vdrAccessLevelOr,
  type EditableVdrDocument,
  type VdrAccessLevel,
  type VdrCopy,
  type VdrDocumentView,
  type VdrLocale,
} from './types'
import { useAdminVdrCapability } from './AdminVdrCapabilityContext'

// ===== LA COSTURA CON EFFECT =====
// Las cinco acciones sobre un documento —abrirlo, moverlo, renombrarlo,
// guardarlo, archivarlo— eran cinco `try/catch` con la misma forma: el fallo se
// aplanaba a un booleano o a un toast adentro del catch, y en una traza las
// cinco eran la misma promesa anónima.
//
// Ahora cada una corre por `runVdrDocumentCommand` con su propio span
// (`Vdr.openDocument`, `Vdr.moveDocument`, …) y el borde decide con el Exit en
// la mano. Los toasts, los logs y los valores de retorno son los mismos: lo que
// cambia es que el fallo llega con nombre en vez de anónimo.

export function useVdrDocumentActions({
  copy,
  locale,
  isDemo,
  bumpDemoVersion,
}: {
  copy: VdrCopy
  locale: VdrLocale
  isDemo: boolean
  bumpDemoVersion: () => void
}) {
  const errorCopy = VDR_COPY[locale]
  const { user, isSignedIn } = useAuth()
  const updateDocument = useMutation(api.documents.update)
  const getDownloadUrl = useMutation(api.documents.getDownloadUrl)
  const authorizeAdminVdr = useAdminVdrCapability()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<EditableVdrDocument | null>(null)
  const [editName, setEditName] = useState('')
  const [editFolder, setEditFolder] = useState('other')
  const [editAccess, setEditAccessValue] = useState<VdrAccessLevel>('NDA_REQUIRED')
  const [editClassification, setEditClassification] =
    useState<DocumentClassification>('CONFIDENTIAL')
  const [editExpiresAt, setEditExpiresAt] = useState('')
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeletingValue] = useState<VdrDocumentView | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  async function openDocument(document: VdrDocumentView) {
    const exit = await runClientEffectExit(
      runVdrDocumentCommand(() =>
        getDownloadUrl({ documentId: document._id as Id<'documents'>, action: 'VIEW' })
      ).pipe(
        Effect.tapError((error) => Effect.logError('Error al abrir documento', error.cause)),
        Effect.withSpan('Vdr.openDocument')
      )
    )
    if (!Exit.isSuccess(exit)) {
      toast.error(copy.openError)
      return
    }

    const url = exit.value
    // `url.message` es la redacción en español que la policy deja en la
    // bitácora: se resuelve por CÓDIGO estable y nunca se renderiza crudo.
    if (isDeniedDocumentAccess(url)) {
      return toast.error(localizedErrorMessage(errorCopy.denialReasons, url.code, copy.openError))
    }
    if (!url) return toast.error(copy.openUnavailable)
    // Tras el `await` el popup puede quedar bloqueado (móvil siempre); si
    // pasa, se navega en la misma pestaña en vez de no hacer nada.
    openFromGrant(url)
  }

  /**
   * Mover un documento entre carpetas es un patch de `folder` y nada más: la
   * misma mutation con RBAC y capability de admin que usa la edición completa.
   * Devuelve si el movimiento quedó firme para que el shell expanda el destino.
   */
  async function moveDocumentToFolder(documentId: string, folder: string): Promise<boolean> {
    if (!isSignedIn || !user) return false

    if (isDemo) {
      const updated = updateDemoDocument(documentId, { folder })
      if (!updated) {
        toast.error(copy.editError)
        return false
      }
      bumpDemoVersion()
      return true
    }

    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () =>
        updateDocument(
          await authorizeAdminVdr('DOCUMENT_UPDATE', adminVdrTarget('DOCUMENT', documentId), {
            documentId: documentId as Id<'documents'>,
            folder,
          })
        )
      ).pipe(
        Effect.tapError((error) => Effect.logError('Error al mover documento', error.cause)),
        Effect.withSpan('Vdr.moveDocument')
      )
    )
    if (Exit.isSuccess(exit)) return true

    const cause = vdrCommandCause(exit)
    toast.error(businessErrorMessage(cause, errorCopy.mutationErrors, copy.editError))
    return false
  }

  async function renameDocument(documentId: string, nextName: string): Promise<boolean> {
    if (!isSignedIn || !user) return false
    const name = nextName.trim()
    if (!name) {
      toast.error(copy.missingFile)
      return false
    }

    if (isDemo) {
      const updated = updateDemoDocument(documentId, { name })
      if (!updated) {
        toast.error(copy.editError)
        return false
      }
      bumpDemoVersion()
      return true
    }

    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () =>
        updateDocument(
          await authorizeAdminVdr('DOCUMENT_UPDATE', adminVdrTarget('DOCUMENT', documentId), {
            documentId: documentId as Id<'documents'>,
            name,
          })
        )
      ).pipe(
        Effect.tapError((error) => Effect.logError('Error al renombrar documento', error.cause)),
        Effect.withSpan('Vdr.renameDocument')
      )
    )
    if (Exit.isSuccess(exit)) return true

    const cause = vdrCommandCause(exit)
    toast.error(businessErrorMessage(cause, errorCopy.mutationErrors, copy.editError))
    return false
  }

  function beginEdit(document: EditableVdrDocument) {
    const nextAccess = vdrAccessLevelOr(document.accessLevel)
    setEditing(document)
    setEditName(document.name)
    setEditFolder(document.folder || 'other')
    setEditAccessValue(nextAccess)
    setEditClassification(
      vdrClassificationOr(document.classification, inferClassificationFromAccessLevel(nextAccess))
    )
    setEditExpiresAt(toDateInputValue(document.expiresAt))
    setEditOpen(true)
  }

  function setEditAccess(value: VdrAccessLevel) {
    setEditAccessValue(value)
    setEditClassification(inferClassificationFromAccessLevel(value))
  }

  async function saveEdit() {
    if (!isSignedIn || !user || !editing) return
    const name = editName.trim()
    if (!name) return toast.error(copy.missingFile)
    setIsSavingEdit(true)
    // La fecha se valida DENTRO del programa: `endOfLocalDayTimestamp` lanza si
    // el día no existe y ese fallo tiene que llegar al mismo borde que el de la
    // mutation, no quedarse fuera del Exit.
    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () => {
        const expiresAt = editExpiresAt ? endOfLocalDayTimestamp(editExpiresAt) : null
        const changes = {
          name,
          folder: editFolder,
          accessLevel: editAccess,
          classification: editClassification,
          expiresAt,
        }
        if (isDemo) {
          updateDemoDocument(editing._id, { ...changes, expiresAt: expiresAt ?? undefined })
          bumpDemoVersion()
          return
        }

        const mutationInput = { documentId: editing._id as Id<'documents'>, ...changes }
        await updateDocument(
          await authorizeAdminVdr(
            'DOCUMENT_UPDATE',
            adminVdrTarget('DOCUMENT', editing._id),
            mutationInput
          )
        )
      }).pipe(
        Effect.tapError((error) => Effect.logError('Error al actualizar documento', error.cause)),
        Effect.withSpan('Vdr.saveDocumentEdit')
      )
    )
    setIsSavingEdit(false)

    if (!Exit.isSuccess(exit)) {
      const cause = vdrCommandCause(exit)
      toast.error(businessErrorMessage(cause, errorCopy.mutationErrors, copy.editError))
      return
    }

    toast.success(copy.editSuccess)
    setEditOpen(false)
    setEditing(null)
  }

  function setDeleting(document: VdrDocumentView) {
    setDeletingValue(document)
    setDeleteOpen(true)
  }

  async function deleteDocument() {
    if (!isSignedIn || !user || !deleting) return
    setIsDeleting(true)
    const command = isDemo
      ? runVdrDocumentCommand(async () => {
          removeDemoDocument(deleting._id)
          bumpDemoVersion()
        })
      : runVdrDocumentCommand(() =>
          fetch(`/api/documents/${deleting._id}`, { method: 'DELETE' })
        ).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.void
              : readApiError(response).pipe(Effect.flatMap((error) => Effect.fail(error)))
          )
        )
    const exit = await runClientEffectExit(
      command.pipe(
        Effect.tapError((error) =>
          error instanceof ApiResponseError
            ? logApiError('Error al archivar documento', error)
            : Effect.logError('Error al archivar documento', error.cause)
        ),
        Effect.withSpan('Vdr.archiveDocument')
      )
    )
    setIsDeleting(false)

    if (!Exit.isSuccess(exit)) {
      toast.error(copy.deleteError)
      return
    }

    toast.success(copy.deleteSuccess)
    setDeleteOpen(false)
    setDeletingValue(null)
  }

  return {
    openDocument,
    moveDocumentToFolder,
    renameDocument,
    beginEdit,
    editOpen,
    setEditOpen,
    editing,
    editName,
    setEditName,
    editFolder,
    setEditFolder,
    editAccess,
    setEditAccess,
    editExpiresAt,
    setEditExpiresAt,
    isSavingEdit,
    saveEdit,
    deleteOpen,
    setDeleteOpen,
    deleting,
    setDeleting,
    isDeleting,
    deleteDocument,
  }
}
