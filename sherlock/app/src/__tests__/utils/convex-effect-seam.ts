// ============================================================================
// LEER CÓDIGO DE CONVEX QUE PASÓ POR LA COSTURA DE EFFECT
// ============================================================================
// Varios tests de este repo auditan `convex/` leyendo su texto: exigen que un
// handler contenga `requireAuth(ctx)`, que la lectura del objetivo venga
// después de la guarda, que un campo no se lea de `args`. Son la red que
// impide que una mutation sin guarda llegue a producción.
//
// La costura de `convex/_helpers/effect.ts` mueve el cuerpo del handler fuera
// del bloque que esos tests leen. El registro queda en una línea:
//
//   export const foo = mutation({
//     args: { ... },
//     handler: (ctx, args) => runConvex(fooProgram(ctx, args)),
//   })
//
// y la guarda vive dentro de `fooProgram`, declarado más arriba. Un test que
// solo lea el bloque del registro diría que la guarda desapareció cuando lo
// único que pasó es que se mudó de bloque.
//
// La respuesta correcta no es meter esos handlers en una allowlist: eso apaga
// la red. Es seguir el salto. Este módulo hace eso y nada más, para que la
// lógica viva en un solo sitio y el próximo test que audite texto de Convex la
// tenga sin copiarla.
// ============================================================================

/**
 * Los programas Effect declarados en un archivo, indexados por nombre.
 *
 * El cuerpo de cada uno llega hasta la siguiente declaración de nivel
 * superior, que es la cota que impone Prettier con su indentación.
 */
export function collectEffectPrograms(source: string): Map<string, string> {
  const topLevel = /^(?:export )?(?:const|let|var|function|async function|class|type|interface) /gm
  const boundaries: number[] = []
  let edge: RegExpExecArray | null

  while ((edge = topLevel.exec(source)) !== null) {
    boundaries.push(edge.index)
  }

  const programs = new Map<string, string>()
  const declaration = /^(?:export )?const (\w+) = Effect\.fn[(<]/gm
  let match: RegExpExecArray | null

  while ((match = declaration.exec(source)) !== null) {
    const start = match.index
    const end = boundaries.find((index) => index > start)

    programs.set(match[1], source.slice(start, end ?? source.length))
  }

  return programs
}

/**
 * Los nombres de programa a los que delega un bloque.
 *
 * No se adivina la sintaxis de la llamada. Un programa se invoca de al menos
 * tres formas: `runConvex(foo(` en el registro, `yield* foo(` dentro de otro
 * programa, y suelto dentro de otra combinación, como
 * `Effect.forEach(rows, (row) => foo(ctx, row))`. Anclar en las dos primeras
 * dejaba fuera la tercera, que es donde `deliverables.ts` puso su proyección
 * por lista blanca, y el test que la vigila se quedaba sin nada que leer.
 *
 * Se busca al revés: se recorren los programas que el archivo declara y se
 * conserva el que aparece llamado en este bloque. No puede confundir un
 * programa con otra función, porque los nombres salen de las declaraciones
 * `Effect.fn` del propio archivo.
 */
export function delegatedProgramNames(
  block: string,
  programs: ReadonlyMap<string, string>
): string[] {
  return [...programs.keys()].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(block))
}

/**
 * Todo el código que corre cuando se invoca un export: su bloque más el cuerpo
 * de cada programa Effect al que delega, transitivamente.
 *
 * Sigue valiendo lo que estos tests siempre midieron. El token esperado tiene
 * que estar en el código que de verdad corre para ese handler, no en cualquier
 * parte del módulo.
 */
export function reachableSource(block: string, programs: ReadonlyMap<string, string>): string {
  const reached: string[] = [block]
  const visited = new Set<string>()
  const pending: string[] = [block]

  while (pending.length > 0) {
    const current = pending.pop() as string

    for (const name of delegatedProgramNames(current, programs)) {
      if (visited.has(name)) continue
      visited.add(name)

      const body = programs.get(name)
      if (body === undefined) continue

      reached.push(body)
      pending.push(body)
    }
  }

  return reached.join('\n')
}

/** Atajo para el caso corriente: un bloque y el archivo del que salió. */
export function reachableFrom(block: string, source: string): string {
  return reachableSource(block, collectEffectPrograms(source))
}

/**
 * El bloque de un export MÁS el código al que delega, sin arrastrar lo que hay
 * entre él y el siguiente export.
 *
 * Los extractores del repo cortan «desde `export const X =` hasta el siguiente
 * `export const`». Con la costura eso ya no es el bloque de `X`: entre medio
 * viven los programas de OTROS exports, que son `const` sin `export`. Un test
 * que afirma «el bloque de `create` NO lee `args.userId`» empezó a fallar
 * porque el corte se tragaba el programa de `getByUserId`, que sí lo lee y con
 * razón.
 *
 * Este corte llega hasta la siguiente declaración de nivel superior, sea o no
 * un export, y después sigue la costura. Así el bloque vuelve a ser lo que el
 * test siempre quiso medir: el código que corre cuando llamas a `X`.
 */
export function exportBlockWithSeam(source: string, exportName: string): string | undefined {
  const start = source.indexOf(`export const ${exportName} =`)
  if (start === -1) return undefined

  const topLevel = /^(?:export )?(?:const|let|var|function|async function|class|type|interface) /gm
  topLevel.lastIndex = start + 1

  const next = topLevel.exec(source)
  const block = source.slice(start, next?.index ?? source.length)

  return reachableFrom(block, source)
}
