// ============================================================================
// TESTS: useWorkOSAuthImpl
// ============================================================================
// El hook mapea el usuario de AuthKit y entrega el access token. Lo único que
// puede fallar es el token, y su fallo se colapsa a `null` a propósito: un
// rechazo de AuthKit no puede tumbar a quien pide el token. Estas pruebas fijan
// ese contrato — antes no existía ninguna.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAccessToken, useAuth as useAuthKit } from '@workos-inc/authkit-nextjs/components'
import { useWorkOSAuthImpl } from '@/hooks/useWorkOSAuth'

function mockAccessToken(getAccessToken: () => Promise<string | undefined | null>) {
  vi.mocked(useAccessToken).mockReturnValue({
    getAccessToken,
    refresh: vi.fn().mockResolvedValue(null),
    accessToken: undefined,
    loading: false,
  } as unknown as ReturnType<typeof useAccessToken>)
}

describe('useWorkOSAuthImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useAuthKit).mockReturnValue({
      user: null,
      loading: false,
      signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuthKit>)
  })

  // ===== EL TOKEN =====

  it('devuelve el access token cuando AuthKit lo entrega', async () => {
    mockAccessToken(vi.fn().mockResolvedValue('tok_live_123'))

    const { result } = renderHook(() => useWorkOSAuthImpl())

    await expect(result.current.getToken()).resolves.toBe('tok_live_123')
  })

  it('devuelve null cuando AuthKit resuelve sin token', async () => {
    mockAccessToken(vi.fn(async (): Promise<string | undefined> => undefined))

    const { result } = renderHook(() => useWorkOSAuthImpl())

    await expect(result.current.getToken()).resolves.toBeNull()
  })

  it('colapsa el rechazo de AuthKit en null, sin propagarlo', async () => {
    mockAccessToken(vi.fn().mockRejectedValue(new Error('sesión expirada')))

    const { result } = renderHook(() => useWorkOSAuthImpl())

    await expect(result.current.getToken()).resolves.toBeNull()
  })

  // ===== EL MAPEO DEL USUARIO =====

  it('mapea el usuario de AuthKit sin inventar campos', () => {
    mockAccessToken(vi.fn().mockResolvedValue(null))
    vi.mocked(useAuthKit).mockReturnValue({
      user: {
        id: 'user_1',
        email: 'fixture-63e3410d@example.com',
        firstName: 'Ana',
        lastName: 'Pérez',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      loading: false,
      signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuthKit>)

    const { result } = renderHook(() => useWorkOSAuthImpl())

    expect(result.current.isSignedIn).toBe(true)
    expect(result.current.userId).toBe('user_1')
    expect(result.current.user?.name).toBe('Ana Pérez')
    expect(result.current.isDevMode).toBe(false)
  })

  it('no entrega usuario cuando AuthKit no tiene sesión', () => {
    mockAccessToken(vi.fn().mockResolvedValue(null))

    const { result } = renderHook(() => useWorkOSAuthImpl())

    expect(result.current.isSignedIn).toBe(false)
    expect(result.current.user).toBeNull()
    expect(result.current.userId).toBeNull()
  })
})
