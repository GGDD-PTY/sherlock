// ============================================================================
// VDR READ — the one place a tool context is built
// ============================================================================
// The external MCP server (`/api/vdr-mcp`, bearer token) builds every tool
// context here instead of constructing a `VdrToolContext` by hand.
//
// The context carries only an already-authenticated principal. It grants
// nothing: `convex/vdrRead.ts` re-derives the room from durable state on every
// single call, so a caller who passes another company's `salaId` still gets
// the uniform NOT_FOUND.
// ============================================================================

import { Schema } from 'effect'

import { createConvexVdrReadStore, type VdrReadStore } from '@/lib/vdr-mcp/store'
import type { VdrPrincipal, VdrToolContext } from '@/lib/vdr-mcp/tools'
import type { WorkbookLoader } from '@/lib/vdr-mcp/workbook'

// La proyección del principal es deliberadamente estrecha: al contexto entran
// esos dos campos y nada más, para que un principal que traiga extras (un
// token, un scope, un email) no viaje adentro de cada llamada de tool. Antes
// eso era un objeto literal escrito a mano; ahora es un schema, así que la
// proyección se lee y se puede probar en un solo lugar.
const VdrPrincipalProjectionSchema = Schema.Struct({
  principalId: Schema.String,
  clientId: Schema.String,
})

const projectPrincipal = Schema.encodeSync(VdrPrincipalProjectionSchema)

export type VdrToolContextInput = Readonly<{
  /** A principal some upstream boundary already authenticated. */
  principal: VdrPrincipal
  /** Requested room — a `companies` id. Optional for COMPANY callers. */
  salaId?: string
  /** Injectable for tests. */
  store?: VdrReadStore
  loadWorkbook?: WorkbookLoader
}>

export function createVdrToolContext(input: VdrToolContextInput): VdrToolContext {
  return {
    principal: projectPrincipal(input.principal),
    store: input.store ?? createConvexVdrReadStore(),
    ...(input.salaId ? { salaId: input.salaId } : {}),
    ...(input.loadWorkbook ? { loadWorkbook: input.loadWorkbook } : {}),
  }
}
