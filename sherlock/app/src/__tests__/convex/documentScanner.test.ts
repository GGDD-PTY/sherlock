import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  requiresConfiguredScanner,
  scanFileWithConfiguredGateway,
} from '../../../convex/_documents/scanner'

describe('private VDR file scanner gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allows an unconfigured scanner only in explicitly declared dev', async () => {
    await expect(
      scanFileWithConfiguredGateway(new Blob(['safe']), 'sha256', { CONVEX_ENV: 'dev' })
    ).resolves.toEqual({ status: 'NOT_CONFIGURED' })
    expect(requiresConfiguredScanner({ CONVEX_ENV: 'dev' })).toBe(false)
    expect(requiresConfiguredScanner({ CONVEX_ENV: 'production' })).toBe(true)
  })

  it('honors the explicit [F] production opt-out and stays fail-closed otherwise', async () => {
    expect(
      requiresConfiguredScanner({ CONVEX_ENV: 'production', VDR_SCANNER_OPTIONAL: 'true' })
    ).toBe(false)
    await expect(
      scanFileWithConfiguredGateway(new Blob(['safe']), 'sha256', {
        CONVEX_ENV: 'production',
        VDR_SCANNER_OPTIONAL: 'true',
      })
    ).resolves.toEqual({ status: 'NOT_CONFIGURED' })
    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      expect(
        requiresConfiguredScanner({ CONVEX_ENV: 'production', VDR_SCANNER_OPTIONAL: value })
      ).toBe(true)
    }
  })

  it.each([undefined, 'prodution', 'production ', 'local'])(
    'fails closed when CONVEX_ENV is missing or invalid (%s)',
    async (convexEnv) => {
      const environment = convexEnv === undefined ? {} : { CONVEX_ENV: convexEnv }

      expect(requiresConfiguredScanner(environment)).toBe(true)
      await expect(
        scanFileWithConfiguredGateway(new Blob(['safe']), 'sha256', environment)
      ).resolves.toEqual({ status: 'ERROR' })
    }
  )

  it('accepts only a bounded clean-verdict envelope and sends no business metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: 'CLEAN',
          engine: 'private-multiscan',
          scanId: 'scan_123',
          definitionVersion: '2026.08.02',
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await scanFileWithConfiguredGateway(new Blob(['safe']), 'trusted-sha256', {
      CONVEX_ENV: 'production',
      VDR_FILE_SCANNER_URL: 'https://scanner.private.example/v1/scan',
      VDR_FILE_SCANNER_TOKEN: 'secret-token',
    })

    expect(result).toMatchObject({
      status: 'CLEAN',
      engine: 'private-multiscan',
      scanId: 'scan_123',
      definitionVersion: '2026.08.02',
      scannedAt: expect.any(Number),
    })
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(request.headers).toEqual({
      authorization: 'Bearer secret-token',
      'content-type': 'application/octet-stream',
      'x-content-sha256': 'trusted-sha256',
    })
    expect(JSON.stringify(request.headers)).not.toMatch(/company|deal|filename|person/i)
  })

  it('propagates an infected verdict without exposing malware internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            verdict: 'INFECTED',
            engine: 'private-multiscan',
            scanId: 'scan_456',
          }),
          { status: 200 }
        )
      )
    )

    await expect(
      scanFileWithConfiguredGateway(new Blob(['unsafe']), 'sha256', {
        CONVEX_ENV: 'production',
        VDR_FILE_SCANNER_URL: 'https://scanner.private.example/v1/scan',
        VDR_FILE_SCANNER_TOKEN: 'secret-token',
      })
    ).resolves.toMatchObject({ status: 'INFECTED', scanId: 'scan_456' })
  })

  it('fails closed for insecure endpoints, partial config, and malformed responses', async () => {
    const blob = new Blob(['safe'])
    await expect(
      scanFileWithConfiguredGateway(blob, 'sha256', {
        CONVEX_ENV: 'production',
        VDR_FILE_SCANNER_URL: 'http://scanner.example/v1/scan',
        VDR_FILE_SCANNER_TOKEN: 'secret-token',
      })
    ).resolves.toEqual({ status: 'ERROR' })
    await expect(
      scanFileWithConfiguredGateway(blob, 'sha256', {
        CONVEX_ENV: 'production',
        VDR_FILE_SCANNER_URL: 'https://scanner.example/v1/scan',
      })
    ).resolves.toEqual({ status: 'ERROR' })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ verdict: 'MAYBE' }), { status: 200 }))
    )
    await expect(
      scanFileWithConfiguredGateway(blob, 'sha256', {
        CONVEX_ENV: 'production',
        VDR_FILE_SCANNER_URL: 'https://scanner.example/v1/scan',
        VDR_FILE_SCANNER_TOKEN: 'secret-token',
      })
    ).resolves.toEqual({ status: 'ERROR' })
  })

  it('allows loopback http only in explicit dev and rejects it in production', async () => {
    const blob = new Blob(['safe'])
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: 'CLEAN',
          engine: 'clamav',
          scanId: 'scan_loopback',
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      scanFileWithConfiguredGateway(blob, 'sha256', {
        CONVEX_ENV: 'dev',
        VDR_FILE_SCANNER_URL: 'http://127.0.0.1:8080/v1/scan',
        VDR_FILE_SCANNER_TOKEN: 'secret-token',
      })
    ).resolves.toMatchObject({ status: 'CLEAN', scanId: 'scan_loopback' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await expect(
      scanFileWithConfiguredGateway(blob, 'sha256', {
        CONVEX_ENV: 'production',
        VDR_FILE_SCANNER_URL: 'http://127.0.0.1:8080/v1/scan',
        VDR_FILE_SCANNER_TOKEN: 'secret-token',
      })
    ).resolves.toEqual({ status: 'ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed for empty, oversized, and unbounded evidence envelopes', async () => {
    const blob = new Blob(['safe'])
    const env = {
      CONVEX_ENV: 'production',
      VDR_FILE_SCANNER_URL: 'https://scanner.private.example/v1/scan',
      VDR_FILE_SCANNER_TOKEN: 'secret-token',
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
    await expect(scanFileWithConfiguredGateway(blob, 'sha256', env)).resolves.toEqual({
      status: 'ERROR',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(8_193), { status: 200 }))
    )
    await expect(scanFileWithConfiguredGateway(blob, 'sha256', env)).resolves.toEqual({
      status: 'ERROR',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            verdict: 'CLEAN',
            engine: 'e'.repeat(101),
            scanId: 'scan_123',
          }),
          { status: 200 }
        )
      )
    )
    await expect(scanFileWithConfiguredGateway(blob, 'sha256', env)).resolves.toEqual({
      status: 'ERROR',
    })
  })
})
