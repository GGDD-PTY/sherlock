// ============================================================================
// Contrato: superficie pública mínima + lecturas acotadas en el backend Convex
// ============================================================================
// Estos tests miran el CÓDIGO FUENTE de producción, no su comportamiento. Su
// trabajo es impedir que vuelva a aparecer la CLASE de defecto, no solo la
// instancia que arreglamos hoy.
//
// Dos clases:
//
//  1. Superficie pública que no debería ser pública. Una `mutation` exportada
//     es direccionable por path desde cualquier cliente autenticado, aunque
//     nadie la llame. Las que escriben bitácoras de acceso sin rate limit son
//     amplificadores de escritura sobre la misma tabla que la clase 2 lee.
//
//  2. La tabla `documents` consultada sin índice. `.filter()` en Convex se
//     aplica DESPUÉS de leer, así que un `.query('documents').filter(...)` lee
//     la tabla entera. En `_markExpiredDocuments` eso no es un problema de
//     performance: cuando revienta, los documentos vencidos dejan de marcarse
//     y sus grants dejan de revocarse. Es un fallo de seguridad silencioso.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const CONVEX_ROOT = path.resolve(__dirname, '../../../convex')

function readConvexFile(relativePath: string) {
  return fs.readFileSync(path.join(CONVEX_ROOT, relativePath), 'utf8')
}

function listConvexSources(): string[] {
  const files: string[] = []
  const visit = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // `_generated/` es artefacto; los seeds son dev-only y no corren en
      // producción, así que su costo de lectura no afecta a ningún usuario.
      if (entry.name === '_generated') continue
      if (entry.name.startsWith('seed')) continue
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relativePath)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relativePath)
    }
  }
  visit(CONVEX_ROOT, '')
  return files.sort()
}

describe('superficie pública de documents', () => {
  it('no expone mutations que escriban bitácoras de acceso ni borren blobs', async () => {
    const documentMutations = await import('../../../convex/_documents/mutations')
    const documentsFacade = await import('../../../convex/documents')

    // `logAccess` insertaba en `documentAccessLogs` sin pasar por
    // `enforceRateLimit` — el módulo ni siquiera importa el helper, a
    // diferencia de `_documents/storage.ts`. Cero callers de producción.
    expect(documentMutations).not.toHaveProperty('logAccess')
    expect(documentsFacade).not.toHaveProperty('logAccess')

    // `deleteStorageFile` borraba el blob sin la guarda de documento
    // referenciado que sí tiene su gesamplefoods interno, y se tragaba el error.
    expect(documentMutations).not.toHaveProperty('deleteStorageFile')
    expect(documentsFacade).not.toHaveProperty('deleteStorageFile')

    // El camino legítimo sigue existiendo.
    expect(documentMutations).toHaveProperty('deleteStorageFileInternal')
  })
})

describe('lecturas acotadas sobre tablas que crecen sin techo', () => {
  it('nunca consulta la tabla documents sin índice', () => {
    // Convex aplica `.filter()` después de leer: sin `.withIndex()` la consulta
    // recorre la tabla completa.
    const violations: string[] = []

    for (const relativePath of listConvexSources()) {
      const source = readConvexFile(relativePath)
      const lines = source.split('\n')

      lines.forEach((line, index) => {
        if (!line.includes(".query('documents')")) return
        // El encadenamiento suele partirse en varias líneas; basta con mirar la
        // ventana siguiente para saber si el primer eslabón es withIndex.
        const window = lines.slice(index, index + 3).join('\n')
        const afterQuery = window.slice(window.indexOf(".query('documents')"))
        if (!/\.withIndex\(/.test(afterQuery)) {
          violations.push(`${relativePath}:${index + 1}`)
        }
      })
    }

    expect(violations).toEqual([])
  })

  it('_markExpiredDocuments usa by_expiresAt y acota el rango por abajo', () => {
    const source = readConvexFile('_documents/internals.ts')

    expect(source).toContain("withIndex('by_expiresAt'")
    // `undefined` ordena antes que cualquier número, así que un `lt(now)` a
    // secas barrería todos los documentos SIN vencimiento y los marcaría
    // vencidos. La cota inferior no es cosmética.
    expect(source).toMatch(/gte\('expiresAt',\s*0\)/)
  })

  it('documentAccessLogs indexa (accessedById, action, accessedAt)', () => {
    const schema = readConvexFile('schema.ts')

    expect(schema).toContain(
      "index('by_accessedById_action_accessedAt', ['accessedById', 'action', 'accessedAt'])"
    )
    // Los índices existentes siguen: otras rutas dependen de ellos.
    expect(schema).toContain("index('by_documentId', ['documentId'])")
    expect(schema).toContain("index('by_accessedById', ['accessedById'])")
  })
})
