import { Option, Schema } from 'effect'

// Normalizador único del nombre de empresa. Lo comparten el claim del intake
// (que aplica el nombre declarado en /mycroft) y las mutations internas de
// operación, para que no existan dos ideas distintas de "nombre válido".

// Mismo techo que `INTAKE_MAX_NAME_LENGTH` (`convex/_intake/model.ts`): el
// nombre viaja desde el formulario de /mycroft hasta la fila de `companies`,
// así que un valor aceptado en la sala temporal tiene que caber en la empresa.
export const COMPANY_NAME_MAX_LENGTH = 120

// Qué cuenta como nombre, en un solo lugar: no vacío, dentro del techo, y sin
// caracteres de control (que un cliente puede usar para romper un render o para
// falsear una línea de auditoría).
const CompanyName = Schema.String.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(COMPANY_NAME_MAX_LENGTH),
    Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/)
  )
)

const decodeCompanyName = Schema.decodeUnknownOption(CompanyName)

/**
 * Devuelve el nombre listo para persistir, o `undefined` cuando el valor no
 * sirve como nombre de empresa. No lanza: el llamador decide si un valor
 * inválido es un error (operación manual) o algo que simplemente se ignora
 * (el claim, donde el nombre no debe costarle al cliente sus documentos).
 */
export function normalizeCompanyName(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  return Option.getOrUndefined(decodeCompanyName(normalized))
}
