import { BarChart3, FileText, FolderOpen, type LucideIcon } from 'lucide-react'
import { Option, Schema } from 'effect'

import { MAX_DIRECT_UPLOAD_BYTES, MAX_DIRECT_UPLOAD_MB } from '@/lib/storage/upload-limits'
import type { DocumentClassification } from '@/lib/documents/classification'
import { VDR_DOCUMENT_CATEGORY_TABS } from '@/lib/vdr/document-taxonomy'
import type { VdrAccessLevel, VdrCopy, VdrLocale } from './types'

export type VdrSummaryCopy = VdrCopy & {
  /**
   * Copy por código estable de denegación documental (`DeniedDocumentAccess.code`,
   * es decir el `outcome` de la policy). El backend redacta su mensaje en español
   * para la bitácora; la UI NUNCA lo renderiza — resuelve el código contra este
   * mapa y cae en `openError`, que ya está localizado.
   */
  denialReasons: Record<string, string>
  /**
   * Copy por código estable de error de negocio (ConvexError `data.code`,
   * `data.details.reason` / `data.details.currentState`, o el `code` de un error
   * local). Nunca se muestra `error.message`.
   */
  mutationErrors: Record<string, string>
}

/**
 * Extrae el código estable de un error sin tocar nunca su `message`.
 *
 * Orden de preferencia: `data.details.reason` (código granular que el backend
 * adjunta a un `AppError` de categoría amplia como `VALIDATION_FAILED`),
 * `data.details.currentState` (el que ya usaba `invalidState`), `data.code`
 * (categoría del `AppError`) y, por último, `error.code` para errores locales
 * del cliente (p.ej. `AdminVdrCapabilityError`).
 */
// ===== LA COSTURA CON EFFECT =====
// «Un código estable es una cadena que no está vacía» estaba escrito cuatro
// veces como `typeof x === 'string' && x.length > 0`. Ahora la regla se define
// una sola vez —`Schema.NonEmptyString`— y cada lectura la aplica.
//
// El acceso al campo sigue siendo `Reflect.get`, y a propósito: lo que llega
// acá es lo que alguien lanzó, no un payload con forma garantizada. Decodificar
// el objeto entero con un `Schema.Struct` lo volvería todo o nada — un
// `details` en `null` o un `code` numérico descartarían también los campos
// sanos que vienen al lado, y el toast perdería un código que hoy sí resuelve.
const decodeStableCode = Schema.decodeUnknownOption(Schema.NonEmptyString)

function stableCode(value: unknown): string | null {
  const decoded = decodeStableCode(value)
  return Option.isSome(decoded) ? decoded.value : null
}

function readStableErrorCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null

  const details = Reflect.get(value, 'details')
  if (typeof details === 'object' && details !== null) {
    const reason = stableCode(Reflect.get(details, 'reason'))
    if (reason) return reason
    const currentState = stableCode(Reflect.get(details, 'currentState'))
    if (currentState) return currentState
  }

  return stableCode(Reflect.get(value, 'code'))
}

export function resolveBusinessErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const fromConvexPayload = readStableErrorCode(Reflect.get(error, 'data'))
  if (fromConvexPayload) return fromConvexPayload

  return stableCode(Reflect.get(error, 'code'))
}

