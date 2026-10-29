// ============================================================================
// TEST FACTORIES - Mock Data Generators
// ============================================================================
// Factory functions to generate consistent mock data for tests.
// Each factory creates realistic test data that matches the Convex schema.
//
// Usage:
//   const user = createMockUser({ role: 'ADMIN' })
// ============================================================================

import type { GenericId } from 'convex/values'
import type { Id } from '../../../convex/_generated/dataModel'

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type UserRole = 'COMPANY' | 'ADMIN'
export type CapitalSeekingType = 'DEBT' | 'EQUITY' | 'BOTH' | 'BRIDGE'
export type KYCStatus =
  'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'RESUBMIT_REQUIRED'

// ============================================================================
// HELPER: Generate unique IDs
// ============================================================================

let idCounter = 0

/**
 * Generates a mock Convex ID for testing.
 * Format: mock_{table}_{counter}
 */
export function mockId<T extends string>(table: T): GenericId<T> {
  idCounter++
  return `mock_${table}_${idCounter}` as GenericId<T>
}

/**
 * Reset the ID counter (call in beforeEach)
 */
export function resetIdCounter(): void {
  idCounter = 0
}

// ============================================================================
// CONVEX USERS TABLE
// ============================================================================

export interface MockUser {
  _id: Id<'users'>
  _creationTime: number
  clerkId: string
  email: string
  name?: string
  image?: string
  role?: UserRole
  emailVerified?: boolean
  // Presente solo cuando la fila ya está enlazada a WorkOS. Su ausencia es lo
  // que distingue una sesión Clerk legacy de una WorkOS viva en los guards de
  // autorización de empresa.
  workosUserId?: string
}

export function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  const id = overrides._id ?? mockId('users')
  return {
    _id: id,
    _creationTime: Date.now(),
    clerkId: `clerk_${id}`,
    email: `user_${id}@test.sherlock.local`,
    name: 'Test User',
    role: 'COMPANY',
    emailVerified: true,
    ...overrides,
  }
}

// ============================================================================
// CONVEX PROFILES TABLE
// ============================================================================

export interface MockProfile {
  _id: Id<'profiles'>
  _creationTime: number
  userId: Id<'users'>
  role: UserRole
  fullName?: string
  phone?: string
  avatarUrl?: string
  language?: 'es' | 'en'
  timezone?: string
  emailNotifications?: boolean
  isVerified?: boolean
  isActive?: boolean
  kycStatus?: KYCStatus
  kycProvider?: string
  kycVerifiedAt?: number
  kycExpiresAt?: number
  // Convenience fields used in tests (not in actual schema)
  clerkId?: string
  preferences?: Record<string, unknown>
}

export function createMockProfile(overrides: Partial<MockProfile> = {}): MockProfile {
  return {
    _id: overrides._id ?? mockId('profiles'),
    _creationTime: Date.now(),
    userId: overrides.userId ?? mockId('users'),
    role: 'COMPANY',
    fullName: 'Test User',
    language: 'es',
    emailNotifications: true,
    isVerified: true,
    isActive: true,
    kycStatus: 'VERIFIED',
    ...overrides,
  }
}

// ============================================================================
// CONVEX COMPANIES TABLE
// ============================================================================

export interface MockCompany {
  _id: Id<'companies'>
  _creationTime: number
  ownerId: Id<'profiles'>
  name: string
  legalName?: string
  logoUrl?: string
  website?: string
  tagline?: string
  country: string
  city?: string
  sector?: string
  industry?: string
  businessModel?: string
  stage?: string
  foundedYear?: number
  employeesCount?: number
  description?: string
  revenueCurrent?: number
  grossMargin?: number
  ebitdaMargin?: number
  totalAssets?: number
  totalLiabilities?: number
  totalEquity?: number
  currency?: string
  seekingAmount?: number
  seekingType?: CapitalSeekingType
  isPublic?: boolean
  isFeatured?: boolean
  onboardingStep?: number
  onboardingCompletedAt?: number
  // Convenience fields used in tests (not in actual schema)
  isVerified?: boolean
}

