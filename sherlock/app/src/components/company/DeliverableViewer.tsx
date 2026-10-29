'use client'

import { Eye } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Option, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import { DocumentViewerDialog } from '@/components/documents/DocumentViewerDialog'
import { Button } from '@/components/ui/button'

// ===== LA COSTURA CON EFFECT =====
// La rendition llega por props desde una proyección del servidor, así que este
// componente es una frontera: lo que entra puede no tener la forma que el tipo
// promete. `hasUsableRendition` ya lo sabía y lo revisaba a mano; ahora la
// misma regla —el formato es uno de los cuatro y el documentId es una cadena
// que no queda vacía al recortarla— se declara con `effect/Schema` y el tipo de
// TypeScript se deriva de esa declaración.
const DeliverableRenditionFormatSchema = Schema.Literals(['HTML', 'PPTX', 'PDF', 'XLSX'])
type DeliverableRenditionFormat = typeof DeliverableRenditionFormatSchema.Type

export type DeliverableRendition = {
  format: DeliverableRenditionFormat
  documentId: Id<'documents'>
  /** Optional fields are accepted when a richer authorized projection is available. */
  name?: string | null
  fileType?: string | null
}

type DeliverableViewerProps = {
  rendition: DeliverableRendition
  deliverableName: string
  isDraft?: boolean
}

const FILE_TYPES: Record<DeliverableRenditionFormat, string> = {
  PDF: 'application/pdf',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // HTML is intentionally presented as a non-previewable file. This keeps
  // untrusted markup out of an active browsing context; DocumentViewerDialog
  // therefore requests a DOWNLOAD grant and never mounts an HTML iframe.
  HTML: 'text/plain',
}

const decodeUsableRendition = Schema.decodeUnknownOption(
  Schema.Struct({
    format: DeliverableRenditionFormatSchema,
    // `Trim` recorta para decidir; el id que viaja al visor sigue siendo el
    // original, sin tocar.
    documentId: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1))),
  })
)

function hasUsableRendition(rendition: DeliverableRendition): boolean {
  return Option.isSome(
    decodeUsableRendition({ format: rendition.format, documentId: rendition.documentId })
  )
}

export function DeliverableViewer({
  rendition,
  deliverableName,
  isDraft = false,
}: DeliverableViewerProps) {
  const t = useTranslations('vdr.viewer')
  const deliverableT = useTranslations('deliverables')
  const locale = 'es-PA'

  if (!hasUsableRendition(rendition)) return null

  // A document name is not fabricated from the card title for access control;
  // it is only a human-readable dialog/download label when the projection has
  // not included an authorized name yet.
  const baseName = rendition.name?.trim() || `${deliverableName} · ${rendition.format}`
  const name = isDraft ? `${deliverableT('draft')} — ${baseName}` : baseName
  const fileType =
    rendition.format === 'HTML'
      ? FILE_TYPES.HTML
      : rendition.fileType?.trim() || FILE_TYPES[rendition.format]

  return (
    <DocumentViewerDialog
      documentId={rendition.documentId}
      name={name}
      fileType={fileType}
      notice={
        isDraft ? (
          <div
            role="note"
            data-testid="deliverable-viewer-draft-disclaimer"
            className="border-destructive/40 bg-destructive/5 text-foreground rounded-md border p-4 text-sm leading-6"
          >
            <p className="text-destructive font-semibold">{deliverableT('draft')}</p>
            <p className="mt-1">{deliverableT('draftDisclaimer')}</p>
          </div>
        ) : undefined
      }
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${t('open')} · ${rendition.format}`}
          lang={locale}
        >
          <Eye aria-hidden="true" />
          {t('open')}
        </Button>
      }
    />
  )
}