export function localizedErrorMessage(
  messages: Record<string, string>,
  code: string | null | undefined,
  fallback: string
): string {
  if (!code) return fallback
  // `hasOwnProperty` y no `in`: un código como `__proto__` o `toString` jamás
  // puede resolver contra la cadena de prototipos.
  if (!Object.prototype.hasOwnProperty.call(messages, code)) return fallback
  const message = messages[code]
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

export function businessErrorMessage(
  error: unknown,
  messages: Record<string, string>,
  fallback: string
): string {
  return localizedErrorMessage(messages, resolveBusinessErrorCode(error), fallback)
}

// El mapa por código solo sabe decir «revisa los valores». Cuando la mutation
// redactó el porqué en español —un legal hold, un lote que cruza empresas, una
// entrega del equipo— ese motivo es lo único accionable que hay, y se muestra
// tal cual. Solo pasan los códigos donde el servidor escribe esa frase; el
// resto (auth, rate limit, error interno) sigue cayendo al mapa, que no filtra
// nada de adentro.
const SERVER_AUTHORED_REASON_CODES = new Set([
  'VALIDATION_FAILED',
  'VALIDATION_INVALID_INPUT',
  'BUSINESS_INVALID_STATE',
  'BUSINESS_INVALID_OPERATION',
])

function serverAuthoredReason(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const data = Reflect.get(error, 'data')
  if (typeof data !== 'object' || data === null) return null
  return stableCode(Reflect.get(data, 'message'))
}

function authoredReason(error: unknown): string | null {
  const code = resolveBusinessErrorCode(error)
  if (code === null || !SERVER_AUTHORED_REASON_CODES.has(code)) return null
  return serverAuthoredReason(error)
}

// Primera oración con la que `documents.purge` rechaza una entrega del equipo
// (`convex/_documents/mutations.ts`). El servidor no tiene un código propio para
// ese caso, así que el cliente lo reconoce por la frase y la cambia por la suya,
// que sí nombra el documento. Si la frase del servidor cambia, el cliente
// muestra la del servidor: sigue siendo cierta, solo pierde el nombre.
const TEAM_DELIVERABLE_REJECTION = 'Este documento es una entrega del equipo'

/**
 * ¿El servidor rechazó el lote porque incluye una entrega del equipo?
 *
 * Sin esta pregunta cualquier fallo —un 429, la red caída, un legal hold sobre
 * otro documento— se contaba como «la preparó el equipo» con solo tener una
 * entrega en la selección, y el motivo verdadero no llegaba nunca.
 */
export function isTeamDeliverableRejection(error: unknown): boolean {
  const reason = authoredReason(error)
  return reason !== null && reason.startsWith(TEAM_DELIVERABLE_REJECTION)
}

/**
 * Cambia cada id de documento que aparezca en el mensaje por su nombre.
 *
 * Los mensajes del servidor se redactaron para un log: «El documento
 * kd7… tiene un legal hold ACTIVE». Mostrarle ese id al cliente no le dice
 * nada y filtra un interno; el nombre del documento sí es accionable.
 */
export function withDocumentNames(
  message: string,
  documents: readonly { _id: string; name: string }[]
): string {
  let named = message
  for (const document of documents) {
    if (!named.includes(document._id)) continue
    named = named.split(document._id).join(`«${document.name}»`)
  }
  return named
}

export function actionableBusinessMessage(
  error: unknown,
  messages: Record<string, string>,
  fallback: string
): string {
  return (
    authoredReason(error) ??
    localizedErrorMessage(messages, resolveBusinessErrorCode(error), fallback)
  )
}

const ES_DENIAL_REASONS: Record<string, string> = {
  DENIED_DOCUMENT_QUARANTINED:
    'Este archivo permanece en cuarentena hasta completar su verificación.',
  DENIED_DOCUMENT_ARCHIVED: 'Este documento está archivado y ya no puede entregarse.',
  DENIED_DOCUMENT_EXPIRED: 'El acceso a este documento ya venció.',
  DENIED_PRIVATE_OWNER_ONLY:
    'Este documento es privado: solo el dueño del Data Room o el equipo de Sherlock puede abrirlo.',
  DENIED_NO_ROOM_ACCESS:
    'Necesitas una invitación del equipo como invitado o contraparte para abrir este documento.',
  REVIEW_REQUIRED_KYC_SENSITIVE:
    'Este documento requiere revisión manual de compliance antes de abrirse.',
  REQUIRE_ACCEPTED_CONNECTION:
    'El equipo debe confirmar tu acceso como invitado o contraparte antes de abrir este documento.',
  REQUIRE_SIGNED_NDA: 'Debes firmar un NDA activo para abrir este documento.',
  REQUIRE_NDA_RENEWAL: 'El NDA venció. Renuévalo para abrir este documento.',
  REQUIRE_VERIFIED_KYC: 'Este documento requiere KYC verificado.',
  REQUIRE_CURRENT_ROOM_GRANT: 'La empresa debe habilitar tu acceso a este Data Room.',
  REQUIRE_DOWNLOAD_GRANT: 'Necesitas permiso explícito para descargar este documento.',
  REQUIRE_REAL_INTEREST: 'Hace falta una solicitud vigente de esta contraparte.',
  REQUIRE_MUTUAL_OPT_IN:
    'El equipo debe confirmar el acceso de esta contraparte antes de abrir el Data Room.',
  REQUIRE_HUMAN_MATCH_APPROVAL:
    'El equipo de Sherlock debe aprobar primero este acceso de contraparte.',
  REQUIRE_AUTHENTICATED_PRINCIPAL: 'Inicia sesión o verifica tu invitación para continuar.',
  REQUIRE_PREVIEW_STEP_UP: 'Confirma tu identidad antes de previsualizar como otra persona.',
  DENIED_ISSUER_INTERNAL: 'Este documento permanece interno para la empresa.',
  DENIED_ROOM_INACTIVE: 'Este Data Room no está activo para contrapartes.',
  DENIED_RELATIONSHIP_BLOCKED: 'La relación con esta contraparte está bloqueada.',
  DENIED_ACTION_NOT_PERMITTED: 'Esta identidad no puede realizar esa acción en el Data Room.',
  DENIED_PRINCIPAL_INACTIVE: 'Esta identidad ya no está activa.',
  DENIED_RESOURCE_EXPIRED: 'Este recurso ya venció.',
  DENIED_POLICY_STATE_MISMATCH: 'No se pudo verificar el estado de autorización de este Data Room.',
  DENIED_INVALID_POLICY_STATE: 'No se pudo verificar el estado de autorización de este Data Room.',
  DENIED_INVALID_TIME: 'No se pudo verificar la vigencia de este acceso.',
  DENIED_COMPANY_NOT_FOUND: 'No se pudo resolver la empresa detrás de este Data Room.',
  DENIED_COMPANY_AUTHORIZATION_REVOKED: 'La empresa revocó la autorización de este Data Room.',
}

const ES_MUTATION_ERRORS: Record<string, string> = {
  ADMIN_VDR_CAPABILITY_UNAVAILABLE:
    'La capacidad admin de este Data Room no está disponible. Vuelve a autorizar e intenta de nuevo.',
  AUTH_NOT_AUTHENTICATED: 'Tu sesión expiró. Inicia sesión de nuevo para continuar.',
  AUTH_SESSION_EXPIRED: 'Tu sesión expiró. Inicia sesión de nuevo para continuar.',
  AUTHZ_UNAUTHORIZED: 'No tienes permiso para realizar esta acción.',
  AUTHZ_NOT_OWNER: 'No tienes permiso sobre este recurso.',
  AUTHZ_ADMIN_REQUIRED: 'Solo administradores pueden realizar esta acción.',
  AUTHZ_ROLE_REQUIRED: 'Tu rol no puede realizar esta acción.',
  NOT_FOUND: 'El registro ya no existe. Actualiza e intenta de nuevo.',
  DOCUMENT_NOT_FOUND: 'Este documento ya no existe en el Data Room.',
  RATE_LIMIT_EXCEEDED: 'Demasiadas solicitudes en poco tiempo. Intenta de nuevo en unos minutos.',
  VALIDATION_FAILED: 'Revisa los valores que ingresaste e intenta de nuevo.',
  VALIDATION_INVALID_INPUT: 'Revisa los valores que ingresaste e intenta de nuevo.',
  BUSINESS_INVALID_STATE: 'Esta acción no está disponible en el estado actual del documento.',
  BUSINESS_INVALID_OPERATION: 'Esta operación no está permitida para este documento.',
  BUSINESS_NDA_REQUIRED: 'Se requiere un NDA firmado para este documento.',
  BUSINESS_MISSING_PROFILE: 'Completa tu perfil antes de realizar esta acción.',
  INTERNAL_ERROR: 'Algo falló de nuestro lado. Intenta de nuevo en un momento.',
}

export const ALLOWED_VDR_EXTENSIONS = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.csv',
] as const
const MAX_VDR_FILE_SIZE = MAX_DIRECT_UPLOAD_BYTES

