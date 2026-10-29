// ============================================================================
// EL SUBSISTEMA DE TRANSACCIONES NO VUELVE
// ============================================================================
// [F] 2026-09-17 00:10: «todo el camino muerto de deal está muerto en prod,
// deal, dealrooms, etc... borra todo eso. no quiero excusas. bórralo. no
// quiero nada innecesario aquí.»
//
// Las 21 tablas salieron con cero filas en producción. Este candado reemplaza a
// `vdr-deal-access-schema-boundary` y `vdr-deal-access-dual-write-boundary`: en
// vez de describir cómo se comportaba el ciclo de acceso por transacción, exige
// que no exista. Lee el schema como TEXTO a propósito — un `defineTable` nuevo
// con uno de estos nombres tiene que romper acá aunque compile.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const CONVEX_ROOT = path.join(APP_ROOT, 'convex')
const SCHEMA_PATH = path.join(CONVEX_ROOT, 'schema.ts')

/** Las 21 tablas retiradas. Ninguna puede volver a definirse. */
const RETIRED_TABLES = [
  'deals',
  'dealRooms',
  'dealAccessCycles',
  'dealAccessEvents',
  'roomGrants',
  'guestGroups',
  'guestGroupMemberships',
  'vdrQuestions',
  'vdrQuestionResponses',
  'vdrQuestionEvents',
  'dashboardConfigs',
  'dashboardVersions',
  'vdrWorkflowConfigs',
  'vdrWorkflowVersions',
  'vdrWorkflowRuns',
  'vdrWorkflowStepRuns',
  'vdrWorkflowRunEvents',
  'documentRedactions',
  'ddChecklistInstances',
  'ddChecklistItemInstances',
  'ddDocumentRequests',
] as const

/** Los módulos Convex que servían a esas tablas. */
const RETIRED_CONVEX_PATHS = [
  'deals.ts',
  'dealAccess.ts',
  '_deals',
  'documentRedactions.ts',
  'dueDiligence.ts',
  '_dueDiligence',
  '_dashboards',
  'vdrEnterprise.ts',
  '_enterprise',
  '_analytics/vdrEngagement.ts',
  '_guests/accessCycle.ts',
  '_guests/richProjection.ts',
] as const

describe('el subsistema de transacciones sigue fuera del árbol', () => {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')

  it.each(RETIRED_TABLES)('`%s` no está definida en el schema', (table) => {
    expect(schema).not.toMatch(new RegExp(`\\b${table}:\\s*defineTable\\(`))
  })

  it('ninguna tabla declara un campo `dealId`', () => {
    expect(schema).not.toMatch(/\bdealId\b/)
  })

  it.each(RETIRED_TABLES)('ninguna tabla apunta a `%s` con `v.id`', (table) => {
    expect(schema).not.toContain(`v.id('${table}')`)
  })

  it.each(RETIRED_CONVEX_PATHS)('`convex/%s` no existe', (entry) => {
    expect(fs.existsSync(path.join(CONVEX_ROOT, entry))).toBe(false)
  })
})
