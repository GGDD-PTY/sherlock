import { Option, Schema } from 'effect'

// Un teléfono de contacto usable: cabe en el campo, solo trae caracteres de
// marcado, y tiene entre 7 y 15 dígitos reales (el rango de E.164). Las tres
// condiciones viven en un solo schema en vez de tres `if` sueltos.
const hasDialableDigitCount = (value: string): value is string => {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

const ContactPhone = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(50), Schema.isPattern(/^\+?[0-9().\s-]+$/)),
  Schema.refine(hasDialableDigitCount)
)

const decodeContactPhone = Schema.decodeUnknownOption(ContactPhone)

export function normalizeContactPhone(value: string): string | null {
  return Option.getOrNull(decodeContactPhone(value.trim()))
}