export const ACCESS_LEVEL_REACH: Record<VdrAccessLevel, number> = {
  PUBLIC: 0,
  NDA_REQUIRED: 1,
  PRIVATE: 2,
}

export const VDR_ACCESS_LEVELS = [
  {
    value: 'PUBLIC' as const,
    label: { es: 'Teaser' },
    description: {
      es: 'Publicación limitada de un teaser de baja sensibilidad, revisada y auditada por el equipo',
    },
  },
  {
    value: 'NDA_REQUIRED' as const,
    label: { es: 'NDA de invitado/contraparte' },
    description: {
      es: 'Acceso de invitado o contraparte emitido por el equipo con NDA firmado y vigente',
    },
  },
  {
    value: 'PRIVATE' as const,
    label: { es: 'Privado' },
    description: {
      es: 'Solo la empresa y el equipo de Sherlock pueden verlo',
    },
  },
]

export const VDR_CLASSIFICATIONS: Array<{
  value: DocumentClassification
  label: Record<VdrLocale, string>
  description: Record<VdrLocale, string>
  badgeClassName: string
}> = [
  {
    value: 'PUBLIC_TEASER',
    label: { es: 'Teaser público' },
    description: {
      es: 'Material de baja sensibilidad para una publicación limitada, revisada y auditada por el equipo.',
    },
    badgeClassName: 'border-primary/30 text-primary',
  },
  {
    value: 'CONFIDENTIAL',
    label: { es: 'Confidencial' },
    description: {
      es: 'Información estándar del Data Room; requiere acceso emitido por el equipo y un NDA.',
    },
    badgeClassName: 'border-border text-foreground',
  },
  {
    value: 'RESTRICTED',
    label: { es: 'Restringido' },
    description: {
      es: 'Información sensible que además requiere KYC verificado.',
    },
    badgeClassName: 'border-accent/50 text-foreground',
  },
  {
    value: 'LEGAL',
    label: { es: 'Legal' },
    description: {
      es: 'Material legal sensible que exige KYC verificado.',
    },
    badgeClassName: 'border-primary/30 text-primary',
  },
  {
    value: 'KYC_SENSITIVE',
    label: { es: 'Sensible para KYC' },
    description: {
      es: 'Reservado para revisión manual de compliance.',
    },
    badgeClassName: 'border-destructive/30 text-destructive',
  },
]

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  all: FileText,
  management_presentation: BarChart3,
  operations: BarChart3,
  data_room_index: FolderOpen,
  other: FolderOpen,
}

