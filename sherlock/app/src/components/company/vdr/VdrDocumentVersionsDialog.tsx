import { useMutation, useQuery } from 'convex/react'
import { CheckCircle2, Clock3, FileClock, RotateCcw, ScanLine, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'
import { Effect, Exit, Option, Schema } from 'effect'

import { runClientEffectExit } from '@/lib/effect/client-runtime'
import { nameAtSentenceEnd } from '@/lib/i18n/formatters'
import { formatDateTime } from '@/lib/utils'

import { api } from '@/../convex/_generated/api'
import { adminVdrTarget } from '@/../convex/_adminVdr/capabilityFormat'
import type { Id } from '@/../convex/_generated/dataModel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { VdrDocumentView, VdrLocale } from './types'
import { runVdrDocumentCommand } from './helpers'
import { useAdminVdrCapability } from './AdminVdrCapabilityContext'
import { ConvexLoadFailure } from './ConvexLoadFailure'
import { useConvexLoadTimeout } from './useConvexLoadTimeout'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// El estado de publicación es un enum del schema, no copia. Solo SUPERSEDED
// estaba traducido y el resto caía al literal crudo — `DRAFT` en pantalla, en
// inglés y en mayúsculas, en las dos caras del sitio. Ahora el borrador solo lo
// ve un ADMIN (`documents.listVersions` lo esconde del dueño COMPANY), pero
// sigue siendo texto de cara al usuario y ships en español.
//
// El enum se define una sola vez con `Schema.Literals` y su rótulo vive en la
// misma tabla: un estado nuevo del schema entra por acá o sigue cayendo al
// literal crudo, que es lo que este `default` deja ver a propósito.
const PublicationStatusSchema = Schema.Literals(['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'])
const decodePublicationStatus = Schema.decodeUnknownOption(PublicationStatusSchema)
const PUBLICATION_STATUS_KEY = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  SUPERSEDED: 'superseded',
  ARCHIVED: 'archived',
} as const satisfies Record<typeof PublicationStatusSchema.Type, string>

const MalwareScanSchema = Schema.Literals(['CLEAN', 'PENDING', 'INFECTED', 'ERROR'])
const decodeMalwareScan = Schema.decodeUnknownOption(MalwareScanSchema)
const MALWARE_SCAN_KEY = {
  CLEAN: 'clean',
  PENDING: 'pending',
  INFECTED: 'infected',
  ERROR: 'failed',
} as const satisfies Record<typeof MalwareScanSchema.Type, string>

function publicationStatusLabel(status: string, t: (key: string) => string): string {
  const decoded = decodePublicationStatus(status)
  return Option.isSome(decoded)
    ? t(`versions.status.${PUBLICATION_STATUS_KEY[decoded.value]}`)
    : status
}

function malwareScanLabel(status: string, t: (key: string) => string): string {
  const decoded = decodeMalwareScan(status)
  return Option.isSome(decoded)
    ? t(`versions.scan.${MALWARE_SCAN_KEY[decoded.value]}`)
    : t('versions.scan.unknown')
}

export function VdrDocumentVersionsDialog(props: {
  document: VdrDocumentView | null
  locale: VdrLocale
  onOpenChange: (open: boolean) => void
}) {
  const [attempt, setAttempt] = useState(0)
  return (
    <VdrDocumentVersionsDialogLive
      key={`${props.document?._id ?? 'versions-closed'}:${attempt}`}
      {...props}
      onRetry={() => {
        setAttempt((current) => current + 1)
      }}
    />
  )
}

