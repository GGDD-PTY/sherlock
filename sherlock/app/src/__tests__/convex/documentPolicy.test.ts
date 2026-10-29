import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_ACCESS_DECISIONS,
  evaluateDocumentAccessDecision,
  getDocumentAccessErrorMessage,
  inferDocumentClassification,
  type DocumentAccessContext,
  type DocumentAccessEvaluation,
} from '../../../convex/_documents/policy'
import { mockId } from '../utils/test-factories'

// Every outcome produced by a case in this file. Compared at the end against the
// outcome literals actually present in policy.ts, so a new branch fails until it
// is covered here.
const reachedOutcomes = new Set<string>()
const reachedDecisions = new Set<string>()

// La empresa dueña sobre un documento CONFIDENTIAL vivo. Desde que salieron el
// rol INVESTOR y el marketplace ([F] 2026-09-16), esta policy solo conoce dos
// principales que abren: ADMIN y la empresa autorizada.
// Each case flips only the field it is about, so the assertion is about that
// field and nothing else.
function evaluate(overrides: Partial<DocumentAccessContext> = {}): DocumentAccessEvaluation {
  const context = {
    profile: { _id: mockId('profiles'), role: 'COMPANY', kycStatus: 'VERIFIED' },
    isOwner: true,
    ...overrides,
    document: {
      companyId: mockId('companies'),
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      isExpired: false,
      ...(overrides.document ?? {}),
    },
  } as DocumentAccessContext

  const result = evaluateDocumentAccessDecision(context)
  reachedOutcomes.add(result.outcome)
  reachedDecisions.add(result.decision)
  return result
}

