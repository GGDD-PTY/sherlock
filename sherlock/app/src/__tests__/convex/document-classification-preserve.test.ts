// ============================================================================
// REGRESIÓN — cambiar el nivel de acceso NO debe resetear la clasificación
// ============================================================================
// Bug: MyCompanyDocuments.handleAccessChange mandaba
// `classification: inferClassificationFromAccessLevel(newAccess)` (el default del
// nivel), así que bajar un doc CONFIDENTIAL a acceso PUBLIC lo desclasificaba a
// PUBLIC_TEASER. El fix es que el cliente deje de mandar `classification`; este
// test blinda el CONTRATO del que depende ese fix: la mutation `update` preserva
// la clasificación guardada cuando solo cambia `accessLevel`, y una
// desclasificación EXPLÍCITA (el diálogo del data room) sigue funcionando.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequireAuth, mockLogAdminAction } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockLogAdminAction: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_helpers/auditLog', () => ({
  logAdminAction: (...args: unknown[]) => mockLogAdminAction(...args),
}))

vi.mock('../../../convex/_adminVdr/capability', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>
  return {
    ...actual,
    requireAdminVdrCapability: vi.fn(async () => undefined),
  }
})

// Mantener cleanUndefinedFields real; solo interceptar los loaders y el guard.
vi.mock('../../../convex/_documents/shared', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>
  return {
    ...actual,
    loadDocumentOrThrow: vi.fn(),
    loadCompanyOrThrow: vi.fn(async () => ({ _id: 'company_1', ownerId: 'profile_owner' })),
    requireCompanyOwnerOrAdmin: vi.fn(),
  }
})

import { update } from '../../../convex/_documents/mutations'
import { loadDocumentOrThrow } from '../../../convex/_documents/shared'

const runHandler = (fn: unknown, ctx: unknown, args: Record<string, unknown>) =>
  (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler(
    ctx,
    args
  )

function createCtx() {
  return {
    db: {
      patch: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ _id: 'doc_1' })),
    },
  }
}

const CONFIDENTIAL_DOC = {
  _id: 'doc_1',
  companyId: 'company_1',
  accessLevel: 'NDA_REQUIRED' as const,
  classification: 'CONFIDENTIAL' as const,
}

// Doc legacy: `classification` es opcional en el schema, así que puede faltar.
// Su clasificación EFECTIVA se deriva del accessLevel actual (NDA_REQUIRED →
// CONFIDENTIAL) y también debe preservarse al cambiar el acceso.
const LEGACY_DOC_WITHOUT_CLASSIFICATION = {
  _id: 'doc_1',
  companyId: 'company_1',
  accessLevel: 'NDA_REQUIRED' as const,
  classification: undefined,
}

describe('documents.update: cambiar accessLevel no resetea la clasificación', () => {
  beforeEach(() => {
    mockRequireAuth.mockReset()
    mockLogAdminAction.mockReset()
    mockRequireAuth.mockResolvedValue({
      user: { email: 'owner@example.com' },
      profile: { _id: 'profile_owner', role: 'COMPANY' },
    })
    vi.mocked(loadDocumentOrThrow).mockReset()
    vi.mocked(loadDocumentOrThrow).mockResolvedValue(CONFIDENTIAL_DOC as never)
  })

  it('bajar el acceso a PUBLIC sin classification preserva CONFIDENTIAL (no desclasifica)', async () => {
    const ctx = createCtx()

    await runHandler(update, ctx, { documentId: 'doc_1', accessLevel: 'PUBLIC' })

    expect(ctx.db.patch).toHaveBeenCalledTimes(1)
    const [, patched] = ctx.db.patch.mock.calls[0] as unknown as [
      unknown,
      { classification: string },
    ]
    expect(patched.classification).toBe('CONFIDENTIAL')
    expect(patched.classification).not.toBe('PUBLIC_TEASER')
  })

  it('doc legacy SIN classification guardada: bajar a PUBLIC preserva la efectiva (CONFIDENTIAL)', async () => {
    vi.mocked(loadDocumentOrThrow).mockResolvedValue(LEGACY_DOC_WITHOUT_CLASSIFICATION as never)
    const ctx = createCtx()

    await runHandler(update, ctx, { documentId: 'doc_1', accessLevel: 'PUBLIC' })

    expect(ctx.db.patch).toHaveBeenCalledTimes(1)
    const [, patched] = ctx.db.patch.mock.calls[0] as unknown as [
      unknown,
      { classification: string },
    ]
    expect(patched.classification).toBe('CONFIDENTIAL')
    expect(patched.classification).not.toBe('PUBLIC_TEASER')
  })

  it('una desclasificación EXPLÍCITA sí se honra (el diálogo del data room)', async () => {
    const ctx = createCtx()

    await runHandler(update, ctx, {
      documentId: 'doc_1',
      accessLevel: 'PUBLIC',
      classification: 'PUBLIC_TEASER',
    })

    const [, patched] = ctx.db.patch.mock.calls[0] as unknown as [
      unknown,
      { classification: string },
    ]
    expect(patched.classification).toBe('PUBLIC_TEASER')
  })

  it('ADMIN puede quitar el vencimiento y deja evidencia de auditoría', async () => {
    mockRequireAuth.mockResolvedValue({
      user: { email: 'fixture-14e4636f@example.com' },
      profile: { _id: 'profile_admin', role: 'ADMIN' },
    })
    vi.mocked(loadDocumentOrThrow).mockResolvedValue({
      ...CONFIDENTIAL_DOC,
      expiresAt: 1_800_000_000_000,
    } as never)
    const ctx = createCtx()

    await runHandler(update, ctx, { documentId: 'doc_1', expiresAt: null })

    const [, patched] = ctx.db.patch.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(patched).toHaveProperty('expiresAt', undefined)
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        adminEmail: 'fixture-14e4636f@example.com',
        action: 'DOCUMENT_METADATA_UPDATE',
        targetType: 'DOCUMENT',
        targetId: 'doc_1',
        previousValue: expect.objectContaining({ expiresAt: 1_800_000_000_000 }),
        newValue: expect.objectContaining({ expiresAt: null }),
      })
    )
  })
})
