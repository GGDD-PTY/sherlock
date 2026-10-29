// ============================================================================
// POLICY DE ACCESO DOCUMENTAL — la decisión, sin IO
// ============================================================================
// Todo el vocabulario de la decisión (clasificación, veredicto, step-up) vive
// como `Schema.Literals`: una lista por concepto, y de cada lista salen el
// tipo y su guard. El guard es lo que reemplaza al casteo — la clasificación
// que llega de un documento persistido es un `string` opcional del schema, y
// antes se comprobaba con `includes(x as DocumentClassification)` para después
// devolver `x as DocumentClassification`. Dos casteos ciegos sobre el mismo
// valor: si la lista y el tipo se separaban, el `as` mentía en silencio.
// ============================================================================

import { Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'

const DOCUMENT_CLASSIFICATIONS = [
  'PUBLIC_TEASER',
  'CONFIDENTIAL',
  'RESTRICTED',
  'LEGAL',
  'KYC_SENSITIVE',
] as const

const DocumentClassificationSchema = Schema.Literals(DOCUMENT_CLASSIFICATIONS)

export type DocumentClassification = typeof DocumentClassificationSchema.Type

const isDocumentClassification = Schema.is(DocumentClassificationSchema)

export const DOCUMENT_ACCESS_DECISIONS = [
  'ALLOW',
  'DENY',
  'REQUIRE_STEP_UP',
  'REQUIRE_REVIEW',
] as const

// Sin `Schema.Literals`: la decisión sale de este mismo archivo (es pura, sin
// IO — ver comentario de módulo), nunca entra sin decodificar desde afuera.
type DocumentAccessDecision = (typeof DOCUMENT_ACCESS_DECISIONS)[number]

// Sin array intermedio: nada más en el árbol lee la lista como valor (a
// diferencia de `DOCUMENT_ACCESS_DECISIONS`, que el test de cobertura recorre
// en runtime), así que un `as const` acá sería un valor en el bundle que nadie
// llama.
type DocumentStepUpRequirement =
  | 'NONE'
  | 'SIGNED_NDA'
  | 'RENEW_NDA'
  | 'VERIFIED_KYC'
  | 'MANUAL_REVIEW'
  | 'DOWNLOAD_GRANT'

export interface DocumentAccessEvaluation {
  decision: DocumentAccessDecision
  outcome: string
  reason: string
  classification: DocumentClassification
  riskScore: number
  stepUpRequirement: DocumentStepUpRequirement
}

export interface DocumentAccessContext {
  profile: Pick<Doc<'profiles'>, '_id' | 'role' | 'kycStatus'>
  document: Pick<
    Doc<'documents'>,
    'accessLevel' | 'classification' | 'expiresAt' | 'isExpired' | 'companyId' | 'lifecycleStatus'
  >
  isOwner: boolean
}

const CLASSIFICATION_RISK: Record<DocumentClassification, number> = {
  PUBLIC_TEASER: 5,
  CONFIDENTIAL: 35,
  RESTRICTED: 65,
  LEGAL: 75,
  KYC_SENSITIVE: 95,
}

export function inferDocumentClassification(
  accessLevel?: Doc<'documents'>['accessLevel'],
  classification?: Doc<'documents'>['classification']
): DocumentClassification {
  // El guard narrowea; no hay `as` que pueda mentir si la lista cambia.
  if (isDocumentClassification(classification)) {
    return classification
  }

  switch (accessLevel) {
    case 'PUBLIC':
      return 'PUBLIC_TEASER'
    case 'PRIVATE':
      return 'RESTRICTED'
    case 'NDA_REQUIRED':
    default:
      return 'CONFIDENTIAL'
  }
}

function buildRiskScore(
  classification: DocumentClassification,
  profileRole: Doc<'profiles'>['role'],
  isOwner: boolean
): number {
  if (profileRole === 'ADMIN') {
    return 15
  }

  if (isOwner) {
    return 10
  }

  return CLASSIFICATION_RISK[classification]
}

export function evaluateDocumentAccessDecision(
  context: DocumentAccessContext
): DocumentAccessEvaluation {
  const classification = inferDocumentClassification(
    context.document.accessLevel,
    context.document.classification
  )
  const riskScore = buildRiskScore(classification, context.profile.role, context.isOwner)

  if (context.document.lifecycleStatus === 'QUARANTINED') {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_QUARANTINED',
      reason: 'Este archivo permanece en cuarentena hasta completar su verificación.',
      classification,
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  if (context.document.lifecycleStatus === 'ARCHIVED') {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_ARCHIVED',
      reason: 'Este documento está archivado y no puede entregarse.',
      classification,
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  if (context.document.isExpired) {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_EXPIRED',
      reason: 'El acceso a este documento ha expirado.',
      classification,
      riskScore,
      stepUpRequirement: 'NONE',
    }
  }

  if (context.document.expiresAt && context.document.expiresAt <= Date.now()) {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_EXPIRED',
      reason: 'El acceso a este documento ha expirado.',
      classification,
      riskScore,
      stepUpRequirement: 'NONE',
    }
  }

  if (context.profile.role === 'ADMIN') {
    return {
      decision: 'ALLOW',
      outcome: 'ALLOWED_ADMIN',
      reason: 'Acceso autorizado por rol administrativo.',
      classification,
      riskScore,
      stepUpRequirement: 'NONE',
    }
  }

  if (context.isOwner) {
    return {
      decision: 'ALLOW',
      outcome: 'ALLOWED_OWNER',
      reason: 'El propietario del data room puede acceder al documento.',
      classification,
      riskScore,
      stepUpRequirement: 'NONE',
    }
  }

  if (classification === 'KYC_SENSITIVE') {
    return {
      decision: 'REQUIRE_REVIEW',
      outcome: 'REVIEW_REQUIRED_KYC_SENSITIVE',
      reason: 'Este documento requiere revisión manual de compliance.',
      classification,
      riskScore,
      stepUpRequirement: 'MANUAL_REVIEW',
    }
  }

  if (context.document.accessLevel === 'PRIVATE') {
    return {
      decision: 'DENY',
      outcome: 'DENIED_PRIVATE_OWNER_ONLY',
      reason: 'Este documento es privado y solo el owner o admin puede acceder.',
      classification,
      riskScore,
      stepUpRequirement: 'NONE',
    }
  }

  // En esta ruta no queda una contraparte con compuertas propias que abrir: el
  // acceso de un invitado a la sala se decide por su proyección
  // (`_guests/projection.ts`), no por aquí. Todo principal que no sea ADMIN ni
  // la empresa dueña se queda afuera.
  return {
    decision: 'DENY',
    outcome: 'DENIED_NO_ROOM_ACCESS',
    reason: 'No tienes acceso autorizado a esta sala.',
    classification,
    riskScore,
    stepUpRequirement: 'NONE',
  }
}

export function getDocumentAccessErrorMessage(evaluation: DocumentAccessEvaluation): string {
  switch (evaluation.decision) {
    case 'REQUIRE_STEP_UP':
      switch (evaluation.stepUpRequirement) {
        case 'SIGNED_NDA':
          return 'Debes firmar un NDA activo para acceder a este documento.'
        case 'RENEW_NDA':
          return 'El NDA ha expirado. Por favor, renuévalo para acceder a este documento.'
        case 'VERIFIED_KYC':
          return 'Este documento requiere KYC verificado.'
        case 'DOWNLOAD_GRANT':
          return 'Necesitas permiso explícito para descargar este documento.'
        default:
          return evaluation.reason
      }
    case 'REQUIRE_REVIEW':
      return 'Este documento requiere revisión manual de compliance.'
    case 'DENY':
    default:
      return evaluation.reason
  }
}
