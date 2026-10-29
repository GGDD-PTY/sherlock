// ============================================================================
// DELIVERABLES — contrato del modelo de dominio del pipeline sell-side
// ============================================================================
// Fija las decisiones foundational del 2026-08-18: la suite de entregables,
// la máquina de estados del slot y la regla de que ningún productor no-humano
// (receipt de Mycroft vía MCP) pasa de DRAFT_READY. Si un cambio rompe estos
// tests, está re-litigando una decisión [F], no refactorizando.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DELIVERABLE_KINDS,
  DELIVERABLE_PRODUCERS,
  DELIVERABLE_RENDITION_FORMATS,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TRANSITIONS,
  canTransitionDeliverable,
  manualDeliverySteps,
  type DeliverableStatus,
} from '../../../convex/_deliverables/model'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

describe('deliverables domain model', () => {
  it('declares the eight deliverables of the sell-side suite', () => {
    expect(DELIVERABLE_KINDS).toEqual([
      'MODEL',
      'TEASER',
      'CIM',
      'MGMT_PRESENTATION',
      'DEBT_DECK',
      'EQUITY_DECK',
      'QA',
      'IRL',
    ])
  })

  it('keeps HTML as a first-class rendition format alongside the export formats', () => {
    expect(DELIVERABLE_RENDITION_FORMATS).toContain('HTML')
    expect(DELIVERABLE_RENDITION_FORMATS).toContain('PPTX')
    expect(DELIVERABLE_RENDITION_FORMATS).toContain('PDF')
    expect(DELIVERABLE_RENDITION_FORMATS).toContain('XLSX')
  })

  it('models the producer as data — the manual lane and the Mycroft lane share the shape', () => {
    expect(DELIVERABLE_PRODUCERS).toEqual(['MYCROFT_RUN', 'TEAM'])
  })

  describe('state machine', () => {
    it('covers every status with an outgoing transition set and only valid targets', () => {
      for (const status of DELIVERABLE_STATUSES) {
        const targets = DELIVERABLE_TRANSITIONS[status]
        expect(targets, `status ${status} sin transiciones declaradas`).toBeDefined()
        for (const target of targets) {
          expect(DELIVERABLE_STATUSES).toContain(target)
        }
      }
    })

    it('accepts the happy path Upload → review → delivery', () => {
      const happyPath: DeliverableStatus[] = [
        'REQUESTED',
        'IN_PROGRESS',
        'DRAFT_READY',
        'IN_REVIEW',
        'APPROVED',
        'DELIVERED',
      ]
      for (let i = 0; i < happyPath.length - 1; i++) {
        expect(
          canTransitionDeliverable(happyPath[i], happyPath[i + 1]),
          `${happyPath[i]} → ${happyPath[i + 1]} debería ser válida`
        ).toBe(true)
      }
    })

    it('rejects shortcuts that skip human review', () => {
      expect(canTransitionDeliverable('REQUESTED', 'APPROVED')).toBe(false)
      expect(canTransitionDeliverable('IN_PROGRESS', 'APPROVED')).toBe(false)
      expect(canTransitionDeliverable('DRAFT_READY', 'APPROVED')).toBe(false)
      expect(canTransitionDeliverable('DRAFT_READY', 'DELIVERED')).toBe(false)
      expect(canTransitionDeliverable('REQUESTED', 'DELIVERED')).toBe(false)
    })

    it('lets a new version reopen the cycle after delivery', () => {
      expect(canTransitionDeliverable('DELIVERED', 'IN_PROGRESS')).toBe(true)
    })

    it('supports the NEEDS_INPUT loop for missing documents', () => {
      expect(canTransitionDeliverable('IN_PROGRESS', 'NEEDS_INPUT')).toBe(true)
      expect(canTransitionDeliverable('NEEDS_INPUT', 'IN_PROGRESS')).toBe(true)
    })

    it('lets review send work back to production', () => {
      expect(canTransitionDeliverable('IN_REVIEW', 'IN_PROGRESS')).toBe(true)
    })
  })

  describe('manual delivery walk (vdr:push --slot)', () => {
    it('only walks hops the state machine already declares, and lands on DELIVERED', () => {
      for (const from of DELIVERABLE_STATUSES) {
        const steps = manualDeliverySteps(from)
        expect(steps, `sin camino de entrega desde ${from}`).not.toBeNull()
        let current = from
        for (const next of steps ?? []) {
          expect(canTransitionDeliverable(current, next), `${current} → ${next}`).toBe(true)
          current = next
        }
        expect(current).toBe('DELIVERED')
      }
    })

    it('reopens the cycle when the slot was already delivered', () => {
      expect(manualDeliverySteps('DELIVERED')).toEqual([
        'IN_PROGRESS',
        'DRAFT_READY',
        'IN_REVIEW',
        'APPROVED',
        'DELIVERED',
      ])
    })

    it('walks through review instead of jumping — the human-only hops stay in the path', () => {
      const steps = manualDeliverySteps('REQUESTED') ?? []
      expect(steps).toContain('IN_REVIEW')
      expect(steps).toContain('APPROVED')
    })
  })

  describe('single source of truth (architecture contract)', () => {
    it('schema.ts consumes the shared validators instead of redeclaring the literals', () => {
      const schemaSource = fs.readFileSync(path.join(APP_ROOT, 'convex', 'schema.ts'), 'utf8')

      expect(schemaSource).toContain("from './_deliverables/model'")
      expect(schemaSource).toContain('deliverables: defineTable({')
      expect(schemaSource).toContain('kind: deliverableKindValidator')
      expect(schemaSource).toContain('status: deliverableStatusValidator')

      // La tabla no re-declara los literales de kind: si aparecen inline en la
      // sección de deliverables, hay dos fuentes de verdad compitiendo.
      const deliverablesSection = schemaSource.slice(
        schemaSource.indexOf('deliverables: defineTable({'),
        schemaSource.indexOf('subscriptions: defineTable({')
      )
      expect(deliverablesSection).not.toContain("v.literal('TEASER')")
      expect(deliverablesSection).not.toContain("v.literal('CIM')")
    })

    it('keeps the workflow layer pointing at custody instead of storing bytes', () => {
      const schemaSource = fs.readFileSync(path.join(APP_ROOT, 'convex', 'schema.ts'), 'utf8')
      const deliverablesSection = schemaSource.slice(
        schemaSource.indexOf('deliverables: defineTable({'),
        schemaSource.indexOf('subscriptions: defineTable({')
      )

      // Renditions e insumos apuntan a custodia (documents/documentVersions);
      // el workflow no persiste storageIds propios.
      expect(deliverablesSection).toContain("documentId: v.id('documents')")
      expect(deliverablesSection).toContain("v.array(v.id('documentVersions'))")
      expect(deliverablesSection).not.toContain("v.id('_storage')")
    })
  })
})
