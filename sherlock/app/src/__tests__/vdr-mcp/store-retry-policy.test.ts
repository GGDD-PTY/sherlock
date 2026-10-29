// @vitest-environment node
// ============================================================================
// VDR READ MCP — QUÉ SE REINTENTA Y QUÉ NO
// ============================================================================
// El cliente HTTP de Convex no acepta un AbortSignal, así que la cota de 8 s de
// `convexCall` abandona la promesa pero no cancela la mutación: del otro lado
// puede haber commiteado igual. Por eso el reintento solo vale para lo
// idempotente.
//
// `recordReadAuditFromServer` hace un insert pelado en `vdrReadAudits`, sin
// llave: reintentarlo deja dos filas para una sola invocación de tool y el
// registro cuenta de más. `writeTextIndexFromServer` hace upsert por
// `documentVersionId`, así que reintentarlo es inocuo y conserva sus dos
// reintentos, igual que las tres lecturas.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConvexVdrReadStore } from '@/lib/vdr-mcp/store'

const SECRET = 'x'.repeat(48)
const AUDIENCE = 'sherlock-dev/vdr-read'

/** Un fallo de transporte: el que `externalCall` marca como reintentable. */
function transportFailure(): Promise<never> {
  return Promise.reject(new Error('socket hang up'))
}

/** Corre la llamada hasta su fallo y devuelve la causa, sin dejarla escapar. */
async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (cause: unknown) => cause
  )
}

function storeWith(counts: { query: number; mutation: number }) {
  return createConvexVdrReadStore({
    client: {
      query: () => {
        counts.query += 1
        return transportFailure()
      },
      mutation: () => {
        counts.mutation += 1
        return transportFailure()
      },
      action: () => transportFailure(),
    },
  })
}

const AUDIT = {
  principalId: 'workos_owner',
  clientId: 'client_01ABC',
  tool: 'modelo_rango',
  argsSha256: 'a'.repeat(64),
  outcome: 'OK' as const,
}

const INDEX = {
  documentVersionId: 'documentVersion_1',
  sha256: 'b'.repeat(64),
  extractor: 'PDF' as const,
  pages: [{ n: 1, text: 'Ingresos' }],
  truncated: false,
}

describe('política de reintento del store del MCP', () => {
  beforeEach(() => {
    vi.stubEnv('VDR_MCP_SERVER_SECRET', SECRET)
    vi.stubEnv('VDR_MCP_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('la auditoría se intenta una sola vez: un reintento contaría dos veces la misma llamada', async () => {
    const counts = { query: 0, mutation: 0 }
    const store = storeWith(counts)
    expect(await failureOf(() => store.recordAudit(AUDIT))).toBeInstanceOf(Error)

    expect(counts.mutation).toBe(1)
  })

  it('el índice de texto sí reintenta, porque su mutación hace upsert', async () => {
    const counts = { query: 0, mutation: 0 }
    const store = storeWith(counts)
    expect(await failureOf(() => store.writeTextIndex(INDEX))).toBeInstanceOf(Error)

    expect(counts.mutation).toBe(3)
  })

  it('una lectura reintenta las mismas tres veces', async () => {
    const counts = { query: 0, mutation: 0 }
    const store = storeWith(counts)
    expect(
      await failureOf(() =>
        store.readTextIndex({
          documentVersionId: INDEX.documentVersionId,
          sha256: INDEX.sha256,
        })
      )
    ).toBeInstanceOf(Error)

    expect(counts.query).toBe(3)
  })
})
