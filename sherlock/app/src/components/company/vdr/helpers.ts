// ============================================================================
// HELPERS DE LA SALA
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// Dos cosas cambiaron acá y las dos eran fallos calladitos.
//
// 1. `endOfLocalDayTimestamp` lanzaba un `Error` pelado desde dos ramas
//    distintas. Ahora la fecha se decodifica con `effect/Schema` —forma
//    `YYYY-MM-DD` primero, y después el ida y vuelta por el calendario, que es
//    lo que caza un `2026-02-31`— y el fallo tiene nombre (`VdrExpiryDateError`).
//    El contrato no cambia: la función sigue devolviendo un número y sigue
//    lanzando con el mismo mensaje, porque `useVdrDocumentActions` la llama
//    dentro de su `try`.
//
// 2. `getClassificationOption` caía a `VDR_CLASSIFICATIONS[1]` — un default por
//    POSICIÓN. Reordenar el catálogo cambiaba a qué confidencialidad cae un
//    documento sin que nadie tocara esta línea, y hacia arriba o hacia abajo
//    según el orden nuevo. Ahora el default se busca por su valor.

import { Effect, Exit, Option, Schema } from 'effect'

import { runClientSyncExit } from '@/lib/effect/client-runtime'

import type { Id } from '@/../convex/_generated/dataModel'
import type { DocumentClassification } from '@/lib/documents/classification'
import { inferVdrFolderFromName, VDR_SHELL_FOLDER_VALUES } from '@/lib/vdr/document-taxonomy'
import type { VdrAccessLevel, VdrDocumentView, VdrLocale, VdrRoomScope } from './types'
import { VdrLocaleSchema } from './types'
import { VDR_CLASSIFICATIONS } from './config'

/** UI sentinel for COMPANY uploads; persist as `other` (same as the landing). */
export const COMPANY_UPLOAD_AUTO_FOLDER = 'auto'
export const COMPANY_UPLOAD_DEFAULT_ACCESS: VdrAccessLevel = 'NDA_REQUIRED'
export const COMPANY_UPLOAD_DEFAULT_CLASSIFICATION: DocumentClassification = 'CONFIDENTIAL'

export function companyUploadFolderSelectValue(folder: string): string {
  return VDR_SHELL_FOLDER_VALUES.includes(folder) ? folder : COMPANY_UPLOAD_AUTO_FOLDER
}

export function companyUploadFolderPersistValue(selectValue: string): string {
  return selectValue === COMPANY_UPLOAD_AUTO_FOLDER ? 'other' : selectValue
}

/**
 * La carpeta con la que se guarda un archivo de la sala.
 *
 * «Ruteo automático» promete acomodar el documento como lo hace la landing, y
 * hasta ahora guardaba el centinela `'other'`: una carpeta que no existe en el
 * shell, así que la sala lo dibujaba en el respaldo, «2. Corporativos». Ahora
 * ese caso pasa por el mismo `inferVdrFolderFromName` que usa la landing. La
 * carpeta elegida a mano sigue mandando, y un nombre que no dice nada sigue
 * cayendo en el respaldo del clasificador.
 *
 * El equipo queda afuera del clasificador: su formulario de subida ofrece el
 * catálogo heredado completo (`VDR_DOCUMENT_FOLDERS`), así que «Teaser» o
 * «Modelo Financiero» son elecciones deliberadas para reclasificar material
 * viejo, no el centinela. Adivinarle la carpeta por el nombre le borraría la
 * decisión.
 */
export function resolveCompanyUploadFolder(
  fileName: string,
  selected: string,
  adminOperator: boolean
): string {
  if (adminOperator) return selected
  return VDR_SHELL_FOLDER_VALUES.includes(selected) ? selected : inferVdrFolderFromName(fileName)
}

type DemoDocument = {
  id: string
  name: string
  fileType?: string | null
  folder?: string | null
  accessLevel?: VdrAccessLevel
  classification?: DocumentClassification
  expiresAt?: number | null
}

const decodeLocale = Schema.decodeUnknownOption(VdrLocaleSchema)

export function normalizeVdrLocale(locale: string): VdrLocale {
  // El sitio ships en un solo idioma: cualquier otra cosa cae en `es`.
  const decoded = decodeLocale(locale)
  return Option.isSome(decoded) ? decoded.value : 'es'
}

export function toDateInputValue(timestamp?: number | null) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * La fecha de vencimiento no sirve. No se exporta: `useVdrDocumentActions` la
 * atrapa como cualquier otro fallo del guardado y ya resuelve su copy.
 */
