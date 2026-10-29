import { createHash, randomBytes } from 'node:crypto'

import {
  ADMIN_VDR_CAPABILITY_TTL_MS,
  canonicalizeAdminVdrInput,
  type AdminVdrAction,
} from '../../../convex/_adminVdr/capabilityFormat'
import { adminVdrIdentityBindingDigest } from '../../../convex/_adminVdr/capability'
import type { Tables } from './nda-convex-harness'

export const TEST_ADMIN_SESSION_ID = 'session_admin_test_001'
const TEST_ADMIN_VDR_CAPABILITY_SECRET = 'test-admin-vdr-capability-secret-with-strong-entropy'

export async function mintAdminVdrCapability<T extends Record<string, unknown>>(args: {
  tables: Tables
  input: T
  companyId: string
  action: AdminVdrAction
  target: string
  profileId?: string
  subject?: string
  sessionId?: string
  issuedAt?: number
}): Promise<T & { adminCapability: string }> {
  const canonical = canonicalizeAdminVdrInput(args.input)
  if (!canonical) throw new Error('Invalid capability test input')
  const capability = `avc_${randomBytes(32).toString('base64url')}`
  const issuedAt = args.issuedAt ?? Date.now()
  process.env.ADMIN_VDR_CAPABILITY_SECRET ??= TEST_ADMIN_VDR_CAPABILITY_SECRET
  const identityBindingDigest = await adminVdrIdentityBindingDigest(
    args.subject ?? 'workos_admin',
    args.sessionId ?? TEST_ADMIN_SESSION_ID,
    process.env.ADMIN_VDR_CAPABILITY_SECRET
  )
  if (!identityBindingDigest) throw new Error('Invalid capability identity binding')
  args.tables.adminVdrCapabilities ??= []
  args.tables.adminVdrCapabilities.push({
    _id: `admin_vdr_capability_${args.tables.adminVdrCapabilities.length + 1}`,
    tokenHash: createHash('sha256').update(capability).digest('hex'),
    profileId: args.profileId ?? 'profile_admin',
    identityBindingDigest,
    companyId: args.companyId,
    action: args.action,
    target: args.target,
    inputDigest: createHash('sha256').update(canonical).digest('hex'),
    issuedAt,
    expiresAt: issuedAt + ADMIN_VDR_CAPABILITY_TTL_MS,
  })
  return { ...args.input, adminCapability: capability }
}
