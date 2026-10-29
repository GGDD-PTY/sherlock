// ============================================================================
// Sherlock - HELPERS DE LECTURA EN LOTE
// ============================================================================
// Filtran los `null` que devuelve `ctx.db.get` y arman un Map por `_id` para
// búsquedas O(1).
// ============================================================================

import { Predicate } from 'effect'

export function filterExistingDocs<T>(docs: Array<T | null | undefined>): T[] {
  return docs.filter((doc): doc is T => Predicate.isNotNullish(doc))
}

export function mapExistingDocs<T extends { _id: string }>(
  docs: Array<T | null | undefined>
): Map<T['_id'], T> {
  const result = new Map<T['_id'], T>()

  for (const doc of filterExistingDocs(docs)) {
    result.set(doc._id, doc)
  }

  return result
}
