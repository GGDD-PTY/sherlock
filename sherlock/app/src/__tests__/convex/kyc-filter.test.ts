// ============================================================================
// KYC FILTER UNIT TESTS (convex/_helpers/kycFilter.ts)
// ============================================================================
// Tests for KYC field stripping logic that enforces LatAm financial regulation
// requirements: admin-only fields, owner-visible fields, and third-party access.
// ============================================================================

import { describe, it, expect } from 'vitest'
import {
  filterProfileKycFields,
  stripAdminOnlyKycFields,
  stripAllSensitiveKycFields,
} from '../../../convex/_helpers/kycFilter'
import { createMockProfile, mockId } from '../utils/test-factories'

// ============================================================================
// HELPERS
// ============================================================================

/** Builds a profile-like object with all KYC fields populated */
function buildFullKycProfile(overrides: Record<string, unknown> = {}) {
  return {
    ...createMockProfile({
      kycStatus: 'VERIFIED',
      kycProvider: 'onfido',
      kycVerifiedAt: Date.now() - 86400000,
      kycExpiresAt: Date.now() + 365 * 86400000,
    }),
    kycRejectionReason: 'Document unreadable',
    ...overrides,
  }
}

// ============================================================================
// TEST: stripAdminOnlyKycFields
// ============================================================================

describe('stripAdminOnlyKycFields', () => {
  it('should remove kycRejectionReason and kycProvider', () => {
    const profile = buildFullKycProfile()
    const result = stripAdminOnlyKycFields(profile)

    expect(result).not.toHaveProperty('kycRejectionReason')
    expect(result).not.toHaveProperty('kycProvider')
  })

  it('should preserve kycStatus, kycVerifiedAt, and kycExpiresAt', () => {
    const profile = buildFullKycProfile()
    const result = stripAdminOnlyKycFields(profile)

    expect(result).toHaveProperty('kycStatus', 'VERIFIED')
    expect(result).toHaveProperty('kycVerifiedAt')
    expect(result).toHaveProperty('kycExpiresAt')
  })

  it('should preserve all non-KYC fields', () => {
    const profile = buildFullKycProfile()
    const result = stripAdminOnlyKycFields(profile)

    expect(result).toHaveProperty('_id', profile._id)
    expect(result).toHaveProperty('userId', profile.userId)
    expect(result).toHaveProperty('role', profile.role)
    expect(result).toHaveProperty('fullName', profile.fullName)
    expect(result).toHaveProperty('language', profile.language)
    expect(result).toHaveProperty('emailNotifications', profile.emailNotifications)
    expect(result).toHaveProperty('isVerified', profile.isVerified)
    expect(result).toHaveProperty('isActive', profile.isActive)
  })

  it('should handle profile where admin-only fields are already undefined', () => {
    const profile = { ...createMockProfile({ kycStatus: 'PENDING' }) }
    // kycProvider and kycRejectionReason are not set
    const result = stripAdminOnlyKycFields(profile)

    expect(result).not.toHaveProperty('kycRejectionReason')
    expect(result).not.toHaveProperty('kycProvider')
    expect(result).toHaveProperty('kycStatus', 'PENDING')
  })
})

// ============================================================================
// TEST: stripAllSensitiveKycFields
// ============================================================================

describe('stripAllSensitiveKycFields', () => {
  it('should remove kycRejectionReason, kycProvider, and kycExpiresAt', () => {
    const profile = buildFullKycProfile()
    const result = stripAllSensitiveKycFields(profile)

    expect(result).not.toHaveProperty('kycRejectionReason')
    expect(result).not.toHaveProperty('kycProvider')
    expect(result).not.toHaveProperty('kycExpiresAt')
  })

  it('should preserve kycStatus and kycVerifiedAt (trust signals)', () => {
    const profile = buildFullKycProfile()
    const result = stripAllSensitiveKycFields(profile)

    expect(result).toHaveProperty('kycStatus', 'VERIFIED')
    expect(result).toHaveProperty('kycVerifiedAt')
  })

  it('should preserve all non-KYC fields', () => {
    const profile = buildFullKycProfile()
    const result = stripAllSensitiveKycFields(profile)

    expect(result).toHaveProperty('_id', profile._id)
    expect(result).toHaveProperty('userId', profile.userId)
    expect(result).toHaveProperty('role', profile.role)
    expect(result).toHaveProperty('fullName', profile.fullName)
    expect(result).toHaveProperty('language', profile.language)
    expect(result).toHaveProperty('emailNotifications', profile.emailNotifications)
    expect(result).toHaveProperty('isVerified', profile.isVerified)
    expect(result).toHaveProperty('isActive', profile.isActive)
  })
})

