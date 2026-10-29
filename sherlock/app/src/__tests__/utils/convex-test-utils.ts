// ============================================================================
// CONVEX TEST UTILITIES
// ============================================================================
// Helper functions for testing Convex queries, mutations, and actions.
// Provides standardized mocking patterns for Convex operations.
//
// Usage:
//   const { mockQuery, mockMutation } = createConvexMocks()
//   mockQuery.mockResolvedValue(mockDeal)
// ============================================================================

import { vi, type Mock } from 'vitest'
import type { MutationMeta } from 'convex/server'
import type { GenericId } from 'convex/values'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Represents a mock Convex context for testing mutations and queries.
 * Includes runQuery and runMutation for compatibility with AuthContext type.
 */
export interface MockConvexCtx {
  db: MockConvexDB
  auth: MockConvexAuth
  storage: MockConvexStorage
  scheduler: MockConvexScheduler
  meta: MutationMeta
  // Required by AuthContext type for mutations that call other queries/mutations
  runQuery: Mock
  runSnapshotQuery: Mock
  runMutation: Mock
}

interface MockConvexDB {
  get: Mock
  insert: Mock
  patch: Mock
  delete: Mock
  replace: Mock
  query: Mock
  // Required by GenericDatabaseWriter type
  system: MockConvexDBSystem
  normalizeId: Mock
}

interface MockConvexDBSystem {
  get: Mock
  query: Mock
  normalizeId: Mock
}

interface MockConvexAuth {
  getUserIdentity: Mock
}

interface MockConvexStorage {
  getUrl: Mock
  generateUploadUrl: Mock
  delete: Mock
  getMetadata: Mock
}

interface MockConvexScheduler {
  runAfter: Mock
  runAt: Mock
  cancel: Mock
}

// ============================================================================
// MOCK USER IDENTITY
// ============================================================================

export interface MockUserIdentity {
  subject: string // provider ID (WorkOS o Clerk legacy)
  tokenIdentifier: string
  email?: string
  name?: string
  pictureUrl?: string
  // `getIdentityAuthProvider` clasifica por issuer: ausente o Clerk => 'clerk',
  // el de WorkOS => 'workos'. Sin este campo no se puede montar una sesión
  // WorkOS viva en tests.
  issuer?: string
}

/**
 * Creates a mock user identity for authenticated requests.
 */
export function createMockUserIdentity(
  overrides: Partial<MockUserIdentity> = {}
): MockUserIdentity {
  const subject = overrides.subject ?? `clerk_test_${Date.now()}`
  return {
    subject,
    tokenIdentifier: `https://clerk.dev|${subject}`,
    email: 'fixture-67c970cb@example.com',
    name: 'Test User',
    ...overrides,
  }
}

// ============================================================================
// MOCK CONVEX CONTEXT
// ============================================================================

/**
 * Creates a complete mock Convex context for testing.
 * Includes db, auth, storage, and scheduler mocks.
 */
