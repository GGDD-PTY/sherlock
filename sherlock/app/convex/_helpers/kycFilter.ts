// ============================================================================
// KYC DATA FILTER HELPER
// ============================================================================
// Strips sensitive KYC fields from profile data for non-admin, non-owner users.
// LatAm financial regulation requires KYC rejection reasons and provider details
// to be restricted to admins only. Owners can see their own status and expiry.
// ============================================================================

import { Schema, Struct } from 'effect'

import type { Doc } from '../_generated/dataModel'

// Los dos catálogos de campos sensibles, escritos UNA vez. Antes cada nombre
// vivía dos veces —en el tipo y en el destructuring que lo quitaba—, así que
// agregar un campo al tipo sin quitarlo del objeto compilaba y lo publicaba.
const ADMIN_ONLY_KYC_FIELDS = ['kycRejectionReason', 'kycProvider'] as const
const THIRD_PARTY_HIDDEN_KYC_FIELDS = [...ADMIN_ONLY_KYC_FIELDS, 'kycExpiresAt'] as const

type AdminOnlyField = (typeof ADMIN_ONLY_KYC_FIELDS)[number]
type ProfileDoc = Doc<'profiles'>

const isAdminRole = Schema.is(Schema.Literals(['ADMIN']))

/**
 * Strips admin-only KYC fields from a profile document.
 * Used for owner-facing queries (user viewing their own profile).
 *
 * Keeps: kycStatus, kycVerifiedAt, kycExpiresAt
 * Strips: kycRejectionReason, kycProvider
 */
export function stripAdminOnlyKycFields<T extends Record<string, unknown>>(
  profile: T
): Omit<T, AdminOnlyField> {
  return Struct.omit(profile, ADMIN_ONLY_KYC_FIELDS)
}

/**
 * Strips ALL sensitive KYC fields from a profile document.
 * Used for third-party queries (another user viewing someone's profile).
 *
 * Keeps: kycStatus, kycVerifiedAt (non-sensitive, needed for trust signals)
 * Strips: kycRejectionReason, kycProvider, kycExpiresAt
 */
export function stripAllSensitiveKycFields<T extends Record<string, unknown>>(
  profile: T
): Omit<T, AdminOnlyField | 'kycExpiresAt'> {
  return Struct.omit(profile, THIRD_PARTY_HIDDEN_KYC_FIELDS)
}

/**
 * Context-aware KYC field filter.
 * Applies the appropriate level of KYC field stripping based on who is requesting:
 *
 * - Admin: full profile, all KYC fields visible
 * - Owner: kycStatus + kycVerifiedAt + kycExpiresAt visible, admin-only fields stripped
 * - Third-party: kycStatus + kycVerifiedAt visible, all sensitive fields stripped
 *
 * @param profile - The profile document to filter
 * @param callerProfileId - The profile ID of the requesting user (null if unauthenticated)
 * @param callerRole - The role of the requesting user
 */
export function filterProfileKycFields(
  profile: ProfileDoc,
  callerProfileId: ProfileDoc['_id'] | null,
  callerRole: ProfileDoc['role'] | null
): ProfileDoc {
  // Admin sees everything
  if (isAdminRole(callerRole)) {
    return profile
  }

  // Owner sees their own status + expiry, but not provider/rejection reason
  if (callerProfileId && callerProfileId === profile._id) {
    return stripAdminOnlyKycFields(profile) as ProfileDoc
  }

  // Third-party sees only kycStatus + kycVerifiedAt
  return stripAllSensitiveKycFields(profile) as ProfileDoc
}
