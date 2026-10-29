// ============================================================================
// TIPOS DE LA SALA
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// El idioma de la sala se define una vez con `Schema.Literals`. El nivel de
// acceso es el mismo catálogo de `@/lib/documents/classification`: una segunda
// lista acá dejaba pasar un `as` que el `Record` de alcance indexaba a
// `undefined` — y la advertencia de desclasificación no se pintaba.

import { Schema } from 'effect'

import {
  isDocumentAccessLevel,
  type DocumentAccessLevel,
  type DocumentClassification,
} from '@/lib/documents/classification'

/** El sitio ships en un solo idioma ([F] 2026-09-03, DECISIONS). */
export const VdrLocaleSchema = Schema.Literals(['es'])
export type VdrLocale = typeof VdrLocaleSchema.Type

export type VdrAccessLevel = DocumentAccessLevel

/** El default de la sala cuando el nivel que llega no es ninguno de los tres. */
const DEFAULT_VDR_ACCESS_LEVEL: VdrAccessLevel = 'NDA_REQUIRED'

/**
 * Un nivel de acceso que llegó de afuera (props de una proyección, el value de
 * un `<Select>`, una fila vieja) resuelto contra la unión real. Sin esto, un
 * `as VdrAccessLevel` deja pasar cualquier cadena y el `Record` que la indexa
 * devuelve `undefined` sin que nadie se entere.
 */
export function vdrAccessLevelOr(
  value: unknown,
  fallback: VdrAccessLevel = DEFAULT_VDR_ACCESS_LEVEL
): VdrAccessLevel {
  return isDocumentAccessLevel(value) ? value : fallback
}

/** La sala es una por empresa: el scope existe para nombrarla, no para elegir. */
export type VdrRoomScope = { kind: 'COMPANY'; id: 'company' }

export type VdrDocumentView = {
  _id: string
  name: string
  fileType?: string | null
  folder?: string | null
  accessLevel?: VdrAccessLevel
  classification?: DocumentClassification
  expiresAt?: number | null
  isExpired?: boolean
  lifecycleStatus?: 'ACTIVE' | 'QUARANTINED' | 'ARCHIVED' | null
  currentVersionId?: string | null
  publishedVersionId?: string | null
  currentVersionNumber?: number | null
  // La procedencia decide si el diálogo de «Quitar de la sala» avisa que el
  // equipo se va a enterar ([F] 2026-09-17).
  sourceType?: string | null
}

export type EditableVdrDocument = {
  _id: string
  name: string
  folder?: string | null
  accessLevel?: string | null
  classification?: string | null
  expiresAt?: number | null
}

export type VdrCopy = {
  title: string
  subtitle: (companyName: string) => string
  companyLibrary: string
  roomLabel: string
  uploadDocument: string
  viewActivity: string
  uploadTitle: string
  uploadDescription: string
  file: string
  chooseFile: string
  chooseFiles: string
  noFileChosen: string
  fileHint: string
  documentName: string
  documentNamePlaceholder: string
  category: string
  folderDestination: string
  folderAuto: string
  folderAutoHint: string
  companyUploadDescription: string
  accessLevel: string
  classification: string
  cancel: string
  upload: string
  teasers: string
  ndaRequired: string
  private: string
  documents: string
  emptyRoom: string
  search: string
  searchPlaceholder: string
  accessPublic: string
  accessNda: string
  accessPrivate: string
  deleteTitle: string
  deleteDescription: (name?: string, isTeamDelivery?: boolean) => string
  delete: string
  fileTypeError: string
  fileSizeError: string
  unsafeFileError: string
  signInRequired: string
  missingFile: string
  uploadSuccess: string
  uploadErrorFallback: string
  purgeErrorFallback: string
  purgeTeamDeliverableError: (names: readonly string[]) => string
  deleteSuccess: string
  deleteError: string
  open: string
  openUnavailable: string
  openError: string
  editTitle: string
  editDescription: string
  expiresAt: string
  expiresAtHint: string
  save: string
  editSuccess: string
  editError: string
  declassifyWarning: string
}
