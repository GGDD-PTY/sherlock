// ============================================================================
// DELIVERABLES — contrato de authz y disciplina de frontera del facade
// ============================================================================
// Inspecciona la fuente real de `convex/deliverables.ts` y fija los invariantes
// de frontera: guardas concentradas en el handler (auth + rol + ownership +
// integridad cross-empresa), lógica pura consumida desde `_deliverables/model`,
// evidencia de audit en toda acción admin, y proyecciones por whitelist
// explícita. Si un refactor rompe esto, movió una guarda fuera de la frontera.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { exportBlockWithSeam } from '../utils/convex-effect-seam'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function readConvex(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, 'convex', relativePath), 'utf8')
}

describe('deliverables facade — boundary discipline contract', () => {
  const source = readConvex('deliverables.ts')

  // Cada sección es el código que corre para SU handler: el registro más el
  // programa Effect al que delega. Cortar entre un export y el siguiente ya no
  // sirve, porque con la costura el registro es una línea y entre medio viven
  // los programas de otros exports. Eso además fortalece lo que estas pruebas
  // miden: la guarda tiene que estar en el handler, no heredada por vecindad.
  const sectionOf = (exportName: string): string => {
    const block = exportBlockWithSeam(source, exportName)
    expect(block, `no se encontró export const ${exportName}`).toBeDefined()
    return block as string
  }

  it('guards every surface with the central auth chain', () => {
    // Las transiciones y renditions son territorio del equipo: admin siempre.
    const transitionSection = sectionOf('transition')
    const attachSection = sectionOf('attachRendition')
    expect(transitionSection).toContain('requireAuthAdmin(ctx)')
    expect(attachSection).toContain('requireAuthAdmin(ctx)')

    // El path de empresa deriva la empresa de su propia fila, jamás del arg.
    // Pedir un slot exige gestión, no solo la lectura del listado.
    expect(source).toContain('requireAuthenticatedCompany(ctx)')
    expect(sectionOf('request')).toContain('requireCompanyManagementAuthorization(')
    expect(source.match(/requireAuth\(ctx\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('guards the mark-as-delivery lane on its own section, not by proximity', () => {
    // Entregar desde la UI mueve el rail del cliente y le suena la campanita:
    // su guarda tiene que estar en su propio handler, no heredada del corte de
    // texto de la mutation vecina.
    const markSection = sectionOf('markDocumentAsDelivery')
    expect(markSection).toContain('requireAuthAdmin(ctx)')
    // El avance del slot no se copia por llamador: la evidencia de auditoría
    // sale del mismo helper que usa `bun run vdr:push --slot`.
    expect(markSection).toContain('advanceDeliverableSlot(ctx, {')
    expect(readConvex('_deliverables/manualDelivery.ts')).toContain(
      "action: 'DELIVERABLE_TRANSITION'"
    )
  })

  it('routes every transition through the pure state machine', () => {
    expect(source).toContain("from './_deliverables/model'")
    expect(source).toContain('canTransitionDeliverable(deliverable.status, args.to)')
    // Ningún patch de status fuera del guard: el único sitio que escribe
    // `status:` en una transición es el bloque posterior al check.
    const transitionSection = sectionOf('transition')
    expect(transitionSection.indexOf('canTransitionDeliverable')).toBeLessThan(
      transitionSection.indexOf('status: args.to')
    )
  })

  it('leaves audit evidence for every admin mutation on a deliverable', () => {
    const adminActions = source.match(/action: 'DELIVERABLE_[A-Z_]+'/g) ?? []
    expect(adminActions).toContain("action: 'DELIVERABLE_TRANSITION'")
    expect(adminActions).toContain("action: 'DELIVERABLE_RENDITION_ATTACH'")
    expect(source).toContain("targetType: 'DELIVERABLE'")
  })

  it('enforces cross-company integrity for renditions at the boundary', () => {
    expect(source).toContain('document.companyId !== deliverable.companyId')
  })

  it('rate-limits slot creation and keeps it idempotent per (company, kind)', () => {
    expect(source).toContain('enforceRateLimit')
    expect(source).toContain("withIndex('by_company_kind'")
    expect(source).toContain('created: false')
  })

  it('uses error factories only — raw throws are banned in Convex modules', () => {
    expect(source).not.toMatch(/throw new Error\(/)
  })

  it('projects deliverables through an explicit whitelist, never a raw spread', () => {
    const listSection = sectionOf('listForCompany')
    expect(listSection).not.toContain('...row')
    expect(listSection).toContain('deliverableId: row._id')
    expect(listSection).toContain('status: row.status')
    expect(listSection).toContain('version.companyId !== companyId')
    expect(listSection).toContain('document.companyId !== companyId')
    expect(listSection).toContain("document.lifecycleStatus === 'QUARANTINED'")
    expect(listSection).toContain('sourcesTruncated: (row.inputManifest?.length ?? 0) > 20')
  })
})
