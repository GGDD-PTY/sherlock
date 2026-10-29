// ============================================================================
// CONTRATO DE LA SALA DEL INVITADO
// ============================================================================
// El invitado externo no tiene cuenta: entra con OTP y NDA, y lo único que el
// navegador recibe de la sala es este JSON. Es la superficie con más entrada no
// confiable del frontend, así que el contrato se declara una vez y todo lo que
// no cuadre se descarta entero.
//
// ===== LA COSTURA CON EFFECT =====
// Esto validaba con zod. Ahora valida con `effect/Schema`, el validador del
// proyecto desde la decisión [F] del 2026-09-08.
//
// El `.strict()` que zod pedía objeto por objeto se volvió una sola opción de
// decodificación, `onExcessProperty: 'error'`, que aplica a todo el árbol: una
// clave de más en cualquier nivel sigue tumbando la respuesta completa.
//
// `errors: 'all'` **no** va acá a propósito. Esa opción existe para formularios,
// donde el usuario tiene que ver todos sus campos malos de una vez; acá no hay
// nada que mostrar —la respuesta se acepta o se descarta— y parar en el primer
// problema es lo correcto.
// ============================================================================

import { Option, Schema } from 'effect'

/** Texto recortado, no vacío y con techo. El techo es del servidor, no del DOM. */
const boundedText = (max: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)))

const boundedInt = (min: number, max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(min), Schema.isLessThanOrEqualTo(max)))

const documentSchema = Schema.Struct({
  viewPath: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isPattern(/^\/api\/vdr\/guest\/documents\/[a-zA-Z0-9_-]+$/))
    )
  ),
  name: boundedText(500),
  fileType: Schema.optionalKey(boundedText(200)),
  fileSize: Schema.optionalKey(boundedInt(0, 2_147_483_648)),
  folder: boundedText(200),
  classification: Schema.Literals(['PUBLIC_TEASER', 'CONFIDENTIAL', 'RESTRICTED', 'LEGAL']),
  downloadable: Schema.Literal(false),
})

const authorizedRoomSchema = Schema.Struct({
  authenticated: Schema.Literal(true),
  expiresAt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  roomAccessGranted: Schema.Literal(true),
  requiredGates: Schema.Tuple([]),
  room: Schema.Struct({ title: boundedText(300) }),
  documents: Schema.Array(documentSchema).pipe(Schema.check(Schema.isMaxLength(500))),
  documentsTruncated: Schema.Boolean,
  downloadDeliveryAvailable: Schema.Literal(false),
  requestId: boundedText(200),
})

export type GuestRoomDocument = typeof documentSchema.Type
export type GuestRoom = {
  title: string
  documents: readonly GuestRoomDocument[]
  documentsTruncated: boolean
}

// Una clave de más en cualquier nivel es una respuesta que no es la nuestra.
const decodeAuthorizedRoom = Schema.decodeUnknownOption(authorizedRoomSchema, {
  onExcessProperty: 'error',
})

export function parseGuestAuthorizedRoom(value: unknown): GuestRoom | null {
  const decoded = Option.getOrNull(decodeAuthorizedRoom(value))
  if (!decoded) return null
  return {
    title: decoded.room.title,
    documents: decoded.documents,
    documentsTruncated: decoded.documentsTruncated,
  }
}
