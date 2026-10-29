'use client'

// ============================================================================
// PRIVACY SETTINGS PAGE (GDPR)
// ============================================================================
// Página para gestionar privacidad y datos personales según GDPR
// Permite:
// - Ver y gestionar consentimientos
// - Exportar datos personales
// - Solicitar eliminación de cuenta
// ============================================================================

import { useCallback, useState } from 'react'
import { Effect, Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { useQuery, useMutation, useConvex } from 'convex/react'
import { api } from '@/../convex/_generated/api'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Shield, Download, ArrowLeft, Loader2, Mail, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { PANAMA_TIME_ZONE } from '@/lib/utils'
import { saveBlob } from '@/lib/utils/save-blob'
import { PrivacySettingsSkeleton } from './loading'

// ===== TIPOS DE CONSENTIMIENTO =====
// El vocabulario de `consents.consentType` que ESTA pantalla expone. Convex
// conoce cinco (`convex/gdpr.ts`); `analytics_tracking` nunca tuvo interruptor y
// `third_party_sharing` salió de la pantalla el 2026-09-11 porque Sherlock no
// comparte datos con socios: el interruptor describía una superficie borrada el
// 2026-08-28. Las filas ya escritas quedan en custodia en Convex. La lista se
// define una vez y el tipo sale de ella, así que un valor que Convex no acepte
// deja de compilar en el `Switch` en vez de fallar en la mutation.
const ConsentTypeSchema = Schema.Literals([
  'terms_of_service',
  'privacy_policy',
  'marketing_emails',
])

type ConsentType = typeof ConsentTypeSchema.Type

// ===== FALLOS CON NOMBRE =====
// Los tres `catch (error)` que había aquí devolvían el mismo `console.error` +
// toast genérico sin distinguir qué se rompió. Cada operación tiene ahora su
// propio fallo, con la operación adentro, y el toast sale del tipo.
class PrivacyActionError extends Schema.TaggedError<PrivacyActionError>()('PrivacyActionError', {
  operation: Schema.Literals(['recordConsent', 'exportData', 'requestDeletion']),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// El nombre del archivo lleva la fecha en formato ISO corto. `Date.now()` entra
// por parámetro para que el programa no lea el reloj por su cuenta.
function exportFileName(now: Date): string {
  return `sherlock-data-export-${now.toISOString().slice(0, 10)}.json`
}

const recordConsentProgram = Effect.fn('PrivacySettings.recordConsent')(function* (
  record: () => Promise<unknown>
) {
  yield* Effect.tryPromise({
    try: record,
    catch: (cause) => new PrivacyActionError({ operation: 'recordConsent', cause }),
  })
})

// La descarga es un efecto del navegador y vive en `saveBlob`: adquiere el
// object URL, lo entrega con un `<a download>` y lo libera un turno después.
// Acá solo se arma el JSON.
const downloadJsonProgram = Effect.fn('PrivacySettings.downloadJson')(function* (
  fileName: string,
  payload: unknown
) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  yield* saveBlob(blob, fileName)
})

const exportUserDataProgram = Effect.fn('PrivacySettings.exportUserData')(function* (
  exportData: () => Promise<unknown>
) {
  return yield* Effect.tryPromise({
    try: exportData,
    catch: (cause) => new PrivacyActionError({ operation: 'exportData', cause }),
  })
})

const requestDeletionProgram = Effect.fn('PrivacySettings.requestDeletion')(function* (
  requestDeletion: () => Promise<unknown>
) {
  yield* Effect.tryPromise({
    try: requestDeletion,
    catch: (cause) => new PrivacyActionError({ operation: 'requestDeletion', cause }),
  })
})

type ConsentItem = {
  type: ConsentType
  titleKey: string
  descriptionKey: string
  icon: React.ReactNode
  required: boolean
}

// La tarjeta de cada consentimiento, indexada por su tipo. Al ser un `Record`
// sobre el vocabulario, un tipo nuevo sin tarjeta deja de compilar aquí en vez
// de desaparecer de la pantalla sin que nadie lo note.
const CONSENT_CARDS: Record<ConsentType, Omit<ConsentItem, 'type'>> = {
  terms_of_service: {
    titleKey: 'privacy.consents.termsTitle',
    descriptionKey: 'privacy.consents.termsDescription',
    icon: <FileText className="h-4 w-4" />,
    required: true,
  },
  privacy_policy: {
    titleKey: 'privacy.consents.privacyPolicyTitle',
    descriptionKey: 'privacy.consents.privacyPolicyDescription',
    icon: <Shield className="h-4 w-4" />,
    required: true,
  },
  marketing_emails: {
    titleKey: 'privacy.consents.marketingTitle',
    descriptionKey: 'privacy.consents.marketingDescription',
    icon: <Mail className="h-4 w-4" />,
    required: false,
  },
}

// Los tres ids de cada fila de consentimiento. Salen del tipo, asi que son
// estables entre renders y no chocan con otra tarjeta de la pagina.
const consentSwitchId = (type: ConsentType) => `consent-${type}`
const consentTitleId = (type: ConsentType) => `consent-${type}-title`
const consentDescriptionId = (type: ConsentType) => `consent-${type}-description`
const deletionReasonId = 'privacy-deletion-reason'
const deletionReasonLabelId = 'privacy-deletion-reason-label'

// El orden de la pantalla es el orden del vocabulario, no una segunda lista
// escrita a mano al lado de la primera.
const CONSENT_ITEMS: ConsentItem[] = ConsentTypeSchema.literals.map((type) => {
  const { titleKey, descriptionKey, icon, required } = CONSENT_CARDS[type]
  return { type, titleKey, descriptionKey, icon, required }
})

export function PrivacySettingsClient() {
  const t = useTranslations('settings')
  const router = useRouter()
  const convex = useConvex()
  const { profile, isLoading: userLoading } = useCurrentUser()
  const [deletionReason, setDeletionReason] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // ===== QUERIES =====
  const consents = useQuery(
    api.gdpr.getUserConsents,
    profile?._id ? { profileId: profile._id } : 'skip'
  )
  const pendingDeletion = useQuery(
    api.gdpr.getPendingDeletionRequest,
    profile?._id ? { profileId: profile._id } : 'skip'
  )
  // ===== MUTATIONS =====
  const recordConsent = useMutation(api.gdpr.recordConsent)
  const requestDeletion = useMutation(api.gdpr.requestAccountDeletion)

  // ===== ESTADO DE CONSENTIMIENTOS =====
  // Mientras Convex no responde, la query es `undefined` y eso NO es «no
  // aceptado»: colapsarlo a `false` pintaba los interruptores en apagado y los
  // dejaba usables, así que un clic en ese hueco escribía sobre un valor que la
  // pantalla todavía no conocía. Sin dato no hay estado: `undefined` sube tal
  // cual y el interruptor se queda inerte hasta que la lista llegue.
  const consentsLoading = consents === undefined

  const getConsentStatus = (type: ConsentType): boolean | undefined => {
    if (consents === undefined) return undefined
    return consents.find((c) => c.consentType === type)?.accepted ?? false
  }

  // ===== MANEJAR CAMBIO DE CONSENTIMIENTO =====
  // El programa vive arriba; el handler solo lo corre. Ésa es la regla del
  // borde: nunca se corre un Effect en el cuerpo del módulo ni en el render.
  const handleConsentChange = useCallback(
    (type: ConsentType, accepted: boolean) => {
      const profileId = profile?._id
      if (!profileId) return

      void runClientEffect(
        recordConsentProgram(() => recordConsent({ profileId, consentType: type, accepted })).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              toast.success(
                accepted ? t('privacy.consents.accepted') : t('privacy.consents.revoked')
              )
            )
          ),
          Effect.catch((error) =>
            Effect.logError('Error updating consent:', error.cause ?? error).pipe(
              Effect.andThen(Effect.sync(() => toast.error(t('privacy.consents.error'))))
            )
          )
        )
      )
    },
    [profile?._id, recordConsent, t]
  )

  // ===== EXPORTAR DATOS =====
  const handleExportData = useCallback(() => {
    const profileId = profile?._id
    if (!profileId) return

    setIsExporting(true)
    void runClientEffect(
      exportUserDataProgram(() => convex.query(api.gdpr.exportUserData, { profileId })).pipe(
        Effect.flatMap((data) =>
          data
            ? downloadJsonProgram(exportFileName(new Date()), data).pipe(
                Effect.tap(() => Effect.sync(() => toast.success(t('privacy.export.success'))))
              )
            : Effect.sync(() => toast.error(t('privacy.export.empty')))
        ),
        Effect.catch((error) =>
          Effect.logError('Error exporting data:', error.cause ?? error).pipe(
            Effect.andThen(Effect.sync(() => toast.error(t('privacy.export.error'))))
          )
        ),
        // `ensuring` es el `finally`: el botón se destraba tanto si la descarga
        // salió como si el programa murió por un defecto.
        Effect.ensuring(Effect.sync(() => setIsExporting(false)))
      )
    )
  }, [profile?._id, convex, t])

  // ===== SOLICITAR ELIMINACIÓN =====
  const handleRequestDeletion = useCallback(() => {
    const profileId = profile?._id
    if (!profileId || pendingDeletion) return

    setIsDeleting(true)
    void runClientEffect(
      requestDeletionProgram(() =>
        requestDeletion({ profileId, reason: deletionReason || undefined })
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            toast.success(t('privacy.deletion.success'))
            router.push('/settings')
          })
        ),
        Effect.catch((error) =>
          Effect.logError('Error requesting deletion:', error.cause ?? error).pipe(
            Effect.andThen(Effect.sync(() => toast.error(t('privacy.deletion.error'))))
          )
        ),
        Effect.ensuring(Effect.sync(() => setIsDeleting(false)))
      )
    )
  }, [profile?._id, pendingDeletion, requestDeletion, deletionReason, router, t])

  if (userLoading) {
    return <PrivacySettingsSkeleton />
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <p className="text-muted-foreground">{t('privacy.signInRequired')}</p>
      </div>
    )
  }

  const requestedAtLabel = pendingDeletion
    ? new Intl.DateTimeFormat('es-PA', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: PANAMA_TIME_ZONE,
      }).format(new Date(pendingDeletion.requestedAt))
    : ''

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <header>
        <Link
          href="/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('privacy.back')}
        </Link>
        <h1 className="mt-3">{t('privacy.title')}</h1>
        <p className="text-muted-foreground mt-1 text-base">{t('privacy.subtitle')}</p>
      </header>

      {/* Filas con hairline, sin tarjetas ni tarjetas dentro de tarjetas
          (docs/design-system.md, «Screens and canvas»). El copy legal es de Maintainer. */}
      <div>
        <section aria-labelledby="privacy-rights" className="mt-8">
          <h2 id="privacy-rights" className="font-sans text-base leading-tight font-semibold">
            {t('privacy.rights.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('privacy.rights.description')}</p>
          <dl className="divide-border-hairline border-border-hairline mt-3 divide-y border-y">
            {[
              ['accessTitle', 'accessDescription'],
              ['portabilityTitle', 'portabilityDescription'],
              ['rectificationTitle', 'rectificationDescription'],
              ['erasureTitle', 'erasureDescription'],
            ].map(([title, description]) => (
              <div key={title} className="grid gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[14rem_1fr]">
                <dt className="text-sm font-medium">{t(`privacy.rights.${title}`)}</dt>
                <dd className="text-muted-foreground text-sm">
                  {t(`privacy.rights.${description}`)}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="privacy-consents" className="mt-8">
          <h2 id="privacy-consents" className="font-sans text-base leading-tight font-semibold">
            {t('privacy.consents.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('privacy.consents.description')}</p>
          <div
            className="divide-border-hairline border-border-hairline mt-3 divide-y border-y"
            aria-busy={consentsLoading}
          >
            {CONSENT_ITEMS.map(({ type, titleKey, descriptionKey, icon, required }) => {
              const title = t(titleKey)
              const description = t(descriptionKey)
              // El interruptor no tiene texto propio: su rotulo es el titulo de
              // la tarjeta y su detalle la descripcion. Sin estos ids el arbol
              // accesible lo expone como un `switch` sin nombre, que es lo que
              // vio la auditoria del 2026-09-10.
              const titleId = consentTitleId(type)
              const descriptionId = consentDescriptionId(type)
              return (
                <div key={type} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="flex items-start gap-3">
                    <div className="text-muted-foreground mt-0.5">{icon}</div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p id={titleId} className="font-medium">
                          {title}
                        </p>
                        {required && (
                          <Badge variant="secondary" className="text-xs">
                            {t('privacy.consents.required')}
                          </Badge>
                        )}
                      </div>
                      <p id={descriptionId} className="text-muted-foreground text-sm">
                        {description}
                      </p>
                    </div>
                  </div>
                  <Switch
                    id={consentSwitchId(type)}
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    checked={getConsentStatus(type) ?? false}
                    onCheckedChange={(checked) => handleConsentChange(type, checked)}
                    disabled={required || consentsLoading}
                  />
                </div>
              )
            })}
          </div>
        </section>

        <section aria-labelledby="privacy-export" className="mt-8">
          <h2 id="privacy-export" className="font-sans text-base leading-tight font-semibold">
            {t('privacy.export.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('privacy.export.description')}</p>
          <div className="divide-border-hairline border-border-hairline mt-3 divide-y border-y">
            <div className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <p className="font-medium">{t('privacy.export.itemTitle')}</p>
                <p className="text-muted-foreground text-sm">
                  {t('privacy.export.itemDescription')}
                </p>
              </div>
              <Button onClick={handleExportData} disabled={isExporting}>
                {isExporting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('privacy.export.loading')}
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    {t('privacy.export.button')}
                  </>
                )}
              </Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="privacy-deletion" className="mt-8">
          <h2 id="privacy-deletion" className="font-sans text-base leading-tight font-semibold">
            {t('privacy.deletion.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('privacy.deletion.description')}</p>
          <div className="mt-3 space-y-4">
            <div className="border-border-hairline border-t pt-3">
              <div className="flex items-start gap-3">
                <div>
                  <p className="text-destructive font-medium">
                    {t('privacy.deletion.warningTitle')}
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {t('privacy.deletion.warningIntro')}
                  </p>
                  <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-4 text-sm">
                    <li>{t('privacy.deletion.itemProfile')}</li>
                    <li>{t('privacy.deletion.itemDeals')}</li>
                    <li>{t('privacy.deletion.itemDocuments')}</li>
                    <li>{t('privacy.deletion.itemMessages')}</li>
                    <li>{t('privacy.deletion.itemActivity')}</li>
                  </ul>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {t('privacy.deletion.legalRetention')}
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {t('privacy.deletion.timeline')}
                  </p>
                </div>
              </div>
            </div>

            {pendingDeletion ? (
              <div className="border-border-hairline border-t pt-3">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{t('privacy.deletion.pendingTitle')}</p>
                  <Badge variant="secondary" className="text-xs">
                    {t('privacy.deletion.pendingBadge')}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-2 text-sm">
                  {t('privacy.deletion.pendingDescription', { date: requestedAtLabel })}
                </p>
                {pendingDeletion.reason && (
                  <p className="text-muted-foreground mt-2 text-sm">
                    {t('privacy.deletion.pendingReason', { reason: pendingDeletion.reason })}
                  </p>
                )}
                <p className="text-muted-foreground mt-2 text-sm">
                  {t('privacy.deletion.pendingContact')}
                </p>
              </div>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  {/* La misma regla que los interruptores: mientras la consulta
                      no resuelva no se sabe si ya hay una solicitud viva, y
                      abrir el diálogo ahí crea una segunda. */}
                  <Button variant="destructive" disabled={pendingDeletion === undefined}>
                    {t('privacy.deletion.trigger')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('privacy.deletion.confirmTitle')}</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div>
                        <p>{t('privacy.deletion.confirmDescription')}</p>
                        <div className="mt-4 space-y-2">
                          <p
                            id={deletionReasonLabelId}
                            className="text-foreground text-sm font-medium"
                          >
                            {t('privacy.deletion.reasonLabel')}
                          </p>
                          <Textarea
                            id={deletionReasonId}
                            aria-labelledby={deletionReasonLabelId}
                            placeholder={t('deleteConfirmReasonPlaceholder')}
                            value={deletionReason}
                            onChange={(e) => setDeletionReason(e.target.value)}
                            rows={3}
                          />
                        </div>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('privacy.deletion.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={handleRequestDeletion}
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('privacy.deletion.processing')}
                        </>
                      ) : (
                        t('privacy.deletion.confirm')
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </section>

        <section aria-labelledby="privacy-retention" className="mt-8">
          <h2 id="privacy-retention" className="font-sans text-base leading-tight font-semibold">
            {t('privacy.retention.title')}
          </h2>
          <div className="prose prose-sm dark:prose-invert mt-2 max-w-none">
            <p className="text-muted-foreground">{t('privacy.retention.intro')}</p>
            <ul className="text-muted-foreground">
              <li>{t('privacy.retention.itemTransactions')}</li>
              <li>{t('privacy.retention.itemAnonymized')}</li>
              <li>{t('privacy.retention.itemCompliance')}</li>
            </ul>
            <p className="text-muted-foreground">
              {t('privacy.retention.moreInfo')}{' '}
              <Link href="/privacy" className="text-primary underline">
                {t('privacy.retention.policyLink')}
              </Link>
              .
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
