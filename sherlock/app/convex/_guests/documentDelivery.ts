// ES: Contrato de la entrega de bytes a un invitado. Convex responde con el PDF
// en el cuerpo y con estos metadatos en UN header ASCII, porque `ctx.storage.getUrl`
// acuña una URL permanente y sin auth: si la URL sale del deployment sobrevive al
// NDA, a la sesión y a la revocación. Aquí no viaja ninguna URL.
// EN: the guest byte channel carries metadata in one header; no storage URL.

import { Option, Schema } from 'effect'

export const GUEST_DOCUMENT_METADATA_HEADER = 'x-sherlock-guest-document'
export const GUEST_DOCUMENT_CONTENT_TYPE = 'application/pdf'

function boundedField(maximum: number) {
  return Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, maximum)))
}

/**
 * La forma del header, en un solo lugar. Antes el tipo declaraba los campos y
 * una tabla `FIELD_LIMITS` aparte declaraba sus largos, y el decodificador
 * recorría esa tabla a mano: dos fuentes de verdad que coincidían de milagro.
 */
const CompanyGuestDocumentMetadataSchema = Schema.Struct({
  documentId: boundedField(128),
  versionId: boundedField(128),
  invitationId: boundedField(128),
  /** Email enmascarado del invitado: es lo único que la sala guarda en claro. */
  guestLabel: boundedField(200),
  fileName: boundedField(400),
})

export type CompanyGuestDocumentMetadata = typeof CompanyGuestDocumentMetadataSchema.Type

const decodeMetadata = Schema.decodeUnknownOption(CompanyGuestDocumentMetadataSchema)

export function encodeCompanyGuestDocumentMetadata(metadata: CompanyGuestDocumentMetadata): string {
  return encodeURIComponent(JSON.stringify(metadata))
}

export function decodeCompanyGuestDocumentMetadata(
  value: string | null | undefined
): CompanyGuestDocumentMetadata | null {
  if (!value) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(value))
  } catch {
    return null
  }

  return Option.getOrNull(decodeMetadata(parsed))
}
