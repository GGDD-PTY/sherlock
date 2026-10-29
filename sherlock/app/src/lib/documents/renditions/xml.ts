// ============================================================================
// LECTOR XML MINIMO PARA PAQUETES OOXML
// ============================================================================
// Un `.pptx` / `.docx` es un ZIP de XML. Para producir la rendition PDF hay que
// recorrer ese XML, y regexes sobre marcado anidado se rompen en cuanto un
// atributo trae `>` o un texto trae `<`. Este lector hace un solo barrido y
// devuelve un arbol de nodos.
//
// Deliberadamente NO es un parser XML completo: no resuelve entidades exoticas,
// DTDs ni namespaces (los tags se guardan con su prefijo, que es justo lo que
// necesitan `a:t`, `w:p`, `p:sp`). Tampoco ejecuta nada: el resultado son datos.
//
// El XML lo escribio el archivo que subio un tercero, asi que es entrada no
// confiable: `parseXmlEffect` falla con `XmlParseError` —un fallo con nombre y
// con el motivo adentro— y `parseXml` conserva el `null` de siempre para los
// callers que ya lo tratan.
// ============================================================================

import { Effect, Schema } from 'effect'

export interface XmlNode {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: XmlNode[]
  /** Texto directo del nodo (concatenado, sin descendientes). */
  text: string
}

/** Por que un documento no produjo raiz. `EMPTY` es el prologo suelto o el
 *  archivo vacio; hoy es el unico motivo, y tiene nombre para que el caller no
 *  tenga que adivinar que significaba el `null`. */
const XmlParseFailureSchema = Schema.Literals(['EMPTY'])

export class XmlParseError extends Schema.TaggedError<XmlParseError>()('XmlParseError', {
  reason: XmlParseFailureSchema,
  message: Schema.String,
}) {}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

// Fuera de este rango `String.fromCodePoint` lanza `RangeError`. Un `&#x110000;`
// en un `.pptx` ajeno tumbaba el pipeline entero con una excepcion que nadie
// atrapaba; ahora la entidad se deja tal cual, que es lo que ya hace el lector
// con cualquier entidad que no reconoce.
const MAX_CODE_POINT = 0x10ffff

function fromCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_CODE_POINT
    ? String.fromCodePoint(code)
    : fallback
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), match)
    }
    if (entity.startsWith('#')) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), match)
    }
    return ENTITIES[entity] ?? match
  })
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match = pattern.exec(source)
  while (match) {
    attributes[match[1]] = decodeEntities(match[3] ?? match[4] ?? '')
    match = pattern.exec(source)
  }
  return attributes
}

function createNode(name: string, attributes: Record<string, string>): XmlNode {
  return { name, attributes, children: [], text: '' }
}

/**
 * Parsea un documento XML a un arbol de nodos. Devuelve el elemento raiz, o
 * `null` si el documento no trae ninguno (archivo vacio o solo prologo).
 */
export function parseXml(source: string): XmlNode | null {
  const root = createNode('#document', {})
  const stack: XmlNode[] = [root]
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) break

    if (open > index) {
      const chunk = source.slice(index, open)
      if (chunk.trim().length > 0 || chunk.includes(' ')) {
        stack[stack.length - 1].text += decodeEntities(chunk)
      }
    }

    // Comentarios, CDATA, prologo y declaraciones: se saltan enteros.
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open)
      const value = source.slice(open + 9, end === -1 ? source.length : end)
      stack[stack.length - 1].text += value
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      const end = source.indexOf('>', open)
      index = end === -1 ? source.length : end + 1
      continue
    }

    const close = source.indexOf('>', open)
    if (close === -1) break
    const inner = source.slice(open + 1, close)
    index = close + 1

    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }

    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameEnd = body.search(/[\s/]/)
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd)
    const node = createNode(name, nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd)))

    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root.children[0] ?? null
}

/**
 * La misma lectura, con el fallo tipado. `part` nombra la entrada dentro del
 * paquete para que la traza diga cual de los XML del `.pptx` no traia raiz.
 */
export const parseXmlEffect = Effect.fn('Xml.parse')(function* (
  part: string,
  source: string
): Effect.fn.Return<XmlNode, XmlParseError> {
  const root = parseXml(source)
  if (!root) {
    return yield* new XmlParseError({
      reason: 'EMPTY',
      message: `${part} no trae un elemento raiz.`,
    })
  }
  return root
})

/** Hijos directos con ese nombre (con prefijo de namespace, como en el XML). */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name)
}

/** Primer descendiente con ese nombre, en orden de documento. */
export function findDescendant(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (child.name === name) return child
    const nested = findDescendant(child, name)
    if (nested) return nested
  }
  return null
}

/** Todos los descendientes con ese nombre, en orden de documento. */
export function findDescendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  for (const child of node.children) {
    if (child.name === name) found.push(child)
    found.push(...findDescendants(child, name))
  }
  return found
}
