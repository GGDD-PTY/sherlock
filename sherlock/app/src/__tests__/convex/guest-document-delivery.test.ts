// ============================================================================
// CANDADO: EL HEADER DE ENTREGA AL INVITADO NO ES UN CANAL DE CONFIANZA
// ============================================================================
// Convex manda los bytes y UN header ASCII con metadatos. Next los decodifica
// antes de servir: de ahí salen el nombre del archivo en Content-Disposition y
// la identidad que la sala le muestra al invitado. Un header ausente, truncado,
// con un campo vacío o más largo que el contrato tiene que fallar cerrado (la
// ruta responde 502): si no, un header manipulado renombra el documento o le
// atribuye la descarga a otra persona en la bitácora. Los bytes salen sin sello
// desde [F] 2026-09-04, así que el header es el único metadato que viaja.
// El happy-path ya vive en http.test.ts; aquí se pinnean los rechazos.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  decodeCompanyGuestDocumentMetadata,
  encodeCompanyGuestDocumentMetadata,
  type CompanyGuestDocumentMetadata,
} from '../../../convex/_guests/documentDelivery'

const VALID: CompanyGuestDocumentMetadata = {
  documentId: 'doc_selected',
  versionId: 'version_selected',
  invitationId: 'invitation_1',
  guestLabel: 'g***t@example.com',
  fileName: 'Estados financieros.pdf',
}

describe('company guest document metadata', () => {
  it('round-trips the authorized payload, including accented file names', () => {
    expect(decodeCompanyGuestDocumentMetadata(encodeCompanyGuestDocumentMetadata(VALID))).toEqual(
      VALID
    )
  })

  it.each([
    ['missing', null],
    ['empty', ''],
    ['not json', 'not-json'],
    ['an array', encodeURIComponent('[]')],
    ['a string', encodeURIComponent('"doc_selected"')],
    ['truncated percent-encoding', encodeURIComponent(JSON.stringify(VALID)).slice(0, 12)],
  ])('rejects %s', (_name, value) => {
    expect(decodeCompanyGuestDocumentMetadata(value)).toBeNull()
  })

  it.each(['documentId', 'versionId', 'invitationId', 'guestLabel', 'fileName'] as const)(
    'rejects a payload whose %s is missing, empty or the wrong type',
    (field) => {
      const withoutField: Record<string, string> = { ...VALID }
      delete withoutField[field]
      expect(
        decodeCompanyGuestDocumentMetadata(encodeURIComponent(JSON.stringify(withoutField)))
      ).toBeNull()

      expect(
        decodeCompanyGuestDocumentMetadata(
          encodeURIComponent(JSON.stringify({ ...VALID, [field]: '' }))
        )
      ).toBeNull()

      expect(
        decodeCompanyGuestDocumentMetadata(
          encodeURIComponent(JSON.stringify({ ...VALID, [field]: 1 }))
        )
      ).toBeNull()
    }
  )

  it('rejects a field that exceeds its documented limit', () => {
    expect(
      decodeCompanyGuestDocumentMetadata(
        encodeURIComponent(JSON.stringify({ ...VALID, documentId: 'd'.repeat(129) }))
      )
    ).toBeNull()
    expect(
      decodeCompanyGuestDocumentMetadata(
        encodeURIComponent(JSON.stringify({ ...VALID, guestLabel: 'g'.repeat(201) }))
      )
    ).toBeNull()
    expect(
      decodeCompanyGuestDocumentMetadata(
        encodeURIComponent(JSON.stringify({ ...VALID, fileName: `${'n'.repeat(401)}.pdf` }))
      )
    ).toBeNull()
  })
})
