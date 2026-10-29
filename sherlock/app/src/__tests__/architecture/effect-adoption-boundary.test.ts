import fs from 'node:fs'
import path from 'node:path'

import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SRC_ROOT = path.join(APP_ROOT, 'src')
const CONVEX_ROOT = path.join(APP_ROOT, 'convex')
const EFFECT_IMPORT = /from\s+['"]effect(?:\/[^'"]*)?['"]/
const ZOD_IMPORT = /from\s+['"]zod['"]/

function filesUnder(root: string, accepts: (file: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(file, accepts))
    else if (accepts(file)) files.push(file)
  }
  return files
}

function relative(file: string): string {
  return path.relative(APP_ROOT, file)
}

function source(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

describe('Effect adoption boundary', () => {
  it.effect('keeps every Next route handler on Effect', () =>
    Effect.sync(() => {
      const routes = filesUnder(path.join(SRC_ROOT, 'app'), (file) => file.endsWith('route.ts'))
      const missing = routes
        .filter((file) => !EFFECT_IMPORT.test(source(file)))
        .map((file) => relative(file))

      assert.strictEqual(routes.length, 41)
      assert.deepStrictEqual(missing, [])
    })
  )

  // React ya no está excluido. La decisión [F] del 2026-09-08 21:22 borra las
  // dos exclusiones que traía el plan, y el invariante de `CLAUDE.md` se
  // actualizó con ella. Lo que queda pinneado es
  // la regla que sí sigue viva: un componente o un hook no puede devolverle a
  // React un `Effect` sin correr, así que el programa se corre en el borde —
  // dentro de un handler, un `useEffect` o un `useCallback`— y nunca en el
  // cuerpo del módulo, donde correría al importar el chunk.
  it.effect('runs Effect at the edge in React, never at module scope', () =>
    Effect.sync(() => {
      const react = filesUnder(SRC_ROOT, (file) => {
        const rel = relative(file)
        return file.endsWith('.tsx') || rel.includes('/hooks/') || rel.includes('/stores/')
      })

      const violations = react
        .filter((file) => {
          // Una llamada a `Effect.run*` sin sangría está en el cuerpo del
          // módulo: corre cuando el navegador evalúa el chunk, antes de que
          // React monte nada.
          return /^(?:const|let|var|export)\s[^\n]*\bEffect\.run(?:Promise|Sync|Fork)/m.test(
            source(file)
          )
        })
        .map((file) => relative(file))

      assert.deepStrictEqual(violations, [])
    })
  )

  // Convex ya no está en esta lista. La decisión [F] del 2026-09-08 21:22
  // («Convex entra») supersede la exclusión que traía el plan de adopción: se verificó contra los docs de las dos partes que el
  // runtime por defecto de Convex soporta las librerías de Workers, y el único
  // fallo documentado (Effect #6651, el `setTimeout` del scheduler) se cerró en
  // `4.0.0-rc.108`. Lo que queda pinneado es lo que sí sigue siendo cierto: el
  // aislado de Convex tiene una sola costura con el runtime de Effect, y nadie
  // la abre por su cuenta.
  it.effect('keeps the Convex runtime seam in a single file', () =>
    Effect.sync(() => {
      const runners = filesUnder(CONVEX_ROOT, (file) => file.endsWith('.ts'))
        .filter((file) => /Effect\.run(Promise|Sync|Fork)/.test(source(file)))
        .map((file) => relative(file))

      assert.deepStrictEqual(runners, ['convex/_helpers/effect.ts'])
    })
  )

  // `convex/_generated/` lo escribe el codegen de Convex y CLAUDE.md prohíbe
  // editarlo: Effect nunca entra ahí.
  it.effect('never lets Effect reach the Convex codegen', () =>
    Effect.sync(() => {
      const generated = filesUnder(path.join(CONVEX_ROOT, '_generated'), (file) =>
        file.endsWith('.ts')
      )
        .filter((file) => EFFECT_IMPORT.test(source(file)))
        .map((file) => relative(file))

      assert.deepStrictEqual(generated, [])
    })
  )

  it.effect('keeps zod out of production TypeScript outside React and Convex', () =>
    Effect.sync(() => {
      const files = filesUnder(SRC_ROOT, (file) => {
        const rel = relative(file)
        return (
          file.endsWith('.ts') &&
          !rel.includes('/__tests__/') &&
          !rel.includes('/components/') &&
          !rel.includes('/hooks/')
        )
      })
      const violations = files
        .filter((file) => ZOD_IMPORT.test(source(file)))
        .map((file) => relative(file))

      assert.deepStrictEqual(violations, [])
    })
  )

  it.effect('pins Effect and its test runner to the same version', () =>
    Effect.sync(() => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')
      ) as {
        dependencies: Record<string, string>
        devDependencies: Record<string, string>
      }

      assert.strictEqual(packageJson.dependencies.effect, '4.0.0-rc.112')
      assert.strictEqual(
        packageJson.devDependencies['@effect/vitest'],
        packageJson.dependencies.effect
      )
    })
  )
})
