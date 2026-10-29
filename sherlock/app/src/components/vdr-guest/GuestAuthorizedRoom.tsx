import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { PdfViewer } from '@/components/documents/viewers/PdfViewer'
import { FileText, FolderOpen, LockKeyhole, LogOut } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/utils'
import type { GuestRoom, GuestRoomDocument } from './guestRoomContract'

type Locale = 'es'

const SECTION_HEADING = 'font-sans text-lg leading-tight font-semibold'

function groupDocuments(documents: readonly GuestRoomDocument[], locale: Locale) {
  const folders = new Map<string, GuestRoomDocument[]>()
  for (const document of documents) {
    folders.set(document.folder, [...(folders.get(document.folder) ?? []), document])
  }
  return [...folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right, locale))
    .map(([folder, items]) => ({
      folder,
      documents: items.sort((left, right) => left.name.localeCompare(right.name, locale)),
    }))
}

export function GuestAuthorizedRoom({
  room,
  locale,
  busy,
  formError,
  onLogout,
}: {
  room: GuestRoom
  locale: Locale
  busy: boolean
  formError: boolean
  onLogout: () => void
}) {
  const t = useTranslations('vdrGuest')
  const [viewing, setViewing] = useState<GuestRoomDocument | null>(null)
  // El índice ES la sala: responde «qué hay acá». El nombre de la sala y su
  // descripción los pinta el único título de la pantalla, en
  // `GuestInvitationJourney`; acá no se repiten.
  return (
    <div className="mt-5 space-y-5">
      <div className="text-muted-foreground flex items-start gap-2 text-sm leading-6">
        <LockKeyhole className="mt-1 h-4 w-4 shrink-0" aria-hidden />
        <p>
          {room.documents.some((document) => document.viewPath)
            ? t('room.readOnly')
            : t('room.secureDeliveryUnavailable')}{' '}
          {t('room.reevaluated')}
        </p>
      </div>

      {viewing?.viewPath && (
        <div className="h-[70vh] min-h-96">
          <PdfViewer
            key={viewing.viewPath}
            viewUrl={viewing.viewPath}
            fileName={viewing.name}
            chrome={{
              fileName: viewing.name,
              kind: 'PDF',
              downloadUrl: null,
              onClose: () => setViewing(null),
            }}
          />
        </div>
      )}
      <section aria-labelledby="guest-room-documents-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="guest-room-documents-heading" className={SECTION_HEADING}>
            {t('room.documentLibrary')}
          </h2>
          <span className="text-muted-foreground font-data text-xs">
            {t('room.documentCount', { count: room.documents.length })}
          </span>
        </div>
        {room.documents.length === 0 ? (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            {t('room.emptyRoom')}
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {groupDocuments(room.documents, locale).map((group) => (
              <section key={group.folder} aria-label={group.folder}>
                <div className="border-border flex items-center gap-2 border-b pb-2">
                  <FolderOpen className="text-primary h-4 w-4" aria-hidden />
                  <h3 className="text-sm font-semibold">{group.folder}</h3>
                  <span className="text-muted-foreground font-data ml-auto text-xs">
                    {group.documents.length}
                  </span>
                </div>
                <ul className="divide-border divide-y">
                  {group.documents.map((document, index) => (
                    <li
                      key={`${group.folder}:${document.name}:${index}`}
                      className="flex items-start gap-3 py-2"
                    >
                      <FileText
                        className="text-muted-foreground mt-2.5 h-4 w-4 shrink-0"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        {document.viewPath ? (
                          <Button
                            variant="link"
                            className="h-auto min-h-11 max-w-full px-0 text-left whitespace-normal"
                            onClick={() => setViewing(document)}
                            aria-label={`${t('room.open')}: ${document.name}`}
                          >
                            {document.name}
                          </Button>
                        ) : (
                          <p className="truncate text-sm font-medium">{document.name}</p>
                        )}
                        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <span>{document.fileType ?? t('room.unknownType')}</span>
                          <span aria-hidden>·</span>
                          <span>{formatFileSize(document.fileSize, t('room.unknownSize'))}</span>
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0">
                        {t(`room.classifications.${document.classification}`)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {room.documentsTruncated ? (
          <p role="status" className="text-muted-foreground mt-4 text-sm">
            {t('room.truncated')}
          </p>
        ) : null}
      </section>

      {formError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('logoutError')}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={busy}
        onClick={onLogout}
      >
        <LogOut className="mr-2 h-4 w-4" aria-hidden />
        {busy ? t('room.loggingOut') : t('room.logout')}
      </Button>
    </div>
  )
}
