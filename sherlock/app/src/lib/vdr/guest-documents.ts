import { Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'

type GuestCandidate = {
  _id: string
  name: string
  accessLevel?: string | null
  classification?: string | null
  lifecycleStatus?: string | null
  isExpired?: boolean
  expiresAt?: number | null
  currentVersionId?: string | null
  publishedVersionId?: string | null
}

export type GuestShareableDocument = { _id: Id<'documents'>; name: string }

const GuestShareableAccessSchema = Schema.Literals(['NDA_REQUIRED'])
const GuestShareableLifecycleSchema = Schema.Literals(['ACTIVE'])
const KycSensitiveSchema = Schema.Literals(['KYC_SENSITIVE'])

const isShareableAccess = Schema.is(GuestShareableAccessSchema)
const isShareableLifecycle = Schema.is(GuestShareableLifecycleSchema)
const isKycSensitive = Schema.is(KycSensitiveSchema)

function isShareable(document: GuestCandidate, now: number): boolean {
  return (
    isShareableAccess(document.accessLevel) &&
    !isKycSensitive(document.classification) &&
    isShareableLifecycle(document.lifecycleStatus) &&
    document.isExpired !== true &&
    (document.expiresAt === undefined || document.expiresAt === null || document.expiresAt > now) &&
    Boolean(document.currentVersionId) &&
    document.currentVersionId === document.publishedVersionId
  )
}

// Lo que un invitado puede recibir: solo la sala de la empresa, bajo NDA, sin
// material KYC, vigente y con la versión publicada al día. La pantalla de
// invitados, la sala y el panel del equipo filtran con esta misma regla.
export function selectGuestShareableDocuments(
  documents: readonly GuestCandidate[],
  now: number
): GuestShareableDocument[] {
  return documents
    .filter((document) => isShareable(document, now))
    .map((document) => ({ _id: document._id as Id<'documents'>, name: document.name }))
}
