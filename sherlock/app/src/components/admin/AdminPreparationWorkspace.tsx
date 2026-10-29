'use client'

// ============================================================================
// TALLER DE PREPARACIÓN DEL EQUIPO
// ============================================================================
// ===== DOS FUENTES DE VERDAD QUE COINCIDÍAN POR CASUALIDAD =====
// `AssessmentCategory` era una unión escrita a mano de doce literales, y
// `CATEGORIES` era un arreglo con esos mismos doce escritos otra vez. La unión
// alimenta el tipo de lo que se manda a Convex; el arreglo llena el `<Select>`.
// Agregar una categoría a la unión y olvidarla en el arreglo daba un tipo
// correcto y un formulario que no la ofrece — sin un solo error de compilación.
// Lo mismo pasaba con los formatos de rendición y con la lista de estados.
// Ahora cada catálogo es UN `Schema.Literals`: la lista es el valor, el tipo se
// deriva de ella, y no hay dónde divergir.
//
// Los cinco handlers son programas con nombre. El de entrega ya rescataba el
// mensaje de negocio del backend; los otros cuatro decían «no se pudo».
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { Effect, Schema } from 'effect'
import { useTranslations } from 'next-intl'

import type { Id } from '@/../convex/_generated/dataModel'
import { api } from '@/../convex/_generated/api'
import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RoomZipExportButton } from '@/components/documents/shell/RoomZipExportButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VDR_SHELL_FOLDERS } from '@/lib/vdr/document-taxonomy'
import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'

const DeliverableKindSchema = Schema.Literals([
  'MODEL',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DEBT_DECK',
  'EQUITY_DECK',
  'QA',
  'IRL',
])
const DELIVERABLE_KINDS = DeliverableKindSchema.literals
type DeliverableKind = typeof DeliverableKindSchema.Type

const DeliverableStatusSchema = Schema.Literals([
  'REQUESTED',
  'IN_PROGRESS',
  'NEEDS_INPUT',
  'DRAFT_READY',
  'IN_REVIEW',
  'APPROVED',
  'DELIVERED',
])
type DeliverableStatus = typeof DeliverableStatusSchema.Type

const RenditionFormatSchema = Schema.Literals(['HTML', 'PPTX', 'PDF', 'XLSX'])
type RenditionFormat = typeof RenditionFormatSchema.Type

const ReviewStateSchema = Schema.Literals(['PENDING', 'CONFIRMED', 'REJECTED'])
type ReviewState = typeof ReviewStateSchema.Type

const AssessmentStatusSchema = Schema.Literals(['PENDING', 'NEEDS_REVIEW', 'READY'])
type AssessmentStatus = typeof AssessmentStatusSchema.Type

const AssessmentCategorySchema = Schema.Literals([
  'financialStatements',
  'notes',
  'businessExplanation',
  'language',
  'businessModel',
  'pitch',
  'teaserCim',
  'loanPaymentTape',
  'financialModel',
  'portfolioDetail',
  'legalDetail',
  'country',
])
type AssessmentCategory = typeof AssessmentCategorySchema.Type

type DeliveryResult = 'DELIVERED' | 'ALREADY_DELIVERED'

type Translator = (key: string, values?: Record<string, string | number>) => string

type Deliverable = {
  deliverableId: Id<'deliverables'>
  kind: DeliverableKind
  status: DeliverableStatus
  renditions?: readonly { format: RenditionFormat; documentId: Id<'documents'> }[]
  updatedAt: number
}

type CompanyDocument = {
  _id: Id<'documents'>
  name: string
  fileType?: string | null
  currentVersionId?: Id<'documentVersions'> | null
  currentVersionNumber?: number | null
}

type IntakeDocument = {
  id: string
  displayName: string
  declaredMimeType: string
  byteSize: number
  inspectionStatus: 'CLEAN' | 'NOT_CONFIGURED' | 'UNINSPECTED' | 'SUSPICIOUS'
  claimable: boolean
  createdAt: number
}

type IntakeFinding = {
  category: AssessmentCategory
  evidenceDocumentIds: string[]
  confidence: number
  reviewState: ReviewState
}

