'use client'

// ============================================================================
// ROOM DOCUMENT INFO DIALOG
// ============================================================================
// La metadata de un documento vive detrás de una acción explícita
// («Información» en la fila de acciones de su ficha), no en un panel ancho
// permanente. Lee `documents.listVersions` (misma query que el diálogo de
// historial) solo para la nota del equipo, y nunca en modo demo local.
// ============================================================================

import { useQuery } from 'convex/react'
import { Schema } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isDocumentAccessLevel, type DocumentAccessLevel } from '@/lib/documents/classification'
import {
  formatRoomFileSize,
  type RoomFileKind,
  type RoomShellDocument,
  type RoomDocumentStatus,
} from '@/lib/documents/room-shell'
import { getVdrShellFolderLabel } from '@/lib/vdr/document-taxonomy'
import { formatDateTime } from '@/lib/utils'
import type { RoomLocale, RoomShellCopy } from './copy'

/** El historial es una acción del dueño de la sala; el diálogo solo la ofrece. */
export type RoomDocumentInfoVersionHistory = {
  copy: { open: string; unavailable: string }
  onOpen: (documentId: string) => void
}

type Props = {
  copy: RoomShellCopy
  locale: RoomLocale
  isDemo: boolean
  document: RoomShellDocument
  open: boolean
  onOpenChange: (open: boolean) => void
  versionHistory?: RoomDocumentInfoVersionHistory
}

// ============================================================================
// LAS CINCO TABLAS DE ROTULOS
// ============================================================================
// Antes eran escaleras de `if` que terminaban en un `return` sin condicion:
// «cualquier otro estado es Publicado», «cualquier otro acceso es NDA»,
// «cualquier otra procedencia es Subido por la empresa». Ese ultimo `return`
// era un default por descarte, y un valor nuevo del modelo caia ahi sin que
// nadie lo decidiera — justo lo que el comentario de `roomSourceLabel` avisa
// que ya paso una vez.
//
// Como tablas exhaustivas, agregar un estado, un nivel de acceso o una
// procedencia al modelo NO COMPILA hasta que alguien escriba como se llama.
//
// Las cinco tablas de abajo llevan `satisfies Record<typeof XSchema.Type, ...>`
// en vez del `Record<X, ...>` de antes: la exhaustividad de TypeScript es la
// misma (ambos tipos son la misma union de literales), pero ahora cada union
// tambien tiene un catalogo en runtime. `RoomDocumentStatus` y `RoomFileKind`
// son uniones peladas en `room-shell.ts` (esa union no valida nada ahí: nunca
// recibe un string sin decodificar) — el catalogo vive en este archivo,
// porque es este archivo el que expone las funciones a otros dos consumidores
// (`RoomFolderTree.tsx`, `RoomShell.tsx`) que sí les pasan campos de un
// documento sin volver a comprobar que el valor siga siendo uno de los que la
// union declara.

const RoomDocumentStatusSchema = Schema.Literals([
  'READY',
  'PENDING',
  'SCANNING',
  'QUARANTINED',
  'ARCHIVED',
])

const RoomFileKindSchema = Schema.Literals([
  'spreadsheet',
  'pdf',
  'document',
  'presentation',
  'image',
  'other',
])

const RoomDocumentSourceSchema = Schema.Literals([
  'PUBLIC_SOURCE',
  'SYNTHETIC_DEMO',
  'TEAM_DELIVERABLE',
  'USER_UPLOAD',
])
const isRoomDocumentStatus = Schema.is(RoomDocumentStatusSchema)
const isRoomFileKind = Schema.is(RoomFileKindSchema)
const isRoomDocumentSource = Schema.is(RoomDocumentSourceSchema)

export function roomStatusLabel(status: RoomDocumentStatus, copy: RoomShellCopy): string {
  const labels = {
    READY: copy.statusReady,
    PENDING: copy.statusPending,
    SCANNING: copy.statusScanning,
    QUARANTINED: copy.statusQuarantined,
    ARCHIVED: copy.statusArchived,
  } satisfies Record<typeof RoomDocumentStatusSchema.Type, string>
  // El catalogo se recorre para decidir el default: un status que la union ya
  // no reconozca (una fila vieja, un fixture desactualizado) cae en READY, la
  // lectura mas conservadora ("publicado"), en vez de indexar el objeto con un
  // valor que no está.
  return isRoomDocumentStatus(status) ? labels[status] : labels.READY
}

/** El estado del escaneo en palabras llanas, para la ficha de información. */
export function roomScanLabel(status: RoomDocumentStatus, copy: RoomShellCopy): string {
  const labels = {
    READY: copy.scanReady,
    PENDING: copy.scanPending,
    SCANNING: copy.scanScanning,
    QUARANTINED: copy.scanQuarantined,
    ARCHIVED: copy.scanArchived,
  } satisfies Record<typeof RoomDocumentStatusSchema.Type, string>
  return isRoomDocumentStatus(status) ? labels[status] : labels.READY
}

export function roomAccessLabel(
  accessLevel: RoomShellDocument['accessLevel'],
  copy: RoomShellCopy
): string {
  const labels = {
    PUBLIC: copy.accessPublic,
    NDA_REQUIRED: copy.accessNda,
    PRIVATE: copy.accessPrivate,
  } satisfies Record<DocumentAccessLevel, string>
  // `isDocumentAccessLevel` ya existe en `classification.ts`: es el mismo
  // catalogo que decide el nivel de acceso en el resto del VDR, no uno nuevo
  // para esta ficha.
  return isDocumentAccessLevel(accessLevel) ? labels[accessLevel] : labels.NDA_REQUIRED
}

