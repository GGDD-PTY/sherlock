// QUÉ PUEDE LLEVAR UN AVISO DE 5xx. Lo leen los dos cinturones: el lado app
// taja antes de mandar y Convex vuelve a tajar antes de persistir y de encolar
// el correo. Con dos copias de estas reglas, un día una taja menos que la otra.
// La ventana vive acá porque los dos lados la cortan — el proceso antes del
// round trip, Convex antes del correo — y desalinearlas rompe el conteo.
//
// LO QUE ESTE MÓDULO PROMETE, AHORA VERIFICADO. La promesa era «tachar dos veces
// devuelve el mismo texto», y hasta ahora nadie la comprobaba: el bucle de
// pasadas se rendía en el tope y devolvía el texto de la última pasada aunque
// todavía estuviera cambiando — o sea, con residuo sin tachar, camino al correo
// del equipo. Hoy el punto fijo es un `Schema.check`: un mensaje tachado es
// aquel que volver a tachar no cambia, y lo que no lo alcanza sale como el
// nombre genérico en vez de salir a medio tachar.

import { Schema } from 'effect'

export const SERVER_ERROR_ALERT_WINDOW_MS = 15 * 60 * 1000

export const SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH = 200
export const SERVER_ERROR_ALERT_MAX_NAME_LENGTH = 64
// 120 y no 200: el mensaje es texto libre y puede traer el nombre o la cédula
// que alguien interpoló al construir el error. PostHog guarda el mensaje entero
// para depurar; el aviso lleva lo mínimo para saber qué se rompió.
export const SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH = 120
export const SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH = 128
export const SERVER_ERROR_ALERT_MAX_DIGEST_LENGTH = 16

const REDACTED_EMAIL = '[correo]'
const REDACTED_TOKEN = '[token]'
const REDACTED_IDENTIFIER = '[dato]'
const DEFAULT_ERROR_NAME = 'ServerError'

// Un nombre propio no tiene forma reconocible, pero el campo que lo lleva sí:
// `nombre: Ana Robles`, `signatoryName="Ana Robles"` y el
// `{"signatoryName":"Ana Robles"}` que deja un `JSON.stringify` son la manera en
// que un dato de persona llega de verdad al mensaje de un error. Se taja el
// VALOR y se conserva la etiqueta, que es lo que sirve para depurar. Dos cosas
// que no se ven en el patrón: la clave puede venir entre comillas (JSON), y el
// valor sin comillas tiene que tragarse ENTEROS los marcadores que dejó el pase
// anterior — `[dato]`, `[token]` y `[correo]` — porque el mismo texto se taja
// dos veces, una en el proceso y otra en Convex, y una clase que corta en `]`
// deja `[dato]]` en el segundo pase. Los marcadores van literales en el patrón:
// si cambia alguna de las tres constantes, cambia también acá. El tope de 200
// es el del valor y va por encima del de 120 del mensaje: un valor que llega
// justo en el corte tiene que tacharse ENTERO antes de que el mensaje se acote,
// o el pase siguiente encuentra la cola sin tachar.
const NAME_FIELD_PATTERN =
  /["']?\b(nombres?|apellidos?|name|fullName|full_name|firstName|lastName|signatoryName|contacto|contact|titular|representante|beneficiario|usuario|user)\b["']?\s*[:=]\s*(?:"[^"\n]{0,200}"|'[^'\n]{0,200}'|(?:\[dato\]|\[token\]|\[correo\]|[^,;)\]}\n]){1,200})/gi

// Cédula panameña en sus formas reales: `8-123-4567` (natural), `PE-12-3456` y
// `E-8-12345` (panameño nacido en el exterior y extranjero residente),
// `N-19-1234` (naturalizado) y `8-NT-1-123` / `8-AV-1-234`, que meten las letras
// EN MEDIO. También cubre RUC (`1550821-1-704893`). Los tres grupos van hasta 7
// dígitos: acotar el del medio a 4 dejaba escapar `E-8-12345`.
const PANAMANIAN_ID_PATTERN =
  /\b(?:[A-Za-z]{1,3}-)?\d{1,7}-(?:[A-Za-z]{1,3}-)?\d{1,7}(?:-\d{1,7})?\b/g

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const TOKEN_PATTERN = /[A-Za-z0-9_-]{24,}/g
const PHONE_PATTERN = /\+?\d[\d().-]{6,}\d/g
const DIGIT_RUN_PATTERN = /\d{4,}/g

