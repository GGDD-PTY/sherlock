import { v, type VLiteral } from 'convex/values'
import { Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'
import { requiresConfiguredScanner, type ScannerEnvironment } from '../_documents/scanner'
import { validationFailed } from '../_helpers/errors'

export const INTAKE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000
export const INTAKE_ABSOLUTE_ACCESS_TTL_MS = 48 * 60 * 60 * 1000
export const INTAKE_DELETION_PROOF_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const INTAKE_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000
export const INTAKE_UPLOAD_INSPECTION_GRACE_MS = 30 * 60 * 1000
export const INTAKE_MAX_ROTATIONS = 48
const INTAKE_MAX_NAME_LENGTH = 120
const INTAKE_MAX_FILE_NAME_LENGTH = 255
const INTAKE_MAX_ASSESSMENT_FINDINGS = 24
const INTAKE_MAX_ASSESSMENT_EVIDENCE_PER_FINDING = 20
const INTAKE_MAX_ASSESSMENT_EVIDENCE_REFERENCES =
  INTAKE_MAX_ASSESSMENT_FINDINGS * INTAKE_MAX_ASSESSMENT_EVIDENCE_PER_FINDING
export const INTAKE_MAX_ASSESSMENTS_PER_SESSION = 50

export const intakeSessionStatusValidator = v.union(
  v.literal('ACTIVE'),
  v.literal('EXPIRED'),
  v.literal('REVOKED'),
  v.literal('CLAIMED')
)

export const intakeClaimStatusValidator = v.union(
  v.literal('UNCLAIMED'),
  v.literal('ISSUED'),
  v.literal('PROCESSING'),
  v.literal('CLAIMED'),
  v.literal('FAILED')
)

export const intakeStorageStateValidator = v.union(
  v.literal('STAGED_INTAKE'),
  v.literal('CLAIM_PENDING'),
  v.literal('OWNED_BY_COMPANY'),
  v.literal('DELETE_PENDING'),
  v.literal('DELETED')
)

export const intakeInspectionStatusValidator = v.union(
  v.literal('CLEAN'),
  v.literal('NOT_CONFIGURED'),
  v.literal('UNINSPECTED'),
  v.literal('SUSPICIOUS')
)

export const intakeUploadIntentStatusValidator = v.union(
  v.literal('ISSUED'),
  v.literal('INSPECTING'),
  v.literal('CONSUMED'),
  v.literal('REJECTED'),
  v.literal('EXPIRED'),
  v.literal('UNCERTAIN')
)

export const intakeAssessmentStatusValidator = v.union(
  v.literal('PENDING'),
  v.literal('NEEDS_REVIEW'),
  v.literal('READY')
)

export const intakeAssessmentSourceValidator = v.union(v.literal('TEAM'), v.literal('EXTERNAL'))

export const intakeAssessmentReviewStateValidator = v.union(
  v.literal('PENDING'),
  v.literal('CONFIRMED'),
  v.literal('REJECTED')
)

/**
 * These are the only evidence categories Sherlock currently projects into the
 * preparation inventory. The category is deliberately separate from a file
 * name: a producer must make an explicit, evidence-backed observation.
 */
const INTAKE_ASSESSMENT_CATEGORIES = [
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
] as const

// El catálogo se escribe una sola vez. El `Schema.Literals` de abajo da el tipo
// de dominio (`IntakeAssessmentCategory`) y el validador que Convex verifica en
// la frontera sale del mismo objeto — mismo patrón que `convex/webhookEvents.ts`
// y el `literalValidator` de `convex/schema.ts`. Antes el catálogo estaba
// también escrito a mano como doce `v.literal(...)`, sin nada que obligara a
// que coincidiera con `INTAKE_ASSESSMENT_CATEGORIES`.
function literalValidator<const L extends readonly [string, string, ...Array<string>]>(
  schema: Schema.Literals<L>
) {
  const members: Array<VLiteral<L[number]>> = schema.literals.map((literal) => v.literal(literal))
  return v.union(...members)
}

const IntakeAssessmentCategorySchema = Schema.Literals(INTAKE_ASSESSMENT_CATEGORIES)
type IntakeAssessmentCategory = typeof IntakeAssessmentCategorySchema.Type

const intakeAssessmentCategoryValidator = literalValidator(IntakeAssessmentCategorySchema)

export const intakeAssessmentFindingValidator = v.object({
  category: intakeAssessmentCategoryValidator,
  evidenceDocumentIds: v.array(v.id('intakeDocuments')),
  confidence: v.number(),
  reviewState: intakeAssessmentReviewStateValidator,
})

export const intakeAssessmentStatusInputValidator = v.optional(intakeAssessmentStatusValidator)

export const intakeProofOperationValidator = v.union(
  v.literal('CREATE_SESSION'),
  v.literal('RESOLVE_SESSION'),
  v.literal('PROJECT_WORKSPACE'),
  v.literal('ROTATE_SESSION'),
  v.literal('REVOKE_SESSION'),
  v.literal('ISSUE_UPLOAD'),
  v.literal('REGISTER_UPLOAD'),
  v.literal('SUPPORT_READ'),
  v.literal('SUPPORT_SEND'),
  v.literal('DELETE_DATA')
)

export const intakeEventTypeValidator = v.union(
  v.literal('SESSION_CREATED'),
  v.literal('SESSION_ROTATED'),
  v.literal('SESSION_REVOKED'),
  v.literal('SESSION_EXPIRED'),
  v.literal('UPLOAD_INTENT_ISSUED'),
  v.literal('DOCUMENT_STAGED'),
  v.literal('DOCUMENT_QUARANTINED')
)

// Los validadores `v.*` de arriba son lo que lee el codegen de Convex y se
// quedan escritos a mano. Lo que sí tenía dos fuentes de verdad eran los tipos
// y los `Set` de validación: cada estado estaba escrito tres veces (validador,
// unión de TypeScript y conjunto en runtime) y nada obligaba a que coincidieran.
// Ahora el `Schema.Literals` da el tipo Y el guarda de runtime.
// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
export type IntakeInspectionStatus = 'CLEAN' | 'NOT_CONFIGURED' | 'UNINSPECTED' | 'SUSPICIOUS'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type IntakeStorageState =
  'STAGED_INTAKE' | 'CLAIM_PENDING' | 'OWNED_BY_COMPANY' | 'DELETE_PENDING' | 'DELETED'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type IntakeAssessmentSource = 'TEAM' | 'EXTERNAL'

const IntakeAssessmentReviewStateSchema = Schema.Literals(['PENDING', 'CONFIRMED', 'REJECTED'])
type IntakeAssessmentReviewState = typeof IntakeAssessmentReviewStateSchema.Type

const IntakeAssessmentStatusSchema = Schema.Literals(['PENDING', 'NEEDS_REVIEW', 'READY'])
export type IntakeAssessmentStatus = typeof IntakeAssessmentStatusSchema.Type

export type IntakeAssessmentFinding = {
  category: IntakeAssessmentCategory
  evidenceDocumentIds: string[]
  confidence: number
  reviewState: IntakeAssessmentReviewState
}

export type IntakeAssessmentProjection = {
  id: string
  intakeSessionId: string
  status: IntakeAssessmentStatus
  source: IntakeAssessmentSource
  findings: IntakeAssessmentFinding[]
  createdAt: number
  updatedAt: number
}

const isIntakeAssessmentCategory = Schema.is(IntakeAssessmentCategorySchema)
const isIntakeAssessmentReviewState = Schema.is(IntakeAssessmentReviewStateSchema)
const isIntakeAssessmentStatus = Schema.is(IntakeAssessmentStatusSchema)

type IntakeAssessmentFindingInput = {
  category: string
  evidenceDocumentIds: readonly string[]
  confidence: number
  reviewState: string
}

export function normalizeIntakeAssessmentFindings(
  findings: readonly IntakeAssessmentFindingInput[],
  source: IntakeAssessmentSource
): IntakeAssessmentFinding[] {
  if (!Array.isArray(findings)) {
    throw validationFailed('La lista de hallazgos no es válida.', 'findings')
  }
  if (findings.length > INTAKE_MAX_ASSESSMENT_FINDINGS) {
    throw validationFailed('La evaluación excede el límite de hallazgos.', 'findings')
  }

  let evidenceReferenceCount = 0
  return findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      throw validationFailed(`El hallazgo ${index + 1} no es válido.`, 'findings')
    }
    if (!isIntakeAssessmentCategory(finding.category)) {
      throw validationFailed(`La categoría del hallazgo ${index + 1} no es válida.`, 'category')
    }
    if (!Array.isArray(finding.evidenceDocumentIds)) {
      throw validationFailed(`La evidencia del hallazgo ${index + 1} no es válida.`, 'evidence')
    }
    if (finding.evidenceDocumentIds.length > INTAKE_MAX_ASSESSMENT_EVIDENCE_PER_FINDING) {
      throw validationFailed(
        `El hallazgo ${index + 1} excede el límite de documentos de evidencia.`,
        'evidenceDocumentIds'
      )
    }
    const evidenceDocumentIds = Array.from(new Set<string>(finding.evidenceDocumentIds))
    evidenceReferenceCount += evidenceDocumentIds.length
    if (evidenceReferenceCount > INTAKE_MAX_ASSESSMENT_EVIDENCE_REFERENCES) {
      throw validationFailed(
        'La evaluación excede el límite de referencias de evidencia.',
        'evidenceDocumentIds'
      )
    }
    if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      throw validationFailed(
        `La confianza del hallazgo ${index + 1} debe estar entre 0 y 1.`,
        'confidence'
      )
    }
    if (!isIntakeAssessmentReviewState(finding.reviewState)) {
      throw validationFailed(`El estado del hallazgo ${index + 1} no es válido.`, 'reviewState')
    }
    if (source === 'EXTERNAL' && finding.reviewState !== 'PENDING') {
      throw validationFailed(
        'La evaluación externa requiere revisión humana explícita.',
        'reviewState'
      )
    }

    // Los dos guardas de arriba ya estrecharon `category` y `reviewState`: el
    // casteo ciego que había aquí afirmaba lo que el `Set` no podía probar.
    return {
      category: finding.category,
      evidenceDocumentIds,
      confidence: finding.confidence,
      reviewState: finding.reviewState,
    }
  })
}