function VdrDocumentVersionsDialogLive({
  document,
  locale,
  onOpenChange,
  onRetry,
}: {
  document: VdrDocumentView | null
  locale: VdrLocale
  onOpenChange: (open: boolean) => void
  onRetry: () => void
}) {
  const t = useTranslations('vdr')
  const [restoreCandidate, setRestoreCandidate] = useState<{
    versionId: Id<'documentVersions'>
    versionNumber: number
  } | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const restoreVersion = useMutation(api.documents.restoreVersion)
  const authorizeAdminVdr = useAdminVdrCapability()
  const versions = useQuery(
    api.documents.listVersions,
    document ? { documentId: document._id as Id<'documents'> } : 'skip'
  )
  const loadTimeout = useConvexLoadTimeout(
    document !== null && versions === undefined,
    12_000,
    document?._id ?? 'versions-closed'
  )

  async function restoreSelectedVersion() {
    if (!document || !restoreCandidate) return
    const currentVersionNumber =
      document.currentVersionNumber ??
      versions?.find((version) => version.isCurrent)?.versionNumber ??
      0
    setIsRestoring(true)
    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () => {
        const mutationInput = {
          documentId: document._id as Id<'documents'>,
          versionId: restoreCandidate.versionId,
          expectedCurrentVersionNumber: currentVersionNumber,
        }
        await restoreVersion(
          await authorizeAdminVdr(
            'DOCUMENT_VERSION_RESTORE',
            adminVdrTarget('DOCUMENT', document._id),
            mutationInput
          )
        )
      }).pipe(Effect.withSpan('Vdr.restoreVersion'))
    )
    setIsRestoring(false)

    if (!Exit.isSuccess(exit)) {
      toast.error(t('versions.restoreError'))
      return
    }

    toast.success(t('versions.restoreSuccess', { version: restoreCandidate.versionNumber }))
    setRestoreCandidate(null)
  }

  return (
    <Dialog open={Boolean(document)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('versions.title')}</DialogTitle>
          <DialogDescription>
            {t('versions.description', { name: nameAtSentenceEnd(document?.name ?? '') })}
          </DialogDescription>
        </DialogHeader>

        {loadTimeout.timedOut ? (
          <ConvexLoadFailure
            message={t('loadFailed')}
            onRetry={onRetry}
            testId="document-versions-load-failure"
          />
        ) : versions === undefined ? (
          <div className="space-y-3 py-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : versions.length === 0 ? (
          <div className="border-border bg-muted/20 rounded-xl border border-dashed px-6 py-10 text-center">
            <FileClock className="text-muted-foreground mx-auto h-7 w-7" />
            <p className="mt-3 text-sm font-medium">{t('versions.emptyTitle')}</p>
            <p className="text-muted-foreground mt-1 text-xs">{t('versions.emptyDescription')}</p>
          </div>
        ) : (
          <ol className="space-y-3 py-2">
            {versions.map((version) => (
              <li
                key={version.versionId}
                className="border-border bg-card rounded-xl border px-4 py-4 sm:px-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">v{version.versionNumber}</p>
                      {version.deliveryLabel &&
                      version.deliveryLabel.trim().toLowerCase() !== `v${version.versionNumber}` ? (
                        <Badge variant="outline">{version.deliveryLabel}</Badge>
                      ) : null}
                      {version.isCurrent ? (
                        <Badge className="gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {t('versions.current')}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {publicationStatusLabel(version.publicationStatus, t)}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {version.displayName} · {formatBytes(version.byteSize)}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Badge variant="outline" className="border-primary/30 text-primary gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      {version.verificationStatus === 'SIGNATURE_VERIFIED'
                        ? t('versions.signatureVerified')
                        : t('versions.legacyEvidence')}
                    </Badge>
                    <Badge
                      variant={version.malwareScanStatus === 'CLEAN' ? 'secondary' : 'outline'}
                      className="gap-1"
                    >
                      <ScanLine className="h-3 w-3" />
                      {malwareScanLabel(version.malwareScanStatus, t)}
                    </Badge>
                  </div>
                </div>
                <div className="text-muted-foreground mt-4 grid gap-2 border-t pt-3 text-xs sm:grid-cols-2">
                  <p className="flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatDateTime(version.createdAt, locale)}
                  </p>
                  <p className="font-data truncate sm:text-right" title={version.sha256}>
                    SHA-256 {version.sha256.slice(0, 16)}…
                  </p>
                </div>
                {version.deliveryNote ? (
                  <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                    <span className="text-foreground font-medium">{t('versions.teamNote')} </span>
                    {version.deliveryNote}
                  </p>
                ) : null}
                {!version.isCurrent && version.verificationStatus === 'SIGNATURE_VERIFIED' ? (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-10"
                      onClick={() =>
                        setRestoreCandidate({
                          versionId: version.versionId,
                          versionNumber: version.versionNumber,
                        })
                      }
                    >
                      <RotateCcw className="mr-2 h-3.5 w-3.5" />
                      {t('versions.restoreAsNew')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
      <AlertDialog
        open={Boolean(restoreCandidate)}
        onOpenChange={(open) => {
          if (!open && !isRestoring) setRestoreCandidate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('versions.restoreTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('versions.restoreDescription', {
                version: restoreCandidate?.versionNumber ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>
              {t('versions.restoreCancel')}
            </AlertDialogCancel>
            <AlertDialogAction disabled={isRestoring} onClick={() => void restoreSelectedVersion()}>
              {t('versions.restoreConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
