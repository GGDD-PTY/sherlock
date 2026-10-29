// ============================================================================
// POLÍTICA DE TIPO DEL INTAKE TEMPORAL
// ============================================================================
// Qué Content-Type se le declara al proveedor para un archivo de la landing.
// La extensión sale del nombre que escribió el cliente: entrada ajena. Se
// estrecha contra el catálogo ANTES de tocar el mapa, porque indexar un objeto
// plano con un string ajeno devuelve miembros heredados —un archivo llamado
// `balance.constructor` sacaba la función `Object` de la tabla y la mandaba
// como Content-Type de la subida.
// ============================================================================

import { Schema } from 'effect'

const IntakeExtensionSchema = Schema.Literals([
  'pdf',
  'xls',
  'xlsx',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'csv',
])
const isIntakeExtension = Schema.is(IntakeExtensionSchema)

const TEMPORARY_INTAKE_CONTENT_TYPES: Readonly<Record<typeof IntakeExtensionSchema.Type, string>> =
  {
    pdf: 'application/pdf',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
  }

// Los navegadores no se ponen de acuerdo con el MIME de un .csv; el intake los
// colapsa a text/csv y el servidor inspecciona los bytes.
const CsvContentTypeAliasSchema = Schema.Literals([
  '',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
])
const isCsvContentTypeAlias = Schema.is(CsvContentTypeAliasSchema)

function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex < 0 ? '' : fileName.slice(dotIndex + 1).toLowerCase()
}

export function resolveTemporaryIntakeContentType(file: {
  name: string
  type: string
}): string | null {
  const extension = fileExtension(file.name)
  if (!isIntakeExtension(extension)) return null
  const expected = TEMPORARY_INTAKE_CONTENT_TYPES[extension]

  const declared = file.type.trim().toLowerCase()
  if (extension === 'csv') return isCsvContentTypeAlias(declared) ? 'text/csv' : null
  if (!declared) return expected
  return declared === expected ? expected : null
}
