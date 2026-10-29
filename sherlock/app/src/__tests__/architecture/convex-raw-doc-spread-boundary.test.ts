// ============================================================================
// CONVEX RAW-DOC SPREAD BOUNDARY
// ============================================================================
// convex/AGENTS.md: "Anonymous teaser output is an explicit whitelist. Never
// spread a raw company or investor document into a public response."
//
// `ndas.getByInvestor` (retirado con el rol INVESTOR, [F] 2026-09-16) broke
// both halves of that rule: it returned
// `{ ...nda, company: <fila cruda> }`, so the counterparty document AND the
// signature telemetry (ipAddress, userAgent, revokedReason) reached the browser,
// one gate before `canRevealDealDeskIdentity` allows identity.
//
// This is the check that survives someone "optimizing" the projection back into
// a spread: the whitelist itself lives in the handler tests, and the shape of
// the code lives here.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'


const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')
const DOCUMENT_QUERIES_PATH = path.join(APP_ROOT, 'convex', '_documents', 'queries.ts')
const DOCUMENTS_FACADE_PATH = path.join(APP_ROOT, 'convex', 'documents.ts')

// Se mira CÓDIGO, no prosa: los comentarios de estos archivos citan a propósito
// las formas que quedaron prohibidas.
const isComment = (line: string) =>
  line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')

function codeLines(content: string): Array<{ line: string; number: number }> {
  return content
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !isComment(line))
}

describe('convex raw-doc spread boundary', () => {
  // El mismo argumento que borró `ndas.getByCompany` y `ndas.getNDA`: cero
  // callers de producción y una fila cruda de `documentAccessLogs` (ipAddress,
  // userAgent, riskScore, reason) MÁS el profile crudo de la contraparte,
  // devueltos a cualquier owner. La vista viva y proyectada por lista blanca es
  // `getRoomActivity`; re-exportar la vieja bitácora reabriría la fuga.
  it('keeps the unused, raw-row per-document access log out of the API surface', () => {
    const queriesCode = codeLines(fs.readFileSync(DOCUMENT_QUERIES_PATH, 'utf8'))
    const facadeCode = codeLines(fs.readFileSync(DOCUMENTS_FACADE_PATH, 'utf8'))

    const offenders = [...queriesCode, ...facadeCode].filter(({ line }) =>
      /\bgetAccessLogs\b/.test(line.split('//')[0])
    )
    expect(offenders).toEqual([])

    // El camino vivo del emisor sigue existiendo.
    expect(fs.readFileSync(DOCUMENT_QUERIES_PATH, 'utf8')).toMatch(/export const getRoomActivity\b/)
    expect(fs.readFileSync(DOCUMENTS_FACADE_PATH, 'utf8')).toMatch(/getRoomActivity/)
  })

  // El guard anterior sólo miraba el bloque de `getByInvestor`, así que nunca
  // habría visto `getExpiringNdas` devolviendo `{ ...nda, investor, company }`
  // — la misma clase de defecto, en el mismo archivo, a tres exports de
  // distancia. La frontera es el ARCHIVO — y ya no solo ndas.ts: la cola de
  // review de documentos repitió el patrón, así que ambos módulos que arman
  // respuestas con filas de compañía / inversionista / documento / log quedan
  // bajo el mismo contrato: ninguna respuesta se arma spreadeando una fila
  // cruda, esté o no gateada por admin.
  it('never spreads a raw NDA, document, log, company or investor row in the gated surfaces', () => {
    const GUARDED_FILES = [
      { label: 'convex/_documents/queries.ts', filePath: DOCUMENT_QUERIES_PATH },
    ]
    // Sin flag `g` a propósito: `RegExp.test` con `g` es stateful (`lastIndex`)
    // y se saltaría una de cada dos líneas infractoras.
    const RAW_DOC_SPREAD =
      /\.\.\.\s*(nda|company|investor|deal|generatedNda|investorProfile|owner|document|log|latestReviewLog|grant)\b/

    const violations = GUARDED_FILES.flatMap(({ label, filePath }) =>
      codeLines(fs.readFileSync(filePath, 'utf8'))
        .filter(({ line }) => RAW_DOC_SPREAD.test(line.split('//')[0]))
        .map(({ line, number }) => `${label}:${number}: ${line}`)
    )

    expect(violations).toEqual([])
  })
})