// EL ORDEN ES PARTE DE LA REGLA, no una lista cualquiera. El campo con nombre va
// PRIMERO: si el correo ya se tachó, su marcador se come el corchete de cierre
// al volver a tajar el valor del campo. La lista existe para que la pasada y la
// comprobación del punto fijo usen exactamente los mismos patrones — con dos
// copias, la comprobación aprobaría un residuo que la pasada sí tacha.
const REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: NAME_FIELD_PATTERN, replacement: `$1: ${REDACTED_IDENTIFIER}` },
  { pattern: EMAIL_PATTERN, replacement: REDACTED_EMAIL },
  { pattern: TOKEN_PATTERN, replacement: REDACTED_TOKEN },
  { pattern: PANAMANIAN_ID_PATTERN, replacement: REDACTED_IDENTIFIER },
  { pattern: PHONE_PATTERN, replacement: REDACTED_IDENTIFIER },
  { pattern: DIGIT_RUN_PATTERN, replacement: REDACTED_IDENTIFIER },
]

/** Una pasada de tachado, en el orden declarado, más el colapso de espacios. */
function scrubPass(message: string): string {
  const redacted = REDACTIONS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    message
  )
  return redacted.replace(/\s+/g, ' ').trim()
}

// EL PUNTO FIJO ES EL CONTRATO. «Tachado» no quiere decir «pasó por el tachador»:
// quiere decir que volver a tacharlo no lo cambia. Los dos lados tajan el mismo
// texto —el proceso antes de mandar, Convex antes de persistir— así que un texto
// que todavía se mueve es un texto con residuo esperando la pasada siguiente.
// El `Schema.check` no formatea el valor en ningún lado: se consulta con
// `Schema.is`, que devuelve un booleano y no arma un issue con el mensaje sin
// tachar adentro.
const RedactedAlertMessageSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter<string>((message) => scrubPass(message) === message))
)

const isFullyRedacted = Schema.is(RedactedAlertMessageSchema)

// LO QUE SE PUEDE TACHAR, SE TACHA; LO DEMÁS SE ACOTA. Un mensaje de error es
// texto libre y puede traer datos del cliente porque alguien los interpoló al
// construirlo. Correo, token, cédula panameña, RUC, teléfono, cualquier corrida
// larga de dígitos y el valor de un campo con nombre de persona salen por
// patrón. Un nombre suelto en medio de una frase no tiene patrón: contra eso
// vale el tope de 120 caracteres y que el mensaje entero se quede en PostHog.
// Es IDEMPOTENTE a propósito: el proceso taja antes de mandar y Convex vuelve a
// tajar antes de persistir, así que el segundo pase devuelve el mismo texto.
// La idempotencia se BUSCA, no se supone: una pasada puede dejar un marcador
// donde el patrón vecino todavía muerde, así que se repite hasta el punto fijo
// —dos pasadas iguales— con un tope de 3, que es lo que cuesta estabilizar los
// casos reales sin dejar que un texto patológico gire.
const SCRUB_MAX_PASSES = 3

export function scrubAlertMessage(message: string): string {
  let scrubbed = scrubPass(message)
  for (let pass = 1; pass < SCRUB_MAX_PASSES; pass += 1) {
    const next = scrubPass(scrubbed)
    if (next === scrubbed) break
    scrubbed = next
  }

  // Un texto que no llegó al punto fijo dentro del tope NO sale a medio tachar.
  // Antes salía: el bucle se rendía y devolvía la última pasada, que por
  // definición todavía tenía algo que el patrón siguiente iba a morder. Se
  // prefiere un aviso sin mensaje —el nombre del error y el requestId siguen
  // yendo, y PostHog guarda el mensaje entero— antes que un dato del cliente en
  // el correo del equipo.
  if (!isFullyRedacted(scrubbed)) return DEFAULT_ERROR_NAME

  return scrubbed || DEFAULT_ERROR_NAME
}

export function cappedAlertText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

// FNV-1a de 32 bits sobre el mensaje YA tachado. No es un control de seguridad:
// es la llave para juntar dos avisos cortados en el mismo punto y buscarlos en
// PostHog. Se calcula sobre el texto tachado a propósito, así no hay nada que
// invertir.
export function alertMessageDigest(scrubbed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < scrubbed.length; index += 1) {
    hash ^= scrubbed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