type IntakeAssessment = {
  id: string
  intakeSessionId: string
  status: AssessmentStatus
  source: 'TEAM' | 'EXTERNAL'
  findings: IntakeFinding[]
  createdAt: number
  updatedAt: number
}

type AdminIntakeWorkspace = {
  intakeSessionId: string
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CLAIMED'
  claimedCompanyId: Id<'companies'> | null
  identityName: string | null
  documents: IntakeDocument[]
  assessment: IntakeAssessment | null
}

type FindingDraft = {
  category: AssessmentCategory
  evidenceDocumentIds: string[]
  confidence: string
  reviewState: ReviewState
}

export type AdminPreparationWorkspaceProps = {
  companyId?: Id<'companies'>
  intakeSessionId?: string
  isDemo?: boolean
}

type RecordIntakeAssessmentArgs = {
  intakeSessionId: Id<'intakeSessions'>
  source: 'TEAM' | 'EXTERNAL'
  findings: {
    category: AssessmentCategory
    evidenceDocumentIds: Id<'intakeDocuments'>[]
    confidence: number
    reviewState: ReviewState
  }[]
}

type RecordIntakeAssessmentResult = { status: AssessmentStatus }
type AdminIntakeWorkspaceArgs = {
  intakeSessionId: Id<'intakeSessions'>
  companyId?: Id<'companies'>
}

const recordIntakeAssessmentRef = makeFunctionReference<
  'mutation',
  RecordIntakeAssessmentArgs,
  RecordIntakeAssessmentResult
>('intake:recordIntakeAssessment')

const getAdminIntakeWorkspaceRef = makeFunctionReference<
  'mutation',
  AdminIntakeWorkspaceArgs,
  AdminIntakeWorkspace
>('intake:getAdminIntakeWorkspace')

const STATUS_TRANSITIONS: Record<DeliverableStatus, readonly DeliverableStatus[]> = {
  REQUESTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['NEEDS_INPUT', 'DRAFT_READY'],
  NEEDS_INPUT: ['IN_PROGRESS'],
  DRAFT_READY: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'IN_PROGRESS'],
  APPROVED: ['DELIVERED', 'IN_REVIEW'],
  DELIVERED: ['IN_PROGRESS'],
}

// La lista ES el catálogo, no una copia suya.
const FORMATS = RenditionFormatSchema.literals
const CATEGORIES = AssessmentCategorySchema.literals
const REVIEW_STATES = ReviewStateSchema.literals

// Los `<select>` devuelven `string`; acá se vuelven miembros del catálogo.
const decodeRenditionFormat = Schema.decodeUnknownOption(RenditionFormatSchema)
const decodeAssessmentCategory = Schema.decodeUnknownOption(AssessmentCategorySchema)
const decodeReviewState = Schema.decodeUnknownOption(ReviewStateSchema)

// Estos dos no vienen de un `<select>` sino de Convex a través de una firma
// declarada a mano en este archivo (`makeFunctionReference`, y un `as` sobre la
// lista de entregables). Nadie comprueba que la firma siga siendo cierta, así
// que el estado se decodifica antes de usarlo como llave: un estado que el
// backend agregue deja la fila sin transiciones en vez de reventar el
// `transitions.map`.
const decodeDeliverableStatus = Schema.decodeUnknownOption(DeliverableStatusSchema)
const decodeAssessmentStatus = Schema.decodeUnknownOption(AssessmentStatusSchema)

function initialFinding(): FindingDraft {
  return {
    category: 'financialStatements',
    evidenceDocumentIds: [],
    confidence: '1',
    reviewState: 'PENDING',
  }
}

function documentNameById(documents: readonly IntakeDocument[], id: string): string | null {
  return documents.find((document) => document.id === id)?.displayName ?? null
}

/**
 * Cargar el taller de intake es una lectura por mutation (queda auditada), así
 * que también es un paso con nombre.
 */