describe('convex/_documents/policy.ts', () => {
  it('infers PUBLIC_TEASER for public documents by default', () => {
    expect(inferDocumentClassification('PUBLIC')).toBe('PUBLIC_TEASER')
  })

  it('allows owner access regardless of classification', () => {
    const result = evaluate({
      profile: { _id: mockId('profiles'), role: 'COMPANY', kycStatus: 'PENDING' },
      document: {
        companyId: mockId('companies'),
        accessLevel: 'PRIVATE',
        classification: 'KYC_SENSITIVE',
        isExpired: false,
      },
      isOwner: true,
    })

    expect(result.decision).toBe('ALLOW')
    expect(result.outcome).toBe('ALLOWED_OWNER')
  })

  it('routes kyc sensitive documents to manual review for non-owners', () => {
    const result = evaluate({
      isOwner: false,
      document: {
        accessLevel: 'PRIVATE',
        classification: 'KYC_SENSITIVE',
      } as DocumentAccessContext['document'],
    })

    expect(result.decision).toBe('REQUIRE_REVIEW')
    expect(result.stepUpRequirement).toBe('MANUAL_REVIEW')
    expect(result.outcome).toBe('REVIEW_REQUIRED_KYC_SENSITIVE')
  })

  // ==========================================================================
  // EXPIRY PRECEDES EVERY ALLOW
  // ==========================================================================
  // The two expiry guards sit ahead of the ADMIN and OWNER allows on purpose.
  // If a refactor hoists "admins bypass everything" above them, an expired
  // document would be readable and logged as an ALLOW.

  describe('document expiry', () => {
    it('denies a quarantined blob even to ADMIN before any role bypass', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'ADMIN', kycStatus: 'VERIFIED' },
        document: { lifecycleStatus: 'QUARANTINED' } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_DOCUMENT_QUARANTINED')
      expect(result.reason).toMatch(/cuarentena/i)
    })

    it('denies an archived document even to its owner', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'COMPANY', kycStatus: 'VERIFIED' },
        isOwner: true,
        document: { lifecycleStatus: 'ARCHIVED' } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_DOCUMENT_ARCHIVED')
    })

    it('denies an expired document even for ADMIN', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'ADMIN', kycStatus: 'VERIFIED' },
        document: { isExpired: true } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_DOCUMENT_EXPIRED')
      expect(result.stepUpRequirement).toBe('NONE')
    })

    it('denies a document past expiresAt even when the cron has not stamped isExpired', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'ADMIN', kycStatus: 'VERIFIED' },
        document: {
          isExpired: false,
          expiresAt: Date.now() - 1_000,
        } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_DOCUMENT_EXPIRED')
    })

    it('denies an expired document even for the owner', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'COMPANY', kycStatus: 'VERIFIED' },
        isOwner: true,
        document: { isExpired: true } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_DOCUMENT_EXPIRED')
    })

    it('still allows a document whose expiresAt is in the future', () => {
      const result = evaluate({
        document: { expiresAt: Date.now() + 60_000 } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('ALLOW')
      expect(result.outcome).toBe('ALLOWED_OWNER')
    })
  })

  // ==========================================================================
  // ADMIN
  // ==========================================================================

  describe('admin access', () => {
    it('allows ADMIN on a live KYC_SENSITIVE document', () => {
      const result = evaluate({
        profile: { _id: mockId('profiles'), role: 'ADMIN', kycStatus: 'PENDING' },
        document: {
          accessLevel: 'PRIVATE',
          classification: 'KYC_SENSITIVE',
        } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('ALLOW')
      expect(result.outcome).toBe('ALLOWED_ADMIN')
      expect(result.riskScore).toBe(15)
    })
  })

  // ==========================================================================
  // HARD DENIES (no step-up can rescue them)
  // ==========================================================================

  describe('hard denies', () => {
    it('denies a caller that is neither ADMIN ni la empresa dueña', () => {
      const result = evaluate({ isOwner: false })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_NO_ROOM_ACCESS')
      expect(result.stepUpRequirement).toBe('NONE')
    })

    it('denies PRIVATE documents to a non-owner', () => {
      const result = evaluate({
        isOwner: false,
        document: {
          accessLevel: 'PRIVATE',
          classification: 'CONFIDENTIAL',
        } as DocumentAccessContext['document'],
      })

      expect(result.decision).toBe('DENY')
      expect(result.outcome).toBe('DENIED_PRIVATE_OWNER_ONLY')
      expect(getDocumentAccessErrorMessage(result)).toBe(result.reason)
    })
  })

  // ==========================================================================
  // BRANCH COVERAGE RATCHET
  // ==========================================================================

  describe('branch coverage ratchet', () => {
    it('reaches every outcome literal declared in policy.ts', () => {
      const source = readFileSync(join(process.cwd(), 'convex/_documents/policy.ts'), 'utf8')
      const evaluator = source.slice(
        source.indexOf('export function evaluateDocumentAccessDecision'),
        source.indexOf('export function getDocumentAccessErrorMessage')
      )

      expect(evaluator.length).toBeGreaterThan(0)

      const declaredOutcomes = new Set(
        [...evaluator.matchAll(/'((?:ALLOWED|DENIED|REQUIRE|REVIEW)_[A-Z_]+)'/g)]
          .map((match) => match[1])
          .filter((literal) => !DOCUMENT_ACCESS_DECISIONS.includes(literal as never))
      )

      expect(declaredOutcomes.size).toBeGreaterThanOrEqual(7)

      const uncovered = [...declaredOutcomes].filter((outcome) => !reachedOutcomes.has(outcome))
      expect(uncovered).toEqual([])
    })

    it('reaches every decision kind this evaluator can return', () => {
      // `REQUIRE_STEP_UP` sigue en el vocabulario compartido porque lo produce
      // la policy de sala (`_deals/accessPolicy.ts`), pero esta función dejó de
      // emitirlo cuando salieron las compuertas de la contraparte con el rol
      // INVESTOR y el marketplace ([F] 2026-09-16).
      expect([...reachedDecisions].sort()).toEqual(['ALLOW', 'DENY', 'REQUIRE_REVIEW'])
      expect(DOCUMENT_ACCESS_DECISIONS).toContain('REQUIRE_STEP_UP')
    })
  })
})
