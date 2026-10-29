// Un dispositivo reparte 3 votos entre funciones DISTINTAS, uno por función.
// No es un tope por tarjeta: si fuera por tarjeta, un visitante podría votar
// todo el tablero y la señal que la página existe para recoger — qué es lo más
// importante — se perdería, porque "todo importa" no ordena nada.

import { Schema } from 'effect'

export const VOTED_FEATURES_CAP = 3
export const FEATURE_TOTAL_BREAKER = 5000
export const REQUESTS_GLOBAL_BREAKER = 500
export const REQUESTS_PER_DEVICE_PER_DAY = 5
// Alineado con `SUPPORT_MESSAGE_MAX_LENGTH` y con el `maxLength` del textarea
// del hub de ayuda: antes el cliente podía escribir 2 000 caracteres y el
// servidor guardaba 500 truncando en silencio, reportando éxito.
export const REQUEST_BODY_MAX_LENGTH = 2_000

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g
const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/g
// El tsconfig principal apunta a ES2017 y no excluye este módulo cuando un test
// lo arrastra por import: `\p{L}` no compila ahí, así que la puntuación se
// borra con una clase explícita en vez de conservar letras por whitelist.
const PUNCTUATION_PATTERN = /[!-\/:-@[-`{-~\u00a1\u00ab\u00bb\u00bf\u2010-\u205e]/g
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9-]{16,64}$/

// Palabras que aparecen en casi toda petición y no dicen NADA del tema. Sin
// filtrarlas, dos peticiones opuestas se leen como la misma: "quiero app de
// iphone" y "quiero app de android" comparten `quiero/app/de` y midieron 0.667
// de solapamiento — suficiente para que el tablero le dijera al visitante que
// ya existía su petición cuando no existía. El texto corto es justo donde las
// palabras función dominan el conteo, y una petición de roadmap siempre es
// texto corto.
const STOPWORDS = new Set([
  // es
  'a',
  'agregar',
  'al',
  'algo',
  'anadir',
  'como',
  'con',
  'cosa',
  'cuando',
  'de',
  'deberia',
  'debria',
  'del',
  'donde',
  'el',
  'ella',
  'ellos',
  'en',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'estaria',
  'este',
  'esto',
  'favor',
  'gustaria',
  'hacer',
  'hay',
  'la',
  'las',
  'le',
  'lo',
  'los',
  'mas',
  'me',
  'mi',
  'mucho',
  'muy',
  'necesito',
  'no',
  'nos',
  'nuestra',
  'nuestro',
  'o',
  'otra',
  'otro',
  'para',
  'pero',
  'poder',
  'podria',
  'por',
  'porfa',
  'porque',
  'puedo',
  'que',
  'queria',
  'quiero',
  'quisiera',
  'se',
  'ser',
  'seria',
  'si',
  'sin',
  'sobre',
  'su',
  'sus',
  'tambien',
  'te',
  'tener',
  'tenga',
  'tiene',
  'toda',
  'todas',
  'todo',
  'todos',
  'un',
  'una',
  'unas',
  'uno',
  'unos',
  'y',
  'ya',
  'yo',
  // en
  'add',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'get',
  'give',
  'has',
  'have',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'like',
  'make',
  'my',
  'need',
  'of',
  'on',
  'or',
  'please',
  'should',
  'so',
  'some',
  'thing',
  'this',
  'to',
  'want',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
  'you',
  'your',
  // ambiguas en los dos idiomas
  'son',
  'the',
  'their',
  'them',
  'then',
  'there',
  'that',
])

export function normalizeRequestBody(raw: string): string {
  const collapsed = raw.replace(CONTROL_CHARACTER_PATTERN, ' ').replace(/\s+/g, ' ').trim()

  return collapsed.length > REQUEST_BODY_MAX_LENGTH
    ? collapsed.slice(0, REQUEST_BODY_MAX_LENGTH).trim()
    : collapsed
}

export function normalizedDedupeKey(body: string): string {
  const tokens = [
    ...new Set(
      body
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARK_PATTERN, '')
        .replace(PUNCTUATION_PATTERN, '')
        .split(/\s+/)
        .filter((token) => token.length > 0)
    ),
  ]

  const content = tokens.filter((token) => !STOPWORDS.has(token))

  // Una petición hecha sólo de palabras función ("por favor", "please") no
  // tiene tema que extraer. Conservar los tokens crudos es lo único que la
  // distingue de cualquier otra petición igual de vacía; colapsarlas todas a
  // la cadena vacía las volvería duplicados entre sí.
  return (content.length > 0 ? content : tokens).sort().join(' ')
}

// El token del dispositivo es la ÚNICA llave del tope de tres votos y del
// límite diario de peticiones: es un identificador opaco que el navegador
// genera y manda sin sesión. Su forma es el schema, no un `test()` suelto — el
// mismo `DeviceTokenSchema` puede decodificar donde haga falta y el guarda
// booleano que ya usan los callers se queda con su firma.
const DeviceTokenSchema = Schema.String.pipe(Schema.check(Schema.isPattern(DEVICE_TOKEN_PATTERN)))

const isDeviceToken = Schema.is(DeviceTokenSchema)

export function isValidDeviceToken(token: string): boolean {
  return isDeviceToken(token)
}