function deriveIntakeAssessmentStatus(
  source: IntakeAssessmentSource,
  findings: readonly IntakeAssessmentFinding[]
): IntakeAssessmentStatus {
  if (findings.length === 0) return 'PENDING'
  if (source === 'EXTERNAL') return 'NEEDS_REVIEW'
  return findings.some((finding) => finding.reviewState === 'PENDING') ? 'NEEDS_REVIEW' : 'READY'
}

export function normalizeIntakeAssessmentStatus(
  requestedStatus: string | undefined,
  source: IntakeAssessmentSource,
  findings: readonly IntakeAssessmentFinding[]
): IntakeAssessmentStatus {
  const derivedStatus = deriveIntakeAssessmentStatus(source, findings)
  if (requestedStatus === undefined) return derivedStatus
  if (!isIntakeAssessmentStatus(requestedStatus)) {
    throw validationFailed('El estado de la evaluación no es válido.', 'status')
  }
  if (requestedStatus !== derivedStatus) {
    throw validationFailed('El estado solicitado no coincide con la evaluación.', 'status')
  }
  return derivedStatus
}

export function projectIntakeAssessment(
  assessment: Doc<'intakeAssessments'>
): IntakeAssessmentProjection {
  return {
    id: `${assessment._id}`,
    intakeSessionId: `${assessment.intakeSessionId}`,
    status: assessment.status,
    source: assessment.source,
    findings: assessment.findings.map((finding) => ({
      category: finding.category as IntakeAssessmentCategory,
      evidenceDocumentIds: finding.evidenceDocumentIds.map((id) => `${id}`),
      confidence: finding.confidence,
      reviewState: finding.reviewState,
    })),
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  }
}