// ============================================================================
// TEST: filterProfileKycFields
// ============================================================================

describe('filterProfileKycFields', () => {
  // --------------------------------------------------------------------------
  // Unauthenticated caller (null identity)
  // --------------------------------------------------------------------------

  describe('unauthenticated caller (null identity)', () => {
    it('should strip all sensitive KYC fields', () => {
      const profile = buildFullKycProfile() as ReturnType<typeof buildFullKycProfile>
      const result = filterProfileKycFields(profile as never, null, null)

      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
      expect(result).not.toHaveProperty('kycExpiresAt')
    })

    it('should keep kycStatus and kycVerifiedAt as trust signals', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, null, null)

      expect(result).toHaveProperty('kycStatus', 'VERIFIED')
      expect(result).toHaveProperty('kycVerifiedAt')
    })

    it('should preserve non-KYC fields', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, null, null)

      expect(result).toHaveProperty('fullName', profile.fullName)
      expect(result).toHaveProperty('role', profile.role)
      expect(result).toHaveProperty('_id', profile._id)
      expect(result).toHaveProperty('userId', profile.userId)
    })
  })

  // --------------------------------------------------------------------------
  // Profile owner (same _id, non-admin)
  // --------------------------------------------------------------------------

  describe('profile owner', () => {
    it('should strip admin-only fields (kycRejectionReason, kycProvider)', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, profile._id, 'COMPANY')

      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
    })

    it('should keep kycStatus, kycVerifiedAt, and kycExpiresAt for owner', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, profile._id, 'COMPANY')

      expect(result).toHaveProperty('kycStatus', 'VERIFIED')
      expect(result).toHaveProperty('kycVerifiedAt')
      expect(result).toHaveProperty('kycExpiresAt')
    })

    it('should preserve non-KYC fields for owner', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, profile._id, 'COMPANY')

      expect(result).toHaveProperty('fullName', profile.fullName)
      expect(result).toHaveProperty('role', profile.role)
      expect(result).toHaveProperty('_id', profile._id)
      expect(result).toHaveProperty('language', profile.language)
    })

    it('should work for COMPANY role owner too', () => {
      const profile = buildFullKycProfile()
      const result = filterProfileKycFields(profile as never, profile._id, 'COMPANY')

      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
      expect(result).toHaveProperty('kycExpiresAt')
    })
  })

  // --------------------------------------------------------------------------
  // Admin caller
  // --------------------------------------------------------------------------

  describe('admin caller', () => {
    it('should return the full profile with all KYC fields', () => {
      const profile = buildFullKycProfile()
      const adminProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, adminProfileId, 'ADMIN')

      expect(result).toHaveProperty('kycRejectionReason', 'Document unreadable')
      expect(result).toHaveProperty('kycProvider', 'onfido')
      expect(result).toHaveProperty('kycExpiresAt')
      expect(result).toHaveProperty('kycStatus', 'VERIFIED')
      expect(result).toHaveProperty('kycVerifiedAt')
    })

    it('should return unmodified profile reference for admin', () => {
      const profile = buildFullKycProfile()
      const adminProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, adminProfileId, 'ADMIN')

      // Admin path returns the exact same object
      expect(result).toBe(profile)
    })

    it('should work even when admin is also the profile owner', () => {
      const profile = buildFullKycProfile()
      // Admin viewing their own profile — admin check takes priority
      const result = filterProfileKycFields(profile as never, profile._id, 'ADMIN')

      expect(result).toHaveProperty('kycRejectionReason')
      expect(result).toHaveProperty('kycProvider')
      expect(result).toBe(profile)
    })
  })

  // --------------------------------------------------------------------------
  // Third-party user (not owner, not admin)
  // --------------------------------------------------------------------------

  describe('third-party user (not owner, not admin)', () => {
    it('should strip kycRejectionReason, kycProvider, and kycExpiresAt', () => {
      const profile = buildFullKycProfile()
      const otherProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, otherProfileId, 'COMPANY')

      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
      expect(result).not.toHaveProperty('kycExpiresAt')
    })

    it('should keep kycStatus and kycVerifiedAt as trust signals', () => {
      const profile = buildFullKycProfile()
      const otherProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, otherProfileId, 'COMPANY')

      expect(result).toHaveProperty('kycStatus', 'VERIFIED')
      expect(result).toHaveProperty('kycVerifiedAt')
    })

    it('should preserve non-KYC fields', () => {
      const profile = buildFullKycProfile()
      const otherProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, otherProfileId, 'COMPANY')

      expect(result).toHaveProperty('fullName', profile.fullName)
      expect(result).toHaveProperty('role', profile.role)
      expect(result).toHaveProperty('_id', profile._id)
      expect(result).toHaveProperty('userId', profile.userId)
      expect(result).toHaveProperty('isVerified', profile.isVerified)
      expect(result).toHaveProperty('isActive', profile.isActive)
    })
  })

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle profile with no KYC fields set (all undefined)', () => {
      const profile = createMockProfile()
      // No kycProvider, kycExpiresAt, or kycRejectionReason set
      const otherProfileId = mockId('profiles')
      const result = filterProfileKycFields(profile as never, otherProfileId, 'COMPANY')

      // Should not throw, and non-KYC fields should survive
      expect(result).toHaveProperty('fullName', profile.fullName)
      expect(result).toHaveProperty('role', profile.role)
      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
      expect(result).not.toHaveProperty('kycExpiresAt')
    })

    it('should handle profile with only kycStatus set', () => {
      const profile = createMockProfile({ kycStatus: 'REJECTED' })
      const result = filterProfileKycFields(profile as never, null, null)

      expect(result).toHaveProperty('kycStatus', 'REJECTED')
      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
    })

    it('should not strip non-KYC fields regardless of caller type', () => {
      const profile = buildFullKycProfile()
      const nonKycFields = [
        '_id',
        '_creationTime',
        'userId',
        'role',
        'fullName',
        'language',
        'emailNotifications',
        'isVerified',
        'isActive',
      ] as const

      // Unauthenticated
      const unauthResult = filterProfileKycFields(profile as never, null, null)
      for (const field of nonKycFields) {
        expect(unauthResult).toHaveProperty(field)
      }

      // Owner
      const ownerResult = filterProfileKycFields(profile as never, profile._id, 'COMPANY')
      for (const field of nonKycFields) {
        expect(ownerResult).toHaveProperty(field)
      }

      // Third-party
      const otherProfileId = mockId('profiles')
      const thirdPartyResult = filterProfileKycFields(profile as never, otherProfileId, 'COMPANY')
      for (const field of nonKycFields) {
        expect(thirdPartyResult).toHaveProperty(field)
      }

      // Admin
      const adminProfileId = mockId('profiles')
      const adminResult = filterProfileKycFields(profile as never, adminProfileId, 'ADMIN')
      for (const field of nonKycFields) {
        expect(adminResult).toHaveProperty(field)
      }
    })

    it('should handle callerProfileId set but callerRole null (partial auth)', () => {
      const profile = buildFullKycProfile()
      const someProfileId = mockId('profiles')
      // callerRole is null but callerProfileId is set — treated as third-party
      const result = filterProfileKycFields(profile as never, someProfileId, null)

      expect(result).not.toHaveProperty('kycRejectionReason')
      expect(result).not.toHaveProperty('kycProvider')
      expect(result).not.toHaveProperty('kycExpiresAt')
    })
  })
})