class VdrExpiryDateError extends Schema.TaggedError<VdrExpiryDateError>()('VdrExpiryDateError', {
  message: Schema.String,
}) {}

const EXPIRY_DATE_MESSAGE = 'La fecha de vencimiento no es válida.'
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * El final del día local de una fecha `YYYY-MM-DD`.
 *
 * Los dos chequeos siguen siendo los mismos: la forma, y que el `Date` que se
 * construye sea el mismo día que se pidió (un `2026-02-31` se desborda a marzo
 * en silencio, y guardar marzo cuando el cliente escribió febrero es un
 * vencimiento equivocado, no un redondeo).
 */
const parseEndOfLocalDay = Effect.fn('Vdr.endOfLocalDay')(function* (
  value: string
): Effect.fn.Return<number, VdrExpiryDateError> {
  const match = CALENDAR_DATE.exec(value)
  if (!match) return yield* new VdrExpiryDateError({ message: EXPIRY_DATE_MESSAGE })

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(year, monthIndex, day, 23, 59, 59, 999)

  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
    return yield* new VdrExpiryDateError({ message: EXPIRY_DATE_MESSAGE })
  }

  return date.getTime()
})

export function endOfLocalDayTimestamp(value: string): number {
  // El programa no espera a nadie, así que corre síncrono; el Exit se traduce
  // al mismo `throw` que los llamadores ya atrapan.
  const exit = runClientSyncExit(parseEndOfLocalDay(value))
  if (Exit.isSuccess(exit)) return exit.value

  const failure = Exit.findErrorOption(exit)
  throw new Error(Option.isSome(failure) ? failure.value.message : EXPIRY_DATE_MESSAGE)
}

// ============================================================================
// EL BORDE DE UNA OPERACIÓN DOCUMENTAL
// ============================================================================
// Toda acción de la sala termina igual: se autoriza, se manda a Convex o a una
// ruta, y lo único que la UI necesita después es si quedó firme. Antes cada una
// tenía su propio `try/catch` y el fallo se aplanaba a un booleano ahí adentro,
// donde ya no se sabía qué había pasado.
//
// Este es el único lugar donde una promesa de la sala se convierte en programa:
// el error queda tipado en el canal `E`, cada llamador le pone su span con
// `Effect.withSpan`, y el borde decide qué se loguea y qué se le dice al
// cliente con el Exit en la mano.

export class VdrDocumentCommandError extends Schema.TaggedError<VdrDocumentCommandError>()(
  'VdrDocumentCommandError',
  { cause: Schema.Defect() }
) {}

export const runVdrDocumentCommand = Effect.fn('Vdr.documentCommand')(function* <A>(
  command: () => Promise<A>
): Effect.fn.Return<A, VdrDocumentCommandError> {
  return yield* Effect.tryPromise({
    try: () => command(),
    catch: (cause) => new VdrDocumentCommandError({ cause }),
  })
})

/**
 * El rechazo original de una operación que falló, para el log del borde. Un
 * defecto —algo que se lanzó fuera del `tryPromise`— no tiene error tipado: ahí
 * se devuelve el Exit, que trae el Cause completo.
 */
export function vdrCommandCause(exit: Exit.Exit<unknown, VdrDocumentCommandError>): unknown {
  const failure = Exit.findErrorOption(exit)
  return Option.isSome(failure) ? failure.value.cause : exit
}

const decodeClassification = Schema.decodeUnknownOption(
  Schema.Literals(VDR_CLASSIFICATIONS.map((option) => option.value))
)

export function vdrClassificationOr(
  value: unknown,
  fallback: DocumentClassification
): DocumentClassification {
  const decoded = decodeClassification(value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

export function getClassificationOption(classification: DocumentClassification) {
  const fallback =
    VDR_CLASSIFICATIONS.find((option) => option.value === COMPANY_UPLOAD_DEFAULT_CLASSIFICATION) ??
    VDR_CLASSIFICATIONS[0]
  return VDR_CLASSIFICATIONS.find((option) => option.value === classification) ?? fallback
}

export function mapDemoVdrDocument(document: DemoDocument): VdrDocumentView {
  return { ...document, _id: document.id }
}

export type RoomQueryArgs = { companyId: Id<'companies'> }

// La sala es una por empresa: el scope ya no elige nada, pero el adaptador se
// queda como el único punto donde la pantalla arma los args de la consulta.
export function roomQueryArgs(companyId: Id<'companies'>, room: VdrRoomScope): RoomQueryArgs {
  void room
  return { companyId }
}