export function createMockConvexCtx(): MockConvexCtx {
  // ===== DB MOCK =====
  const mockQueryBuilder = {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    unique: vi.fn().mockResolvedValue(null),
    collect: vi.fn().mockResolvedValue([]),
    take: vi.fn().mockResolvedValue([]),
  }

  // ===== SYSTEM DB MOCK (for accessing system tables) =====
  const systemDb: MockConvexDBSystem = {
    get: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockReturnValue(mockQueryBuilder),
    normalizeId: vi.fn().mockImplementation((table: string, id: string) => id),
  }

  const db: MockConvexDB = {
    get: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockImplementation(async (table: string) => {
      return `mock_${table}_${Date.now()}` as GenericId<string>
    }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    replace: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue(mockQueryBuilder),
    system: systemDb,
    normalizeId: vi.fn().mockImplementation((table: string, id: string) => id),
  }

  // ===== AUTH MOCK =====
  const auth: MockConvexAuth = {
    getUserIdentity: vi.fn().mockResolvedValue(null),
  }

  // ===== STORAGE MOCK =====
  const storage: MockConvexStorage = {
    getUrl: vi.fn().mockResolvedValue('https://storage.convex.cloud/mock-file'),
    generateUploadUrl: vi.fn().mockResolvedValue('https://storage.convex.cloud/upload'),
    delete: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue({
      contentType: 'application/octet-stream',
      size: 1024,
    }),
  }

  // ===== SCHEDULER MOCK =====
  const scheduler: MockConvexScheduler = {
    runAfter: vi.fn().mockResolvedValue('scheduled_123'),
    runAt: vi.fn().mockResolvedValue('scheduled_456'),
    cancel: vi.fn().mockResolvedValue(undefined),
  }

  // ===== RUN QUERY/MUTATION MOCKS =====
  // These allow mutations to call other queries/mutations internally
  const runQuery = vi.fn().mockResolvedValue(null)
  const runSnapshotQuery = vi.fn().mockResolvedValue(null)
  const runMutation = vi.fn().mockResolvedValue(null)

  const transactionMetrics = {
    bytesRead: { used: 0, remaining: 1_000_000 },
    bytesWritten: { used: 0, remaining: 1_000_000 },
    databaseQueries: { used: 0, remaining: 1_000 },
    documentsRead: { used: 0, remaining: 1_000 },
    documentsWritten: { used: 0, remaining: 1_000 },
    functionsScheduled: { used: 0, remaining: 1_000 },
    scheduledFunctionArgsBytes: { used: 0, remaining: 1_000_000 },
  }

  const meta: MutationMeta = {
    getFunctionMetadata: vi.fn().mockResolvedValue({
      name: 'test/mock:handler',
      componentPath: '',
      type: 'mutation',
      visibility: 'public',
    }),
    getTransactionMetrics: vi.fn().mockResolvedValue(transactionMetrics),
    getDeploymentMetadata: vi.fn().mockResolvedValue({
      name: 'local-test',
      region: null,
      class: 's16',
    }),
    getRequestMetadata: vi.fn().mockResolvedValue({
      ip: null,
      userAgent: null,
      requestId: 'test-request-id',
    }),
  }

  return {
    db,
    auth,
    storage,
    scheduler,
    meta,
    runQuery,
    runSnapshotQuery,
    runMutation,
  }
}

// ============================================================================
// MOCK QUERY BUILDER
// ============================================================================

/**
 * Creates a chainable mock query builder that mimics Convex query behavior.
 */
export function createMockQueryBuilder<T>(results: T[] = []) {
  const builder = {
    withIndex: vi.fn().mockReturnThis(),
    withSearchIndex: vi.fn().mockReturnThis(), // Full-text search support
    filter: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(results[0] ?? null),
    unique: vi.fn().mockResolvedValue(results[0] ?? null),
    collect: vi.fn().mockResolvedValue(results),
    take: vi.fn().mockImplementation((n: number) => Promise.resolve(results.slice(0, n))),
    paginate: vi.fn().mockImplementation(() =>
      Promise.resolve({
        page: results,
        continueCursor: null,
        isDone: true,
      })
    ),
  }
  return builder
}

// ============================================================================
// AUTH TESTING HELPERS
// ============================================================================

/**
 * Configure the mock context for an authenticated user.
 */
export function mockAuthenticatedUser(
  ctx: MockConvexCtx,
  identity: MockUserIdentity = createMockUserIdentity()
): void {
  ctx.auth.getUserIdentity.mockResolvedValue(identity)
}

/**
 * Configure the mock context for an unauthenticated request.
 */
export function mockUnauthenticatedRequest(ctx: MockConvexCtx): void {
  ctx.auth.getUserIdentity.mockResolvedValue(null)
}

// ============================================================================
// REAL CONVEX FUNCTION INVOCATION
// ============================================================================

/**
 * Unwraps the handler of a registered Convex query/mutation so tests can invoke
 * the REAL production code against a mock context instead of asserting on their
 * own mocks (which tests Vitest, not the app).
 *
 * `convex` exposes the original function as `_handler` on the registered object;
 * if a future upgrade renames it this throws loudly instead of silently making
 * every suite that uses it vacuous.
 */
export function convexHandler<Args, Result>(
  registered: unknown
): (ctx: MockConvexCtx, args: Args) => Promise<Result> {
  const handler = (registered as { _handler?: unknown })?._handler

  if (typeof handler !== 'function') {
    throw new Error(
      'convexHandler(): registered Convex function does not expose `_handler`. ' +
        'The convex runtime API changed — update this helper instead of weakening the tests.'
    )
  }

  return handler as (ctx: MockConvexCtx, args: Args) => Promise<Result>
}

/**
 * Parses the argument validator that a registered Convex function ships to the
 * server. Lets tests assert on the REAL validator (enum members, optionality)
 * instead of on a locally declared array of strings.
 */
export function convexArgsValidator(registered: unknown): Record<string, unknown> {
  const exportArgs = (registered as { exportArgs?: () => string })?.exportArgs

  if (typeof exportArgs !== 'function') {
    throw new Error(
      'convexArgsValidator(): registered Convex function does not expose `exportArgs`.'
    )
  }

  return JSON.parse(exportArgs()) as Record<string, unknown>
}

interface ExportedValidatorField {
  fieldType: { type: string; value?: Array<{ type: string; value: unknown }> }
  optional: boolean
}

function validatorField(validator: Record<string, unknown>, field: string): ExportedValidatorField {
  const properties = validator.value as Record<string, ExportedValidatorField> | undefined
  const entry = properties?.[field]

  if (!entry) {
    throw new Error(`validatorField(): field "${field}" is not part of the validator`)
  }

  return entry
}

/**
 * Extracts the literal members of a `v.union(v.literal(...), ...)` argument
 * declared by a registered Convex function (optional wrappers included).
 */
export function unionLiteralsOf(validator: Record<string, unknown>, field: string): string[] {
  const { fieldType } = validatorField(validator, field)

  return (fieldType.value ?? [])
    .filter((member) => member.type === 'literal')
    .map((member) => String(member.value))
}

/**
 * True when the argument is declared with `v.optional(...)`.
 */
export function isOptionalArg(validator: Record<string, unknown>, field: string): boolean {
  return validatorField(validator, field).optional === true
}
