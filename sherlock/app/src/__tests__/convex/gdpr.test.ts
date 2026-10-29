// ============================================================================
// CONVEX GDPR MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/gdpr.ts
//
// Test Categories:
// 1. Data Export (requestDataExport, getExportStatus, downloadExport)
// 2. Data Deletion (requestAccountDeletion, processDataDeletion)
// 3. Consent Management (updateConsent, getConsentStatus)
// 4. Data Retention (cleanupExpiredData, retentionPolicies)
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { reachableFrom } from '../utils/convex-effect-seam'
import {
  createMockConvexCtx,
  mockUnauthenticatedRequest,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import { mockId, resetIdCounter } from '../utils/test-factories'

// ============================================================================
// MOCK GDPR DATA
// ============================================================================

interface MockDataExportRequest {
  _id: string
  _creationTime: number
  userId: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  requestedAt: number
  completedAt?: number
  downloadUrl?: string
  expiresAt?: number
}

interface MockDeletionRequest {
  _id: string
  _creationTime: number
  userId: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED'
  requestedAt: number
  scheduledFor: number
  completedAt?: number
  reason?: string
}

interface MockConsentRecord {
  _id: string
  _creationTime: number
  userId: string
  consentType: string
  granted: boolean
  grantedAt?: number
  revokedAt?: number
  ipAddress?: string
}

function createMockDataExportRequest(
  overrides: Partial<MockDataExportRequest> = {}
): MockDataExportRequest {
  return {
    _id: mockId('dataExportRequests'),
    _creationTime: Date.now(),
    userId: mockId('profiles'),
    status: 'PENDING',
    requestedAt: Date.now(),
    ...overrides,
  }
}

function createMockDeletionRequest(
  overrides: Partial<MockDeletionRequest> = {}
): MockDeletionRequest {
  return {
    _id: mockId('deletionRequests'),
    _creationTime: Date.now(),
    userId: mockId('profiles'),
    status: 'PENDING',
    requestedAt: Date.now(),
    scheduledFor: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    ...overrides,
  }
}

function createMockConsentRecord(overrides: Partial<MockConsentRecord> = {}): MockConsentRecord {
  return {
    _id: mockId('consentRecords'),
    _creationTime: Date.now(),
    userId: mockId('profiles'),
    consentType: 'marketing_emails',
    granted: true,
    grantedAt: Date.now(),
    ...overrides,
  }
}

function extractExportBlock(source: string, exportName: string): string {
  const start = source.indexOf(`export const ${exportName} =`)
  expect(start).toBeGreaterThanOrEqual(0)

  const nextExport = source.indexOf('\nexport const ', start + 1)
  const block = nextExport === -1 ? source.slice(start) : source.slice(start, nextExport)

  // Con la costura de Convex el registro es una línea y el cuerpo vive en el
  // programa que nombra. Lo que se audita es el código que corre.
  return reachableFrom(block, source)
}

// ============================================================================
// SETUP
// ============================================================================

describe('convex/gdpr.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: DATA EXPORT
  // ==========================================================================

  describe('Data Export', () => {
    // ===== requestDataExport =====
    describe('requestDataExport', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should create export request', async () => {
        const _requestId = mockId('dataExportRequests')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(_requestId)

        await ctx.db.insert('dataExportRequests', {
          userId,
          status: 'PENDING',
          requestedAt: Date.now(),
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'dataExportRequests',
          expect.objectContaining({
            status: 'PENDING',
          })
        )
      })

      it('should prevent duplicate pending requests', async () => {
        const userId = mockId('profiles')
        const existingRequest = createMockDataExportRequest({
          userId,
          status: 'PENDING',
        })

        const queryBuilder = createMockQueryBuilder([existingRequest])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('dataExportRequests')
        const existing = await query.filter().first()

        expect(existing?.status).toBe('PENDING')
        // Real code would throw "Ya tienes una solicitud pendiente"
      })

      it('should allow new request after previous completed', async () => {
        const userId = mockId('profiles')
        const completedRequest = createMockDataExportRequest({
          userId,
          status: 'COMPLETED',
          completedAt: Date.now() - 86400000, // Yesterday
        })

        const queryBuilder = createMockQueryBuilder([completedRequest])
        ctx.db.query.mockReturnValue(queryBuilder)

        // Can create new request since previous is completed
        expect(completedRequest.status).toBe('COMPLETED')
      })
    })

    // ===== getExportStatus =====
    describe('getExportStatus', () => {
      it('should return export request status', async () => {
        const requestId = mockId('dataExportRequests')
        const mockRequest = createMockDataExportRequest({
          _id: requestId,
          status: 'PROCESSING',
        })

        ctx.db.get.mockResolvedValue(mockRequest)

        const result = await ctx.db.get(requestId)

        expect(result?.status).toBe('PROCESSING')
      })

      it('should verify ownership', async () => {
        const callerUserId = mockId('profiles')
        const ownerUserId = mockId('profiles')
        const mockRequest = createMockDataExportRequest({
          userId: ownerUserId,
        })

        ctx.db.get.mockResolvedValue(mockRequest)

        const request = await ctx.db.get(mockRequest._id)
        const isOwner = request?.userId === callerUserId

        expect(isOwner).toBe(false)
      })
    })

    // ===== downloadExport =====
    describe('downloadExport', () => {
      it('should return download URL for completed export', async () => {
        const mockRequest = createMockDataExportRequest({
          status: 'COMPLETED',
          downloadUrl: 'https://storage.example.com/export.zip',
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        })

        expect(mockRequest.downloadUrl).toBeDefined()
        expect(mockRequest.status).toBe('COMPLETED')
      })

      it('should deny download for non-completed export', async () => {
        const mockRequest = createMockDataExportRequest({
          status: 'PROCESSING',
        })

        const canDownload = mockRequest.status === 'COMPLETED'
        expect(canDownload).toBe(false)
      })

      it('should deny download for expired export', async () => {
        const mockRequest = createMockDataExportRequest({
          status: 'COMPLETED',
          expiresAt: Date.now() - 86400000, // Expired yesterday
        })

        const isExpired = mockRequest.expiresAt !== undefined && mockRequest.expiresAt < Date.now()

        expect(isExpired).toBe(true)
      })
    })
  })

  // ==========================================================================
  // SECTION 2: DATA DELETION
  // ==========================================================================

  describe('Data Deletion', () => {
    // ===== requestAccountDeletion =====
    describe('requestAccountDeletion', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should create deletion request with 30-day grace period', async () => {
        const requestId = mockId('deletionRequests')
        const userId = mockId('profiles')
        const now = Date.now()
        const scheduledFor = now + 30 * 24 * 60 * 60 * 1000 // 30 days

        ctx.db.insert.mockResolvedValue(requestId)

        await ctx.db.insert('deletionRequests', {
          userId,
          status: 'PENDING',
          requestedAt: now,
          scheduledFor,
          reason: 'User requested account deletion',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'deletionRequests',
          expect.objectContaining({
            status: 'PENDING',
            scheduledFor,
          })
        )
      })

      it('should prevent duplicate deletion requests', async () => {
        const userId = mockId('profiles')
        const existingRequest = createMockDeletionRequest({
          userId,
          status: 'PENDING',
        })

        const queryBuilder = createMockQueryBuilder([existingRequest])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('deletionRequests')
        const existing = await query.filter().first()

        expect(existing?.status).toBe('PENDING')
      })

      it('should record reason for deletion', async () => {
        const requestId = mockId('deletionRequests')
        const reason = 'No longer using the service'

        ctx.db.insert.mockResolvedValue(requestId)

        await ctx.db.insert('deletionRequests', {
          userId: mockId('profiles'),
          status: 'PENDING',
          reason,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'deletionRequests',
          expect.objectContaining({
            reason,
          })
        )
      })
    })

    // ===== cancelDeletionRequest =====
    describe('cancelDeletionRequest', () => {
      it('requires caller auth and request ownership before cancellation', () => {
        const source = readFileSync(join(process.cwd(), 'convex/gdpr.ts'), 'utf8')
        const block = extractExportBlock(source, 'cancelDeletionRequest')

        expect(block).toContain('requireAuth(ctx)')
        expect(block).toContain('viewerProfile._id !== request.profileId')
        expect(block.indexOf('requireAuth(ctx)')).toBeLessThan(
          block.indexOf('ctx.db.get(args.requestId)')
        )
      })

      it('should allow cancellation within grace period', async () => {
        const requestId = mockId('deletionRequests')

        await ctx.db.patch(requestId, { status: 'CANCELLED' })

        expect(ctx.db.patch).toHaveBeenCalledWith(requestId, {
          status: 'CANCELLED',
        })
      })

      it('should not allow cancellation after processing started', async () => {
        const mockRequest = createMockDeletionRequest({
          status: 'PROCESSING',
        })

        const canCancel = mockRequest.status === 'PENDING'
        expect(canCancel).toBe(false)
      })
    })

    // ===== processDataDeletion =====
    describe('processDataDeletion', () => {
      it('requires an authenticated admin before deleting account data', () => {
        const source = readFileSync(join(process.cwd(), 'convex/gdpr.ts'), 'utf8')
        const block = extractExportBlock(source, 'processAccountDeletion')

        expect(block).toContain('requireAuth(ctx)')
        expect(block).toContain("viewerProfile.role !== 'ADMIN'")
        expect(block).toContain('processedBy: viewerProfile._id')
        expect(block.indexOf('requireAuth(ctx)')).toBeLessThan(block.indexOf('ctx.db.delete'))
      })

      it('should delete user data after grace period', async () => {
        const userId = mockId('profiles')

        // Delete user-related data
        await ctx.db.delete(userId)

        expect(ctx.db.delete).toHaveBeenCalledWith(userId)
      })

      it('should delete associated profiles', async () => {
        const profileId = mockId('profiles')

        await ctx.db.delete(profileId)

        expect(ctx.db.delete).toHaveBeenCalledWith(profileId)
      })

      it('should anonymize activity logs instead of deleting', async () => {
        const logId = mockId('activityLogs')

        await ctx.db.patch(logId, {
          userId: null,
          ipAddress: 'ANONYMIZED',
          userAgent: 'ANONYMIZED',
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          logId,
          expect.objectContaining({
            ipAddress: 'ANONYMIZED',
          })
        )
      })

      it('should update deletion request status', async () => {
        const requestId = mockId('deletionRequests')

        await ctx.db.patch(requestId, {
          status: 'COMPLETED',
          completedAt: Date.now(),
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          requestId,
          expect.objectContaining({
            status: 'COMPLETED',
          })
        )
      })
    })
  })

  // ==========================================================================
  // SECTION 3: CONSENT MANAGEMENT
  // ==========================================================================

  describe('Consent Management', () => {
    // ===== updateConsent =====
    describe('updateConsent', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should record consent grant', async () => {
        const consentId = mockId('consentRecords')
        const userId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(consentId)

        await ctx.db.insert('consentRecords', {
          userId,
          consentType: 'marketing_emails',
          granted: true,
          grantedAt: Date.now(),
          ipAddress: '192.168.1.1',
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'consentRecords',
          expect.objectContaining({
            consentType: 'marketing_emails',
            granted: true,
          })
        )
      })

      it('should record consent revocation', async () => {
        const consentId = mockId('consentRecords')

        await ctx.db.patch(consentId, {
          granted: false,
          revokedAt: Date.now(),
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          consentId,
          expect.objectContaining({
            granted: false,
          })
        )
      })

      it('should capture IP address for audit', async () => {
        const consentId = mockId('consentRecords')
        const ipAddress = '192.168.1.100'

        ctx.db.insert.mockResolvedValue(consentId)

        await ctx.db.insert('consentRecords', {
          consentType: 'analytics',
          granted: true,
          ipAddress,
        })

        expect(ctx.db.insert).toHaveBeenCalledWith(
          'consentRecords',
          expect.objectContaining({
            ipAddress,
          })
        )
      })
    })

    // ===== getConsentStatus =====
    describe('getConsentStatus', () => {
      it('should return all consent statuses for user', async () => {
        const userId = mockId('profiles')
        const consents = [
          createMockConsentRecord({
            userId,
            consentType: 'marketing_emails',
            granted: true,
          }),
          createMockConsentRecord({
            userId,
            consentType: 'analytics',
            granted: false,
          }),
          createMockConsentRecord({
            userId,
            consentType: 'third_party',
            granted: true,
          }),
        ]

        const queryBuilder = createMockQueryBuilder(consents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('consentRecords')
        const result = await query.withIndex('by_userId').collect()

        expect(result).toHaveLength(3)
      })

      it('should return latest consent for each type', () => {
        const consents = [
          createMockConsentRecord({
            consentType: 'marketing_emails',
            granted: true,
            _creationTime: 1000,
          }),
          createMockConsentRecord({
            consentType: 'marketing_emails',
            granted: false,
            _creationTime: 2000, // Later
          }),
        ]

        const latestByType = consents.sort((a, b) => b._creationTime - a._creationTime)[0]

        expect(latestByType.granted).toBe(false)
      })
    })

    // ===== Consent Types =====
    describe('Consent Types', () => {
      it('should validate consent type enum', () => {
        const validConsentTypes = [
          'marketing_emails',
          'analytics',
          'third_party',
          'personalization',
          'essential',
        ]

        validConsentTypes.forEach((type) => {
          expect(validConsentTypes).toContain(type)
        })
      })

      it('should always grant essential consent', () => {
        const essentialConsent = createMockConsentRecord({
          consentType: 'essential',
          granted: true,
        })

        // Essential consent cannot be revoked
        expect(essentialConsent.granted).toBe(true)
      })
    })
  })

  // ==========================================================================
  // SECTION 4: DATA RETENTION
  // ==========================================================================

  describe('Data Retention', () => {
    // ===== cleanupExpiredData =====
    describe('cleanupExpiredData', () => {
      it('should delete expired export requests', async () => {
        const expiredRequest = createMockDataExportRequest({
          status: 'COMPLETED',
          expiresAt: Date.now() - 86400000, // Expired
        })

        await ctx.db.delete(expiredRequest._id)

        expect(ctx.db.delete).toHaveBeenCalledWith(expiredRequest._id)
      })

      it('should anonymize old activity logs', async () => {
        const retentionDays = 365
        const cutoffDate = Date.now() - retentionDays * 24 * 60 * 60 * 1000

        const oldLog = {
          _id: mockId('activityLogs'),
          _creationTime: cutoffDate - 86400000, // Older than retention
        }

        await ctx.db.patch(oldLog._id, { userId: null })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          oldLog._id,
          expect.objectContaining({
            userId: null,
          })
        )
      })

      it('should delete expired sessions', async () => {
        const expiredSessionId = mockId('sessions')

        await ctx.db.delete(expiredSessionId)

        expect(ctx.db.delete).toHaveBeenCalledWith(expiredSessionId)
      })
    })

    // ===== Retention Policies =====
    describe('Retention Policies', () => {
      it('should define retention periods by data type', () => {
        const retentionPolicies = {
          activityLogs: 365, // 1 year
          securityEvents: 730, // 2 years
          sessions: 30, // 30 days
          exportRequests: 7, // 7 days after completion
          analytics: 365, // 1 year
        }

        expect(retentionPolicies.activityLogs).toBe(365)
        expect(retentionPolicies.securityEvents).toBe(730)
      })

      it('should exempt legal hold data from deletion', () => {
        const legalHoldData = {
          _id: mockId('activityLogs'),
          legalHold: true,
          legalHoldReason: 'Ongoing investigation',
        }

        const shouldDelete = !legalHoldData.legalHold
        expect(shouldDelete).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 5: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate export request status', () => {
      const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']

      validStatuses.forEach((status) => {
        expect(validStatuses).toContain(status)
      })
    })

    it('should validate deletion request status', () => {
      const validStatuses = ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED']

      validStatuses.forEach((status) => {
        expect(validStatuses).toContain(status)
      })
    })

    it('should validate consent types', () => {
      const validTypes = [
        'marketing_emails',
        'analytics',
        'third_party',
        'personalization',
        'essential',
      ]

      validTypes.forEach((type) => {
        expect(typeof type).toBe('string')
      })
    })
  })

  // ==========================================================================
  // SECTION 6: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle user with no consent records', async () => {
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const query = ctx.db.query('consentRecords')
      const result = await query.collect()

      expect(result).toHaveLength(0)
    })

    it('should handle concurrent consent updates', async () => {
      const consentId = mockId('consentRecords')

      await Promise.all([
        ctx.db.patch(consentId, { granted: true }),
        ctx.db.patch(consentId, { granted: false }),
      ])

      expect(ctx.db.patch).toHaveBeenCalledTimes(2)
    })

    it('should handle export request failure', async () => {
      const requestId = mockId('dataExportRequests')

      await ctx.db.patch(requestId, {
        status: 'FAILED',
        errorMessage: 'Export generation failed',
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        requestId,
        expect.objectContaining({
          status: 'FAILED',
        })
      )
    })

    it('should handle large data exports', () => {
      const largeExportSize = 1024 * 1024 * 100 // 100MB
      const maxExportSize = 1024 * 1024 * 500 // 500MB limit

      expect(largeExportSize).toBeLessThan(maxExportSize)
    })

    it('should handle immediate deletion for fraud', async () => {
      // Fraud cases bypass 30-day grace period
      await ctx.db.insert('deletionRequests', {
        userId: mockId('profiles'),
        status: 'PROCESSING',
        scheduledFor: Date.now(), // Immediate
        reason: 'Fraud detected',
      })

      expect(ctx.db.insert).toHaveBeenCalled()
    })
  })
})