export const VDR_DOCUMENT_CATEGORIES = VDR_DOCUMENT_CATEGORY_TABS.map((category) => ({
  ...category,
  icon: CATEGORY_ICONS[category.value] ?? FileText,
}))

export const VDR_COPY: Record<VdrLocale, VdrSummaryCopy> = {
  es: {
    title: 'Data Room',
    subtitle: (name) => `Organiza las fuentes y los entregables de ${name}`,
    companyLibrary: 'Biblioteca corporativa',
    roomLabel: 'Sala',
    uploadDocument: 'Subir documento',
    viewActivity: 'Ver actividad',
    uploadTitle: 'Subir documento',
    uploadDescription: 'Agrega uno o más archivos controlados al Data Room activo.',
    file: 'Archivo',
    chooseFile: 'Elegir archivo',
    chooseFiles: 'Elegir archivos',
    noFileChosen: 'Ningún archivo elegido',
    fileHint: `Formatos: PDF, Excel, Word, PowerPoint, CSV. Máx ${MAX_DIRECT_UPLOAD_MB}MB`,
    documentName: 'Nombre del documento',
    documentNamePlaceholder: 'Ej: Estados Financieros 2024',
    category: 'Categoría',
    folderDestination: 'Carpeta',
    folderAuto: 'Ruteo automático',
    folderAutoHint: 'Si no eliges carpeta, Sherlock pone cada archivo en la que le corresponde.',
    companyUploadDescription:
      'Suelta uno o más archivos. El nombre sale del archivo; puedes renombrarlo después.',
    accessLevel: 'Nivel de acceso',
    classification: 'Confidencialidad',
    cancel: 'Cancelar',
    upload: 'Subir',
    teasers: 'Teasers',
    ndaRequired: 'Con NDA',
    private: 'Privados',
    documents: 'Índice documental',
    emptyRoom: 'Este Data Room está listo para recibir su primer documento controlado.',
    search: 'Buscar documentos',
    searchPlaceholder: 'Busca por nombre o carpeta',
    accessPublic: 'Teaser',
    accessNda: 'NDA de invitado/contraparte',
    accessPrivate: 'Privado',
    deleteTitle: '¿Quitar de la sala?',
    // El gesto es del dueño de la sala ([F] 2026-09-17), así que la copy dice
    // lo que de verdad pasa: sale de la vista de los invitados y nada se
    // destruye. Cuando el documento es una entrega del equipo se agrega la
    // frase que explica el aviso que sale detrás.
    deleteDescription: (name, isTeamDelivery) =>
      `¿Quitas ${name ?? 'este documento'} de tu Data Room? Los invitados dejan de verlo. El historial y la evidencia de auditoría quedan guardados.${
        isTeamDelivery ? ' Es una entrega del equipo: le avisamos que la quitaste.' : ''
      }`,
    delete: 'Quitar de la sala',
    fileTypeError: `Tipo de archivo no permitido. Usa: ${ALLOWED_VDR_EXTENSIONS.join(', ')}`,
    fileSizeError: `Archivo muy grande. Máximo ${MAX_VDR_FILE_SIZE / 1024 / 1024}MB`,
    unsafeFileError:
      'No pudimos verificar este archivo de forma segura. Usa un PDF u Office válido y sin cifrado.',
    signInRequired: 'Debes iniciar sesión para subir documentos',
    missingFile: 'Selecciona un archivo y asígnale un nombre',
    uploadSuccess: 'Documento subido correctamente',
    uploadErrorFallback: 'Error al subir el documento',
    purgeErrorFallback:
      'No pudimos borrar la selección. Revisa que todos los documentos sigan en esta sala.',
    purgeTeamDeliverableError: (names: readonly string[]) =>
      names.length === 1
        ? `«${names[0]}» la preparó el equipo de Sherlock. Pídele al equipo que la retire y vuelve a intentarlo.`
        : `${names.map((name) => `«${name}»`).join(', ')} las preparó el equipo de Sherlock. Pídele al equipo que las retire y vuelve a intentarlo.`,
    deleteSuccess: 'Documento quitado de la sala',
    deleteError: 'No pudimos quitar el documento',
    open: 'Abrir',
    openUnavailable: 'Este documento no tiene archivo descargable o ya venció',
    openError: 'No se pudo abrir el documento',
    editTitle: 'Editar documento',
    editDescription: 'Renómbralo, muévelo, cambia el acceso o define un vencimiento.',
    expiresAt: 'Fecha de vencimiento',
    expiresAtHint: 'Opcional. Después de esta fecha se revocan los accesos abiertos.',
    save: 'Guardar cambios',
    editSuccess: 'Documento actualizado',
    editError: 'Error al actualizar el documento',
    declassifyWarning:
      'Estás ampliando el acceso. Al guardar, este archivo quedará al alcance de más personas.',
    denialReasons: ES_DENIAL_REASONS,
    mutationErrors: ES_MUTATION_ERRORS,
  },
}
