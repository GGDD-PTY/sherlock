// ============================================================================
// Contrato: la vista de actividad del data room lee acotado y NO vigila
// ============================================================================
// Estos tests miran el CÓDIGO FUENTE de producción, no su comportamiento.
//
// Dos invariantes que un refactor bien intencionado rompería en silencio:
//
//  1. `getRoomActivity` es una suscripción reactiva: se vuelve a correr en CADA
//     acceso a esa sala. Un `.collect()` sobre `documentAccessLogs` convierte
//     una pantalla de lectura en un escaneo sin techo por evento.
//
//  2. La bitácora guarda `ipAddress`, `userAgent`, `reason`, `riskScore` y
//     `stepUpRequirement`. Eso es material de seguridad del equipo, no del
//     emisor. Proyectarlo convertiría "actividad" en vigilancia de contraparte.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { exportBlockWithSeam } from '../utils/convex-effect-seam'

const CONVEX_ROOT = path.resolve(__dirname, '../../../convex')

function readConvexFile(relativePath: string) {
  return fs.readFileSync(path.join(CONVEX_ROOT, relativePath), 'utf8')
}

function extractHandler(source: string, exportName: string) {
  // Cortar «hasta el siguiente export» arrastra los programas de OTROS exports,
  // que son `const` sin `export` y viven entre medio. `exportBlockWithSeam`
  // corta en la siguiente declaración de nivel superior y sigue el salto, así
  // que el bloque vuelve a ser el código que corre para este handler.
  const block = exportBlockWithSeam(source, exportName)
  expect(block, `no se encontró export const ${exportName}`).toBeDefined()
  return block as string
}

describe('actividad del data room: lecturas acotadas y proyección por lista blanca', () => {
  const queries = readConvexFile('_documents/queries.ts')
  const handler = extractHandler(queries, 'getRoomActivity')

  it('lee documentAccessLogs por el índice de empresa y acota con .take', () => {
    expect(handler).toContain("withIndex('by_companyId_accessedAt'")
    expect(handler).toContain('.take(ROOM_ACTIVITY_SCAN_CAP)')
    expect(handler).not.toMatch(/\.collect\(\)/)
  })

  it('nunca proyecta material de seguridad del equipo al emisor', () => {
    expect(handler).not.toMatch(/ipAddress/)
    expect(handler).not.toMatch(/userAgent/)
    expect(handler).not.toMatch(/riskScore/)
    expect(handler).not.toMatch(/stepUpRequirement/)
  })

  it('exige dueño de la empresa o admin antes de leer nada', () => {
    const authIndex = handler.indexOf('requireCompanyOwnerOrAdmin')
    const readIndex = handler.indexOf("query('documentAccessLogs')")

    expect(authIndex).toBeGreaterThan(-1)
    expect(readIndex).toBeGreaterThan(authIndex)
  })

  it('el esquema declara el índice de empresa sin tocar los existentes', () => {
    const schema = readConvexFile('schema.ts')

    expect(schema).toContain("index('by_companyId_accessedAt', ['companyId', 'accessedAt'])")
    expect(schema).toContain(
      "index('by_accessedById_action_accessedAt', ['accessedById', 'action', 'accessedAt'])"
    )
  })
})