export function roomKindLabel(kind: RoomFileKind, copy: RoomShellCopy): string {
  const labels = {
    spreadsheet: copy.kindSpreadsheet,
    pdf: copy.kindPdf,
    document: copy.kindDocument,
    presentation: copy.kindPresentation,
    image: copy.kindImage,
    other: copy.kindOther,
  } satisfies Record<typeof RoomFileKindSchema.Type, string>
  return isRoomFileKind(kind) ? labels[kind] : labels.other
}

/**
 * Procedencia en una frase, leída del campo `sourceType`: lo que devolvió el
 * equipo lleva `TEAM_DELIVERABLE` (`vdr:push`, «Marcar como entrega»). Un
 * documento sin `sourceType` es material que subió la empresa; adivinarlo por
 * el nombre del archivo etiquetaba mal en las dos direcciones.
 */
export function roomSourceLabel(document: RoomShellDocument, copy: RoomShellCopy): string {
  const labels = {
    PUBLIC_SOURCE: copy.sourcePublic,
    SYNTHETIC_DEMO: copy.sourceDemo,
    TEAM_DELIVERABLE: copy.sourceMycroft,
    USER_UPLOAD: copy.sourceUpload,
  } satisfies Record<typeof RoomDocumentSourceSchema.Type, string>
  // Sin `sourceType` declarado (o uno que el catalogo ya no reconozca) es
  // material que subio la empresa; eso SI es una decision escrita, no un
  // descarte. `isRoomDocumentSource` acepta `null` porque su parametro es
  // `unknown`, así que no hace falta un chequeo aparte para ese caso.
  return isRoomDocumentSource(document.sourceType) ? labels[document.sourceType] : copy.sourceUpload
}

function formatTimestamp(value: number | null | undefined, locale: 'es') {
  if (!value) return '—'
  // El formateador compartido: día + mes abreviado y reloj de 24 h, igual que
  // la tabla de actividad del Data Room, para poder cruzar el mismo evento.
  return formatDateTime(value, locale)
}

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-muted-foreground shrink-0 text-xs">{term}</dt>
      <dd className="text-right text-sm font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

export function RoomDocumentInfoDialog({
  copy,
  locale,
  isDemo,
  document,
  open,
  onOpenChange,
  versionHistory,
}: Props) {
  const versions = useQuery(
    api.documents.listVersions,
    isDemo ? 'skip' : { documentId: document.id as Id<'documents'> }
  )

  // La nota del equipo viaja en la versión vigente (`deliveryNote`, sellada
  // por `vdr:push` y por «Marcar como entrega»). El cliente la lee junto a la
  // procedencia, sin abrir el historial: misma query que el diálogo de
  // versiones y por lo tanto la misma autorización.
  const deliveryNote = versions?.find((version) => version.isCurrent)?.deliveryNote ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="room-document-info"
        // Una sola salida: el pie lleva «Cerrar» con nombre, así que la equis
        // de la esquina sería un segundo control con la misma etiqueta.
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{document.name}</DialogTitle>
          <DialogDescription>{copy.metadata}</DialogDescription>
        </DialogHeader>

        <div className="border-border border-l-2 pl-3">
          <p className="text-muted-foreground text-xs">{copy.provenance}</p>
          <p data-testid="room-document-info-provenance" className="mt-0.5 text-sm leading-5">
            {roomSourceLabel(document, copy)}
          </p>
          {document.sourceName ? (
            <p className="text-muted-foreground mt-0.5 text-xs leading-5 [overflow-wrap:anywhere]">
              {document.sourceName}
            </p>
          ) : null}
          {deliveryNote ? (
            <div className="mt-2">
              <p className="text-muted-foreground text-xs">{copy.deliveryNote}</p>
              <p
                data-testid="room-document-info-delivery-note"
                className="mt-0.5 text-sm leading-5 [overflow-wrap:anywhere]"
              >
                {deliveryNote}
              </p>
            </div>
          ) : null}
        </div>

        <dl className="divide-border divide-y">
          <DetailRow term={copy.folder}>
            {getVdrShellFolderLabel(document.folder, locale)}
          </DetailRow>
          <DetailRow term={copy.fileType}>{roomKindLabel(document.kind, copy)}</DetailRow>
          <DetailRow term={copy.fileSize}>
            <span className="font-mono tabular-nums">
              {formatRoomFileSize(document.sizeBytes, locale)}
            </span>
          </DetailRow>
          <DetailRow term={copy.version}>
            <span className="font-mono tabular-nums">
              {document.versionNumber ? copy.versionShort(document.versionNumber) : '—'}
            </span>
          </DetailRow>
          <DetailRow term={copy.access}>{roomAccessLabel(document.accessLevel, copy)}</DetailRow>
          <DetailRow term={copy.scanStatus}>{roomScanLabel(document.status, copy)}</DetailRow>
          <DetailRow term={copy.modified}>
            <span className="font-mono tabular-nums">
              {formatTimestamp(document.updatedAt, locale)}
            </span>
          </DetailRow>
        </dl>

        <DialogFooter>
          {versionHistory ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="max-w-full whitespace-normal"
                disabled={isDemo}
                aria-describedby={isDemo ? 'room-document-info-history-unavailable' : undefined}
                onClick={() => versionHistory.onOpen(document.id)}
              >
                {versionHistory.copy.open}
              </Button>
              {isDemo ? (
                <span id="room-document-info-history-unavailable" className="sr-only">
                  {versionHistory.copy.unavailable}
                </span>
              ) : null}
            </>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {copy.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