export function createMockCompany(overrides: Partial<MockCompany> = {}): MockCompany {
  return {
    _id: overrides._id ?? mockId('companies'),
    _creationTime: Date.now(),
    ownerId: overrides.ownerId ?? mockId('profiles'),
    name: 'Test Company S.A.',
    legalName: 'Test Company Sociedad Anonima',
    country: 'MX',
    city: 'Mexico City',
    sector: 'technology',
    industry: 'fintech',
    businessModel: 'SAAS',
    stage: 'SERIES_A',
    foundedYear: 2020,
    employeesCount: 50,
    description: 'A test company for testing purposes',
    revenueCurrent: 5000000,
    grossMargin: 0.65,
    ebitdaMargin: 0.25,
    currency: 'USD',
    seekingAmount: 10000000,
    seekingType: 'EQUITY',
    isPublic: true,
    isFeatured: false,
    onboardingStep: 5,
    onboardingCompletedAt: Date.now(),
    ...overrides,
  }
}

// ============================================================================
// CONVEX NOTIFICATIONS TABLE
// ============================================================================

export type NotificationType =
  | 'connection_request'
  | 'connection_accepted'
  | 'new_message'
  | 'deal_interest'
  | 'deal_update'
  | 'nda_signed'
  | 'nda_expired'
  | 'document_shared'
  | 'analysis_complete'
  | 'subscription_update'
  | 'system'

export interface MockNotification {
  _id: Id<'notifications'>
  _creationTime: number
  userId: Id<'profiles'>
  type: NotificationType
  title: string
  message: string
  link?: string
  isRead?: boolean
  actorId?: Id<'profiles'>
  entityType?: string
  entityId?: string
}

export function createMockNotification(
  overrides: Partial<MockNotification> = {}
): MockNotification {
  return {
    _id: overrides._id ?? mockId('notifications'),
    _creationTime: Date.now(),
    userId: overrides.userId ?? mockId('profiles'),
    type: 'system',
    title: 'Test Notification',
    message: 'This is a test notification.',
    isRead: false,
    ...overrides,
  }
}

// ============================================================================
// CONVEX DOCUMENTS TABLE
// ============================================================================

export interface MockDocument {
  _id: Id<'documents'>
  _creationTime: number
  companyId: Id<'companies'>
  name: string
  description?: string
  fileType?: string
  fileSize?: number
  storageId?: Id<'_storage'>
  storagePath?: string
  accessLevel?: 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'
  classification?: 'PUBLIC_TEASER' | 'CONFIDENTIAL' | 'RESTRICTED' | 'LEGAL' | 'KYC_SENSITIVE'
  folder?: string
  expiresAt?: number
  isExpired?: boolean
}

export function createMockDocument(overrides: Partial<MockDocument> = {}): MockDocument {
  return {
    _id: overrides._id ?? mockId('documents'),
    _creationTime: Date.now(),
    companyId: overrides.companyId ?? mockId('companies'),
    name: 'Financial Statements Q4 2024.pdf',
    description: 'Audited financial statements',
    fileType: 'PDF',
    fileSize: 2500000,
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    folder: 'Financials',
    isExpired: false,
    ...overrides,
  }
}

// ============================================================================
// ACTIVITY LOGS
// ============================================================================

export interface MockActivityLog {
  _id: Id<'activityLogs'>
  _creationTime: number
  userId?: Id<'profiles'>
  action: string
  entityType?: string
  entityId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

export function createMockActivityLog(overrides: Partial<MockActivityLog> = {}): MockActivityLog {
  return {
    _id: overrides._id ?? mockId('activityLogs'),
    _creationTime: Date.now(),
    userId: overrides.userId ?? mockId('profiles'),
    action: 'DEAL_VIEWED',
    entityType: 'DEAL',
    entityId: mockId('deals'),
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0 (Test)',
    ...overrides,
  }
}
