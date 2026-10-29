// ============================================================================
// registerDirectUpload — REGISTRO DE SUBIDA DIRECTA NAVEGADOR → CONVEX STORAGE
// ============================================================================
// Camino directo del VDR (decisión 6, DESIGN-ONBOARDING-VDR-2026-07-31): el
// archivo ya NO viaja por la serverless function de Vercel (que corta el body
// en ~4.5MB con un 413), sino que el navegador hace POST directo a la URL de
// `generateUploadUrl` y luego registra la metadata con esta mutation.
//
// Contrato de seguridad bajo prueba:
// - requireAuth + rol (COMPANY/ADMIN) + ownership de la empresa dueña de la sala
// - el tamaño REAL sale de ctx.db.system.get(storageId) (lo midió Convex), y el
//   contentType es el que Convex registró en el POST de subida — jamás los args
//   de la mutation
// - blob inválido (muy grande / tipo no permitido) se BORRA del storage para no
//   dejar alojamiento huérfano bajo nuestro dominio; el rechazo se DEVUELVE
//   como resultado estructurado (no throw: un throw revertiría el delete —
//   mismo razonamiento que accessResult.ts)
// - un storageId ya referenciado por otro documento no se re-vincula (borrar un
//   documento borraría el blob del otro)
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireAuth,
  mockEnforceRateLimit,
  mockFindDocumentByStorageId,
  mockLoadCompanyOrThrow,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockFindDocumentByStorageId: vi.fn(),
  mockLoadCompanyOrThrow: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_helpers/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}))

vi.mock('../../../convex/_documents/shared', () => ({
  cleanUndefinedFields: (updates: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)),
  findDocumentByStorageId: (...args: unknown[]) => mockFindDocumentByStorageId(...args),
  loadDocumentOrThrow: vi.fn(),
  loadCompanyOrThrow: (...args: unknown[]) => mockLoadCompanyOrThrow(...args),
  // Réplica fiel del helper real: dueño o ADMIN, si no lanza con el mensaje dado.
  requireCompanyOwnerOrAdmin: (
    profile: { _id: string; role: string },
    company: { ownerId: string },
    message: string
  ) => {
    if (profile.role !== 'ADMIN' && company.ownerId !== profile._id) {
      throw new Error(message)
    }
  },
  revokeGrantsForDocument: vi.fn(),
}))

import { registerDirectUpload } from '../../../convex/_documents/mutations'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>

const register = (registerDirectUpload as unknown as { _handler: Handler })._handler

function makeCtx() {
  return {
    db: {
      get: vi.fn(),
      insert: vi.fn().mockResolvedValue('document_new'),
      system: { get: vi.fn() },
    },
    storage: { delete: vi.fn() },
  }
}

const OWNER_PROFILE = { _id: 'profile_1', role: 'COMPANY' }

const BASE_ARGS = {
  companyId: 'company_1',
  storageId: 'storage_1',
  name: 'Pitch deck',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({
    user: { _id: 'user_1', email: 'company@example.com' },
    profile: OWNER_PROFILE,
  })
})

describe('registerDirectUpload — compatibilidad legacy fail-closed', () => {
  it('rechaza un storageId crudo sin leer, borrar ni registrar el blob', async () => {
    const ctx = makeCtx()

    await expect(register(ctx, BASE_ARGS)).rejects.toMatchObject({
      data: expect.objectContaining({
        code: 'BUSINESS_INVALID_STATE',
        details: expect.objectContaining({
          currentState: 'LEGACY_DIRECT_UPLOAD_DISABLED',
        }),
      }),
    })
    expect(mockRequireAuth).toHaveBeenCalledWith(ctx)
    expect(ctx.db.get).not.toHaveBeenCalled()
    expect(ctx.db.system.get).not.toHaveBeenCalled()
    expect(ctx.db.insert).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })
})