function normalizeBoundedText(value: string, maximum: number, field: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw validationFailed(`El campo ${field} no es válido.`, field)
  }
  return normalized
}

export function normalizeIntakeIdentityName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return normalizeBoundedText(value, INTAKE_MAX_NAME_LENGTH, 'identityName')
}

export function normalizeIntakeFileName(value: string): string {
  return normalizeBoundedText(value, INTAKE_MAX_FILE_NAME_LENGTH, 'fileName')
}

export function intakeInspectionAllowsClaim(
  inspectionStatus: IntakeInspectionStatus,
  environment: ScannerEnvironment = process.env
): boolean {
  return (
    inspectionStatus === 'CLEAN' ||
    (inspectionStatus === 'NOT_CONFIGURED' && !requiresConfiguredScanner(environment))
  )
}

export function isIntakeDocumentClaimable(
  document: {
    storageState: IntakeStorageState
    inspectionStatus: IntakeInspectionStatus
    claimable: boolean
  },
  environment: ScannerEnvironment = process.env
): boolean {
  return (
    document.storageState === 'STAGED_INTAKE' &&
    intakeInspectionAllowsClaim(document.inspectionStatus, environment) &&
    document.claimable === true
  )
}

export type IntakeDocumentProjection = {
  id: string
  displayName: string
  declaredMimeType: string
  byteSize: number
  inspectionStatus: IntakeInspectionStatus
  claimable: boolean
  createdAt: number
}

export function projectIntakeDocument(document: Doc<'intakeDocuments'>): IntakeDocumentProjection {
  return {
    id: `${document._id}`,
    displayName: document.displayName,
    declaredMimeType: document.declaredMimeType,
    byteSize: document.byteSize,
    inspectionStatus: document.inspectionStatus,
    claimable: isIntakeDocumentClaimable(document),
    createdAt: document.createdAt,
  }
}
