import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AdminVdrCapabilityError,
  AdminVdrCapabilityProvider,
  useAdminVdrCapability,
} from '@/components/company/vdr/AdminVdrCapabilityContext'

const CAPABILITY_ONE = `avc_${'a'.repeat(43)}`
const CAPABILITY_TWO = `avc_${'b'.repeat(43)}`

function wrapper({ children }: { children: ReactNode }) {
  return <AdminVdrCapabilityProvider companyId="company_1">{children}</AdminVdrCapabilityProvider>
}

describe('AdminVdrCapabilityContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('returns issuer mutation input unchanged when no delegated admin company is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() => useAdminVdrCapability())
    const input = { documentId: 'document_1' }

    await expect(result.current('DOCUMENT_ARCHIVE', 'DOCUMENT:document_1', input)).resolves.toBe(
      input
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requests a fresh same-origin bearer and returns it only in the immediate mutation args', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capability: CAPABILITY_ONE }), { status: 201 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capability: CAPABILITY_TWO }), { status: 201 })
      )
    const { result } = renderHook(() => useAdminVdrCapability(), { wrapper })
    const input = { documentId: 'document_1' }

    let first: Record<string, unknown> | undefined
    let second: Record<string, unknown> | undefined
    await act(async () => {
      first = await result.current('DOCUMENT_ARCHIVE', 'DOCUMENT:document_1', input)
      second = await result.current('DOCUMENT_ARCHIVE', 'DOCUMENT:document_1', input)
    })

    expect(first).toEqual({ ...input, adminCapability: CAPABILITY_ONE })
    expect(second).toEqual({ ...input, adminCapability: CAPABILITY_TWO })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/admin/vdr-capabilities')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(init?.body))).toEqual({
      companyId: 'company_1',
      action: 'DOCUMENT_ARCHIVE',
      target: 'DOCUMENT:document_1',
      input,
    })
    expect(String(url)).not.toContain('avc_')
    expect(document.cookie).not.toContain('avc_')
    expect(JSON.stringify({ ...localStorage })).not.toContain('avc_')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('avc_')
  })

  it('fails closed with a stable local error code, never a machine token as message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'sensitive provider detail', requestId: 'req-admin-capability' }),
        { status: 403 }
      )
    )
    const { result } = renderHook(() => useAdminVdrCapability(), { wrapper })

    const rejection = await result
      .current('DOCUMENT_ARCHIVE', 'DOCUMENT:document_1', { documentId: 'document_1' })
      .then(
        () => null,
        (error: unknown) => error
      )

    expect(rejection).toBeInstanceOf(AdminVdrCapabilityError)
    expect((rejection as AdminVdrCapabilityError).code).toBe('ADMIN_VDR_CAPABILITY_UNAVAILABLE')
    // El token de máquina vive en `code`, nunca en `message`: un `message` acaba
    // renderizado en un toast y el usuario no puede hacer nada con él.
    expect((rejection as Error).message).not.toContain('ADMIN_VDR_CAPABILITY_UNAVAILABLE')
    expect(String(rejection)).not.toContain('sensitive provider detail')
    expect(String(rejection)).not.toContain('req-admin-capability')
  })
})