const loadIntakeWorkspace = Effect.fn('AdminPreparation.loadIntakeWorkspace')(function* (
  run: (args: AdminIntakeWorkspaceArgs) => Promise<AdminIntakeWorkspace>,
  args: AdminIntakeWorkspaceArgs,
  fallback: string
): Effect.fn.Return<AdminIntakeWorkspace, AdminActionError> {
  return yield* adminStep(
    'AdminPreparation.loadIntakeWorkspace',
    'intake.getAdminIntakeWorkspace',
    fallback,
    () => run(args)
  )
})

export function AdminPreparationWorkspace({
  companyId,
  intakeSessionId,
  isDemo = false,
}: AdminPreparationWorkspaceProps) {
  const t = useTranslations('adminPreparation') as unknown as Translator
  const locale = 'es' as const
  const [exportFolder, setExportFolder] = useState(VDR_SHELL_FOLDERS[0].value)
  const hasCompany = companyId !== undefined
  const hasIntake = intakeSessionId !== undefined
  const companyQueriesEnabled = hasCompany && !isDemo
  const intakeLoadEnabled = hasIntake && !isDemo
  const intakeUnavailableMessage = t('assessment.unavailable')
  const deliverables = useQuery(
    api.deliverables.listForCompany,
    companyQueriesEnabled ? { companyId } : 'skip'
  ) as readonly Deliverable[] | undefined
  const documents = useQuery(
    api.documents.getByCompany,
    companyQueriesEnabled ? { companyId } : 'skip'
  ) as readonly CompanyDocument[] | undefined
  const requestDeliverable = useMutation(api.deliverables.request)
  const transitionDeliverable = useMutation(api.deliverables.transition)
  const attachRendition = useMutation(api.deliverables.attachRendition)
  const markDocumentAsDelivery = useMutation(api.deliverables.markDocumentAsDelivery)
  const loadAdminIntakeWorkspace = useMutation(getAdminIntakeWorkspaceRef)
  const recordAssessment = useMutation(recordIntakeAssessmentRef)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [deliveryResult, setDeliveryResult] = useState<Record<string, DeliveryResult>>({})
  const [error, setError] = useState<string | null>(null)
  const [assessmentError, setAssessmentError] = useState<string | null>(null)
  const [assessmentStatus, setAssessmentStatus] = useState<AssessmentStatus | null>(null)
  const [findings, setFindings] = useState<FindingDraft[]>([initialFinding()])
  // Lo cargado se guarda JUNTO A LA SESIÓN a la que pertenece. Antes el efecto
  // limpiaba el estado con dos `setState` síncronos antes de pedir la carga
  // nueva: dos renders extra por cada cambio de sesión, y una ventana en la que
  // el panel pintaba el taller viejo. Comparar la llave durante el render dice
  // lo mismo sin pasar por React dos veces.
  const [intakeLoad, setIntakeLoad] = useState<{
    key: string | null
    workspace?: AdminIntakeWorkspace
    error: string | null
  }>({ key: null, error: null })
  const [intakeReloadNonce, setIntakeReloadNonce] = useState(0)

  const intakeKey =
    intakeLoadEnabled && intakeSessionId !== undefined
      ? `${intakeSessionId}:${companyId ?? ''}:${intakeReloadNonce}`
      : null
  const intakeWorkspace = intakeLoad.key === intakeKey ? intakeLoad.workspace : undefined
  const intakeError = intakeLoad.key === intakeKey ? intakeLoad.error : null

  useEffect(() => {
    if (intakeKey === null || intakeSessionId === undefined) return

    // `runFork` y no `runPromise`: la fibra se interrumpe al desmontar o al
    // cambiar de sesión, y un Exit interrumpido no pinta estado. El `cancelled`
    // que había acá hacía lo mismo a mano, pero dejaba la petición corriendo.
    const fiber = runClientFork(
      loadIntakeWorkspace(
        loadAdminIntakeWorkspace,
        {
          intakeSessionId: intakeSessionId as Id<'intakeSessions'>,
          ...(companyId !== undefined ? { companyId } : {}),
        },
        intakeUnavailableMessage
      ).pipe(
        Effect.tap((workspace) =>
          Effect.sync(() => setIntakeLoad({ key: intakeKey, workspace, error: null }))
        ),
        Effect.catch((error) =>
          Effect.sync(() => setIntakeLoad({ key: intakeKey, error: error.message }))
        )
      )
    )

    return () => {
      fiber.interruptUnsafe()
    }
  }, [companyId, intakeKey, intakeSessionId, intakeUnavailableMessage, loadAdminIntakeWorkspace])

  if (companyQueriesEnabled && deliverables === undefined) {
    return (
      <section aria-busy="true" aria-label={t('loading')} className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      </section>
    )
  }

  const byKind = new Map((deliverables ?? []).map((deliverable) => [deliverable.kind, deliverable]))

  /** Corre una escritura del taller en el borde y deja el aviso en `setError`. */
  function runWrite(busyKey: string, program: Effect.Effect<void, AdminActionError>) {
    setBusyKey(busyKey)
    setError(null)
    void runClientEffect(
      program.pipe(
        Effect.catch((failure) =>
          Effect.logError(
            `[AdminPreparationWorkspace] ${failure.action} falló en ${failure.step}`
          ).pipe(Effect.andThen(Effect.sync(() => setError(failure.message))))
        ),
        Effect.ensuring(Effect.sync(() => setBusyKey(null)))
      )
    )
  }

  function handleRequest(kind: DeliverableKind) {
    if (!companyId) return
    runWrite(
      `request:${kind}`,
      adminStep('AdminPreparation.request', 'deliverables.request', t('errors.request'), () =>
        requestDeliverable({ companyId, kind })
      ).pipe(Effect.asVoid)
    )
  }

  function handleTransition(deliverableId: Id<'deliverables'>, to: DeliverableStatus) {
    runWrite(
      `transition:${deliverableId}:${to}`,
      adminStep(
        'AdminPreparation.transition',
        'deliverables.transition',
        t('errors.transition'),
        () => transitionDeliverable({ deliverableId, to })
      ).pipe(Effect.asVoid)
    )
  }

  function handleAttach(
    deliverableId: Id<'deliverables'>,
    format: RenditionFormat,
    documentId: Id<'documents'>,
    inputManifest: Id<'documentVersions'>[]
  ) {
    runWrite(
      `attach:${deliverableId}`,
      adminStep(
        'AdminPreparation.attachRendition',
        'deliverables.attachRendition',
        t('errors.attach'),
        () => attachRendition({ deliverableId, format, documentId, inputManifest })
      ).pipe(Effect.asVoid)
    )
  }

  // El camino manual del equipo (zip de la sala, Mycroft, «Subir documento»)
  // termina acá: sin esto el documento entra como uno más y el cliente no se
  // entera de que le entregaron algo.
  function handleMarkDelivery(kind: DeliverableKind, documentId: Id<'documents'>, note: string) {
    runWrite(
      `delivery:${kind}`,
      adminStep(
        'AdminPreparation.markDelivery',
        'deliverables.markDocumentAsDelivery',
        t('errors.delivery'),
        () => markDocumentAsDelivery({ kind, documentId, note })
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            setDeliveryResult((current) => ({
              ...current,
              [kind]: result.delivered ? 'DELIVERED' : 'ALREADY_DELIVERED',
            }))
          )
        ),
        Effect.asVoid
      )
    )
  }

  function handleAssessmentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!intakeSessionId) return

    setAssessmentError(null)
    setAssessmentStatus(null)

    // La validación es del formulario, no del backend: se corta antes de
    // gastar una mutation auditada.
    if (findings.some((finding) => finding.evidenceDocumentIds.length === 0)) {
      setAssessmentError(t('assessment.evidenceRequired'))
      return
    }

    setBusyKey('assessment')
    setError(null)
    void runClientEffect(
      adminStep(
        'AdminPreparation.recordAssessment',
        'intake.recordIntakeAssessment',
        t('errors.assessment'),
        () =>
          recordAssessment({
            intakeSessionId: intakeSessionId as Id<'intakeSessions'>,
            source: 'TEAM',
            findings: findings.map((finding) => ({
              category: finding.category,
              evidenceDocumentIds: finding.evidenceDocumentIds as Id<'intakeDocuments'>[],
              confidence: Number(finding.confidence),
              reviewState: finding.reviewState,
            })),
          })
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const status = decodeAssessmentStatus(result.status)
            setAssessmentStatus(status._tag === 'Some' ? status.value : null)
            setIntakeReloadNonce((current) => current + 1)
          })
        ),
        Effect.catch((failure) =>
          Effect.logError(
            `[AdminPreparationWorkspace] ${failure.action} falló en ${failure.step}`
          ).pipe(Effect.andThen(Effect.sync(() => setAssessmentError(failure.message))))
        ),
        Effect.ensuring(Effect.sync(() => setBusyKey(null)))
      )
    )
  }

  return (
    <section
      id={hasIntake ? 'admin-intake-assessment' : undefined}
      aria-labelledby="admin-preparation-heading"
      className="space-y-5"
    >
      {hasCompany ? (
        <Card>
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <p className="text-primary text-xs font-semibold tracking-widest uppercase">
                  {t('eyebrow')}
                </p>
                <h2 id="admin-preparation-heading" className="text-xl font-semibold">
                  {t('title')}
                </h2>
                <p className="text-muted-foreground max-w-3xl text-sm">{t('description')}</p>
              </div>
              {hasCompany && !isDemo ? (
                <div className="flex flex-wrap items-center gap-2">
                  <RoomZipExportButton
                    companyId={companyId}
                    locale={locale}
                    label={t('downloadZip')}
                    pendingLabel={t('downloadZipPending')}
                    successLabel={t('downloadZipStarted')}
                    errorLabel={t('downloadZipError')}
                    tooLargeLabel={t('downloadZipTooLarge')}
                    emptyLabel={t('downloadZipEmpty')}
                    testId="admin-zip-export"
                    size="sm"
                  />
                  {/* El equipo baja una sola carpeta sin arrastrar la sala
                      entera: el select dice cuál antes de pedirla. */}
                  <Select value={exportFolder} onValueChange={setExportFolder}>
                    <SelectTrigger className="h-8 w-52" aria-label={t('downloadFolderLabel')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VDR_SHELL_FOLDERS.map((folder) => (
                        <SelectItem key={folder.value} value={folder.value}>
                          {folder.label[locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <RoomZipExportButton
                    companyId={companyId}
                    folder={exportFolder}
                    locale={locale}
                    label={t('downloadFolderZip')}
                    pendingLabel={t('downloadZipPending')}
                    successLabel={t('downloadZipStarted')}
                    errorLabel={t('downloadZipError')}
                    tooLargeLabel={t('downloadZipTooLarge')}
                    emptyLabel={t('downloadFolderZipEmpty')}
                    testId="admin-folder-zip-export"
                    size="sm"
                  />
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {DELIVERABLE_KINDS.map((kind) => {
              const deliverable = byKind.get(kind)
              const deliverableStatus = deliverable
                ? decodeDeliverableStatus(deliverable.status)
                : undefined
              const transitions =
                deliverableStatus?._tag === 'Some'
                  ? STATUS_TRANSITIONS[deliverableStatus.value]
                  : []
              return (
                <article
                  key={kind}
                  data-testid={`admin-deliverable-${kind}`}
                  className="border-border space-y-3 rounded-md border p-4"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="font-medium">{t(`deliverables.${kind}`)}</h3>
                      <p className="text-muted-foreground text-sm">
                        {t('statusLabel')}:{' '}
                        {deliverable ? (
                          <Badge variant="outline">{t(`status.${deliverable.status}`)}</Badge>
                        ) : (
                          t('notStarted')
                        )}
                      </p>
                    </div>
                    {!deliverable ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busyKey !== null}
                        onClick={() => handleRequest(kind)}
                      >
                        {busyKey === `request:${kind}` ? t('pending') : t('request')}
                      </Button>
                    ) : null}
                  </div>

                  {deliverable ? (
                    <div className="flex flex-wrap gap-2">
                      {transitions.map((to) => (
                        <Button
                          key={to}
                          type="button"
                          size="sm"
                          variant={to === 'APPROVED' || to === 'DELIVERED' ? 'default' : 'outline'}
                          disabled={busyKey !== null}
                          onClick={() => handleTransition(deliverable.deliverableId, to)}
                        >
                          {busyKey === `transition:${deliverable.deliverableId}:${to}`
                            ? t('pending')
                            : t(`transition.${to}`)}
                        </Button>
                      ))}
                    </div>
                  ) : null}

                  {deliverable ? (
                    <RenditionControls
                      t={t}
                      documents={documents ?? []}
                      deliverable={deliverable}
                      busy={busyKey === `attach:${deliverable.deliverableId}`}
                      onAttach={handleAttach}
                    />
                  ) : null}

                  {/* Se ofrece exista o no el slot: la mutation lo crea si
                      falta, así que entregar no exige solicitarlo antes. */}
                  <MarkDeliveryControls
                    t={t}
                    kind={kind}
                    documents={documents ?? []}
                    busy={busyKey === `delivery:${kind}`}
                    result={deliveryResult[kind] ?? null}
                    onMark={handleMarkDelivery}
                  />
                </article>
              )
            })}
          </CardContent>
        </Card>
      ) : null}

      {hasIntake ? (
        <Card data-testid="admin-intake-assessment">
          <CardHeader className="space-y-2">
            <h2
              id={hasCompany ? undefined : 'admin-preparation-heading'}
              className="text-xl font-semibold"
            >
              {t('assessment.title')}
            </h2>
            <p className="text-muted-foreground text-sm">{t('assessment.description')}</p>
          </CardHeader>
          <CardContent className="space-y-5">
            {intakeWorkspace === undefined && intakeLoadEnabled && !intakeError ? (
              <p className="text-muted-foreground text-sm">{t('loading')}</p>
            ) : intakeError ? (
              <p className="text-destructive text-sm" role="alert">
                {intakeError}
              </p>
            ) : intakeWorkspace ? (
              <>
                <div className="border-border rounded-md border p-4">
                  <h3 className="font-medium">{t('assessment.documentsTitle')}</h3>
                  {intakeWorkspace.documents.length === 0 ? (
                    <p className="text-muted-foreground mt-2 text-sm">
                      {t('assessment.noDocuments')}
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {intakeWorkspace.documents.map((document) => (
                        <li key={document.id}>{document.displayName}</li>
                      ))}
                    </ul>
                  )}
                </div>

                {intakeWorkspace.assessment ? (
                  <AssessmentReadback
                    t={t}
                    assessment={intakeWorkspace.assessment}
                    documents={intakeWorkspace.documents}
                  />
                ) : null}

                <form className="space-y-4" onSubmit={handleAssessmentSubmit}>
                  {findings.map((finding, index) => (
                    <div
                      key={index}
                      className="border-border grid gap-3 rounded-md border p-4 sm:grid-cols-2"
                    >
                      <div className="space-y-2">
                        <Label htmlFor={`assessment-category-${index}`}>
                          {t('assessment.category')}
                        </Label>
                        <select
                          id={`assessment-category-${index}`}
                          className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                          value={finding.category}
                          onChange={(event) => {
                            const next = decodeAssessmentCategory(event.target.value)
                            if (next._tag === 'None') return
                            setFindings((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, category: next.value } : item
                              )
                            )
                          }}
                        >
                          {CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {t(`categories.${category}`)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`assessment-confidence-${index}`}>
                          {t('assessment.confidence')}
                        </Label>
                        <Input
                          id={`assessment-confidence-${index}`}
                          type="number"
                          min="0"
                          max="1"
                          step="0.01"
                          value={finding.confidence}
                          onChange={(event) =>
                            setFindings((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, confidence: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      </div>
                      <fieldset className="space-y-2 sm:col-span-2">
                        <legend className="text-sm leading-none font-medium">
                          {t('assessment.evidence')}
                        </legend>
                        {intakeWorkspace.documents.length === 0 ? (
                          <p className="text-muted-foreground text-xs">
                            {t('assessment.noDocuments')}
                          </p>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {intakeWorkspace.documents.map((document) => (
                              <label key={document.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  value={document.id}
                                  checked={finding.evidenceDocumentIds.includes(document.id)}
                                  onChange={(event) =>
                                    setFindings((current) =>
                                      current.map((item, itemIndex) => {
                                        if (itemIndex !== index) return item
                                        const next = event.target.checked
                                          ? [...item.evidenceDocumentIds, document.id]
                                          : item.evidenceDocumentIds.filter(
                                              (id) => id !== document.id
                                            )
                                        return { ...item, evidenceDocumentIds: next }
                                      })
                                    )
                                  }
                                />
                                {document.displayName}
                              </label>
                            ))}
                          </div>
                        )}
                      </fieldset>
                      <div className="space-y-2">
                        <Label htmlFor={`assessment-review-${index}`}>
                          {t('assessment.reviewState')}
                        </Label>
                        <select
                          id={`assessment-review-${index}`}
                          className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
                          value={finding.reviewState}
                          onChange={(event) => {
                            // El `value` de un `<select>` es `string`: se
                            // decodifica contra el catálogo en vez de castearlo.
                            const next = decodeReviewState(event.target.value)
                            if (next._tag === 'None') return
                            setFindings((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, reviewState: next.value } : item
                              )
                            )
                          }}
                        >
                          {REVIEW_STATES.map((state) => (
                            <option key={state} value={state}>
                              {t(`review.${state}`)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" disabled={busyKey !== null}>
                      {busyKey === 'assessment' ? t('pending') : t('assessment.save')}
                    </Button>
                    {assessmentStatus ? (
                      <p className="text-muted-foreground text-sm" role="status">
                        {t('assessment.saved')}: {t(`assessment.status.${assessmentStatus}`)}
                      </p>
                    ) : null}
                    {assessmentError ? (
                      <p className="text-destructive text-sm" role="alert">
                        {assessmentError}
                      </p>
                    ) : null}
                  </div>
                </form>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t('assessment.unavailable')}</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function AssessmentReadback({
  t,
  assessment,
  documents,
}: {
  t: Translator
  assessment: IntakeAssessment
  documents: readonly IntakeDocument[]
}) {
  return (
    <div
      data-testid="admin-intake-assessment-readback"
      className="border-border rounded-md border p-4"
    >
      <h3 className="font-medium">{t('assessment.latestTitle')}</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('assessment.statusLabel')}: {t(`assessment.status.${assessment.status}`)}
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {assessment.findings.map((finding, index) => (
          <li key={`${finding.category}:${index}`} className="border-border border-t pt-2">
            <p>
              {t(`categories.${finding.category}`)} · {t(`review.${finding.reviewState}`)} ·{' '}
              {finding.confidence}
            </p>
            <p className="text-muted-foreground">
              {finding.evidenceDocumentIds
                .map((id) => documentNameById(documents, id))
                .filter((name): name is string => name !== null)
                .join(', ') || t('assessment.noEvidence')}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RenditionControls({
  t,
  documents,
  deliverable,
  busy,
  onAttach,
}: {
  t: Translator
  documents: readonly CompanyDocument[]
  deliverable: Deliverable
  busy: boolean
  onAttach: (
    deliverableId: Id<'deliverables'>,
    format: RenditionFormat,
    documentId: Id<'documents'>,
    inputManifest: Id<'documentVersions'>[]
  ) => void
}) {
  const [format, setFormat] = useState<RenditionFormat>('HTML')
  const [documentId, setDocumentId] = useState<string>(documents[0]?._id ?? '')
  const [sourceVersionIds, setSourceVersionIds] = useState<string[]>([])
  const selectedDocumentId = documentId || documents[0]?._id || ''
  const versionedDocuments = documents.filter((document) => document.currentVersionId)

  return (
    <div className="border-border space-y-3 border-t pt-3">
      <p className="text-sm font-medium">{t('rendition.title')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`rendition-format-${deliverable.kind}`}>{t('rendition.format')}</Label>
          <select
            id={`rendition-format-${deliverable.kind}`}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            value={format}
            onChange={(event) => {
              const next = decodeRenditionFormat(event.target.value)
              if (next._tag === 'Some') setFormat(next.value)
            }}
          >
            {FORMATS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={`rendition-document-${deliverable.kind}`}>
            {t('rendition.document')}
          </Label>
          <select
            id={`rendition-document-${deliverable.kind}`}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            value={selectedDocumentId}
            onChange={(event) => setDocumentId(event.target.value)}
          >
            <option value="">{t('rendition.chooseDocument')}</option>
            {documents.map((document) => (
              <option key={document._id} value={document._id}>
                {document.name}
                {document.fileType ? ` · ${document.fileType}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">{t('rendition.sources')}</legend>
        {versionedDocuments.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('rendition.noVersions')}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {versionedDocuments.map((document) => (
              <label key={document._id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  value={document.currentVersionId ?? ''}
                  checked={sourceVersionIds.includes(document.currentVersionId ?? '')}
                  onChange={(event) =>
                    setSourceVersionIds((current) =>
                      event.target.checked
                        ? [...current, document.currentVersionId as string]
                        : current.filter((id) => id !== document.currentVersionId)
                    )
                  }
                />
                {document.name} · v{document.currentVersionNumber ?? '?'}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !selectedDocumentId || sourceVersionIds.length === 0}
          onClick={() =>
            onAttach(
              deliverable.deliverableId,
              format,
              selectedDocumentId as Id<'documents'>,
              sourceVersionIds as Id<'documentVersions'>[]
            )
          }
        >
          {busy ? t('pending') : t('rendition.attach')}
        </Button>
        <p className="text-muted-foreground text-xs">
          {t('rendition.attached', { count: deliverable.renditions?.length ?? 0 })}
        </p>
      </div>
    </div>
  )
}

// ============================================================================
// MARCAR COMO ENTREGA
// ============================================================================
// El documento ya está en la sala; lo que falta es el acto que mueve el rail y
// avisa al cliente. Dos pasos a propósito: la confirmación existe porque la
// campanita y el correo salen de inmediato y no se pueden recoger.

function MarkDeliveryControls({
  t,
  kind,
  documents,
  busy,
  result,
  onMark,
}: {
  t: Translator
  kind: DeliverableKind
  documents: readonly CompanyDocument[]
  busy: boolean
  result: DeliveryResult | null
  onMark: (kind: DeliverableKind, documentId: Id<'documents'>, note: string) => void
}) {
  const [documentId, setDocumentId] = useState('')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const versionedDocuments = documents.filter((document) => document.currentVersionId)
  const ready = documentId !== '' && note.trim().length > 0

  return (
    <div className="border-border space-y-3 border-t pt-3">
      <p className="text-sm font-medium">{t('delivery.title')}</p>
      <p className="text-muted-foreground text-sm">{t('delivery.description')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`delivery-document-${kind}`}>{t('delivery.document')}</Label>
          <select
            id={`delivery-document-${kind}`}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            value={documentId}
            onChange={(event) => {
              setDocumentId(event.target.value)
              setConfirming(false)
            }}
          >
            <option value="">{t('delivery.chooseDocument')}</option>
            {versionedDocuments.map((document) => (
              <option key={document._id} value={document._id}>
                {document.name}
                {document.currentVersionNumber ? ` · v${document.currentVersionNumber}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`delivery-note-${kind}`}>{t('delivery.note')}</Label>
          <Input
            id={`delivery-note-${kind}`}
            value={note}
            maxLength={500}
            placeholder={t('delivery.notePlaceholder')}
            onChange={(event) => {
              setNote(event.target.value)
              setConfirming(false)
            }}
          />
        </div>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              onMark(kind, documentId as Id<'documents'>, note.trim())
            }}
          >
            {busy ? t('pending') : t('delivery.confirm')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t('delivery.cancel')}
          </Button>
          <p className="text-muted-foreground text-xs">{t('delivery.confirmHint')}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !ready}
            onClick={() => setConfirming(true)}
          >
            {busy ? t('pending') : t('delivery.submit')}
          </Button>
          {result ? (
            <p className="text-muted-foreground text-xs" role="status">
              {result === 'DELIVERED' ? t('delivery.delivered') : t('delivery.alreadyDelivered')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
