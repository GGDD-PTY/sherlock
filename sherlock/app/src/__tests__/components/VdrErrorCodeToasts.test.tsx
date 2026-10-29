import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuth } from '@/hooks/useAuth'

const mockUpdateDocument = vi.hoisted(() => vi.fn())
const mockGetDownloadUrl = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      update: 'documents:update',
      getDownloadUrl: 'documents:getDownloadUrl',
    },
  },
}))

// Mensajes crudos del backend: español, sin importar el locale del usuario.
// Ninguno de ellos puede aparecer nunca en un toast.
const RAW_ES_VALIDITY = 'La vigencia debe estar entre 1 y 90 días.'
const RAW_ES_NDA_DENIAL = 'Debes firmar un NDA activo para acceder a este documento.'
const MACHINE_TOKEN = 'ADMIN_VDR_CAPABILITY_UNAVAILABLE'

function convexBusinessError(message: string, code: string, reason?: string) {
  return Object.assign(new Error(message), {
    name: 'ConvexError',
    data: {
      code,
      message,
      details: reason ? { field: 'accessDays', reason } : undefined,
    },
  })
}

describe('VDR error-code toasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateDocument.mockResolvedValue({})
    mockGetDownloadUrl.mockResolvedValue(null)
    mockUseMutation.mockImplementation((reference: unknown) => {
      if (reference === 'documents:update') return mockUpdateDocument
      if (reference === 'documents:getDownloadUrl') return mockGetDownloadUrl
      throw new Error('Unexpected mutation reference')
    })
  })

  describe('config error-code resolution', () => {
    it('reads the stable code from a Convex business error without touching its message', async () => {
      const { resolveBusinessErrorCode } = await import('@/components/company/vdr/config')

      expect(
        resolveBusinessErrorCode(
          convexBusinessError(RAW_ES_VALIDITY, 'VALIDATION_FAILED', 'ROOM_ACCESS_DAYS_OUT_OF_RANGE')
        )
      ).toBe('ROOM_ACCESS_DAYS_OUT_OF_RANGE')
      expect(
        resolveBusinessErrorCode(
          convexBusinessError('No tienes permiso para realizar esta acción', 'AUTHZ_UNAUTHORIZED')
        )
      ).toBe('AUTHZ_UNAUTHORIZED')
      expect(
        resolveBusinessErrorCode(Object.assign(new Error('boom'), { code: MACHINE_TOKEN }))
      ).toBe(MACHINE_TOKEN)
      expect(resolveBusinessErrorCode(new Error('network down'))).toBeNull()
      expect(resolveBusinessErrorCode(undefined)).toBeNull()
    })

    it('prefers details.currentState when reason is absent, then falls back if unmapped', async () => {
      const { resolveBusinessErrorCode, businessErrorMessage } =
        await import('@/components/company/vdr/config')
      const error = Object.assign(new Error('El ciclo ya está COMPLETED'), {
        data: {
          code: 'BUSINESS_INVALID_STATE',
          details: { currentState: 'COMPLETED' },
        },
      })

      expect(resolveBusinessErrorCode(error)).toBe('COMPLETED')
      expect(
        businessErrorMessage(error, { BUSINESS_INVALID_STATE: 'Estado inválido.' }, 'fallback')
      ).toBe('fallback')
    })

    it('falls back to localized copy instead of the raw message for unmapped codes', async () => {
      const { businessErrorMessage } = await import('@/components/company/vdr/config')
      const map = { ROOM_ACCESS_DAYS_OUT_OF_RANGE: 'Vigencia fuera de rango.' }

      expect(
        businessErrorMessage(
          convexBusinessError(
            RAW_ES_VALIDITY,
            'VALIDATION_FAILED',
            'ROOM_ACCESS_DAYS_OUT_OF_RANGE'
          ),
          map,
          'fallback'
        )
      ).toBe('Vigencia fuera de rango.')
      expect(businessErrorMessage(new Error(RAW_ES_VALIDITY), map, 'fallback')).toBe('fallback')
      expect(
        businessErrorMessage(Object.assign(new Error('x'), { code: '__proto__' }), map, 'fallback')
      ).toBe('fallback')
    })

    it('ships every VDR denial and mutation code in both locales, Panamanian tuteo in es', async () => {
      const { VDR_COPY } = await import('@/components/company/vdr/config')
      const requiredDenials = [
        'REQUIRE_SIGNED_NDA',
        'REQUIRE_NDA_RENEWAL',
        'REQUIRE_VERIFIED_KYC',
        'REQUIRE_CURRENT_ROOM_GRANT',
        'REQUIRE_DOWNLOAD_GRANT',
        'REQUIRE_ACCEPTED_CONNECTION',
        'DENIED_DOCUMENT_QUARANTINED',
        'DENIED_DOCUMENT_ARCHIVED',
        'DENIED_DOCUMENT_EXPIRED',
      ]

      for (const code of requiredDenials) {
        expect(VDR_COPY.es.denialReasons[code]).toBeTruthy()
      }
      expect(VDR_COPY.es.mutationErrors[MACHINE_TOKEN]).toBeTruthy()

      const spanishValues = [
        ...Object.values(VDR_COPY.es.denialReasons),
        ...Object.values(VDR_COPY.es.mutationErrors),
      ]
      for (const value of spanishValues) {
        expect(value).not.toMatch(/\b(tenés|podés|debés|querés|sabés|vos|vosotros)\b/i)
        expect(value).not.toMatch(/_[A-Z]/)
      }
    })
  })

  describe('useVdrDocumentActions', () => {
    const documentFixture = {
      _id: 'document_1',
      name: 'Financial model.pdf',
      folder: 'financial_model',
      accessLevel: 'NDA_REQUIRED' as const,
      expiresAt: null,
    }

    beforeEach(() => {
      vi.mocked(useAuth).mockReturnValue({
        user: { id: 'user_1' },
        isLoaded: true,
        isSignedIn: true,
        userId: 'user_1',
        signOut: vi.fn(),
        getToken: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof useAuth>)
    })

    it('translates a policy denial code instead of rendering the Spanish policy message', async () => {
      mockGetDownloadUrl.mockResolvedValue({
        allowed: false,
        code: 'REQUIRE_SIGNED_NDA',
        message: RAW_ES_NDA_DENIAL,
      })
      const { useVdrDocumentActions } =
        await import('@/components/company/vdr/useVdrDocumentActions')
      const { VDR_COPY } = await import('@/components/company/vdr/config')

      const { result } = renderHook(() =>
        useVdrDocumentActions({
          copy: VDR_COPY.es,
          locale: 'es',
          isDemo: false,
          bumpDemoVersion: vi.fn(),
        })
      )

      await act(async () => {
        await result.current.openDocument(documentFixture)
      })

      expect(toast.error).toHaveBeenCalledWith(VDR_COPY.es.denialReasons.REQUIRE_SIGNED_NDA)
      expect(toast.error).not.toHaveBeenCalledWith(RAW_ES_NDA_DENIAL)
    })

    it('falls back to localized open-error copy for an unknown denial code', async () => {
      mockGetDownloadUrl.mockResolvedValue({
        allowed: false,
        code: 'DENIED_SOMETHING_BRAND_NEW',
        message: 'Mensaje interno del backend.',
      })
      const { useVdrDocumentActions } =
        await import('@/components/company/vdr/useVdrDocumentActions')
      const { VDR_COPY } = await import('@/components/company/vdr/config')

      const { result } = renderHook(() =>
        useVdrDocumentActions({
          copy: VDR_COPY.es,
          locale: 'es',
          isDemo: false,
          bumpDemoVersion: vi.fn(),
        })
      )

      await act(async () => {
        await result.current.openDocument(documentFixture)
      })

      expect(toast.error).toHaveBeenCalledWith(VDR_COPY.es.openError)
    })

    it('never surfaces the admin capability token when saving a document edit', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'sensitive provider detail' }), { status: 403 })
      )
      const { AdminVdrCapabilityProvider } =
        await import('@/components/company/vdr/AdminVdrCapabilityContext')
      const { useVdrDocumentActions } =
        await import('@/components/company/vdr/useVdrDocumentActions')
      const { VDR_COPY } = await import('@/components/company/vdr/config')

      function wrapper({ children }: { children: ReactNode }) {
        return (
          <AdminVdrCapabilityProvider companyId="company_1">{children}</AdminVdrCapabilityProvider>
        )
      }

      const { result } = renderHook(
        () =>
          useVdrDocumentActions({
            copy: VDR_COPY.es,
            locale: 'es',
            isDemo: false,
            bumpDemoVersion: vi.fn(),
          }),
        { wrapper }
      )

      act(() => {
        result.current.beginEdit(documentFixture)
      })
      await act(async () => {
        await result.current.saveEdit()
      })

      expect(toast.error).toHaveBeenCalledWith(VDR_COPY.es.mutationErrors[MACHINE_TOKEN])
      expect(vi.mocked(toast.error).mock.calls.flat().join(' ')).not.toContain(MACHINE_TOKEN)
    })
  })
})
