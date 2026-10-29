import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('server-side claim conversion analytics', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_project_key')
    vi.stubEnv('POSTHOG_INGEST_HOST', 'https://eu.i.posthog.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('sends the successful claim funnel without a person, URL, or browser identifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    const captured = await captureIntakeClaimConversion({
      claimDigest: 'a'.repeat(64),
      claimedDocumentCount: 2,
      locale: 'es',
      requestHeaders: new Headers(),
    })

    expect(captured).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://eu.i.posthog.com/e/',
      expect.objectContaining({ method: 'POST', cache: 'no-store' })
    )
    const payloads = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as {
          event: string
          uuid: string
          properties: Record<string, unknown>
        }
    )
    expect(payloads.map((payload) => payload.event)).toEqual([
      'workspace_claimed',
      'first_durable_upload',
    ])
    expect(payloads[0]?.properties.distinct_id).toBe(payloads[1]?.properties.distinct_id)
    expect(payloads[0]?.properties).toMatchObject({
      token: 'phc_test_project_key',
      $process_person_profile: false,
      $geoip_disable: true,
      locale: 'es',
      mode: 'PERMANENT',
    })
    expect(payloads[1]?.properties).toMatchObject({ fileCount: 2 })
    const serialized = JSON.stringify(payloads)
    expect(serialized).not.toMatch(/email|companyId|userId|pathname|current_url/i)

    fetchMock.mockClear()
    await captureIntakeClaimConversion({
      claimDigest: 'a'.repeat(64),
      claimedDocumentCount: 2,
      locale: 'es',
      requestHeaders: new Headers(),
    })
    const replayPayloads = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as {
          event: string
          uuid: string
          properties: Record<string, unknown>
        }
    )
    expect(replayPayloads.map((payload) => payload.uuid)).toEqual(
      payloads.map((payload) => payload.uuid)
    )
    expect(replayPayloads[0]?.properties.distinct_id).toBe(payloads[0]?.properties.distinct_id)
  })

  it('honors browser privacy signals and never sends from non-production environments', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'b'.repeat(64),
        claimedDocumentCount: 1,
        locale: 'es',
        requestHeaders: new Headers({ dnt: '1' }),
      })
    ).toBe(false)

    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'b'.repeat(64),
        claimedDocumentCount: 1,
        locale: 'es',
        requestHeaders: new Headers({ 'sec-gpc': '1' }),
      })
    ).toBe(false)

    vi.stubEnv('NODE_ENV', 'development')
    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'b'.repeat(64),
        claimedDocumentCount: 1,
        locale: 'es',
        requestHeaders: new Headers(),
      })
    ).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only workspace_claimed when the claim transferred zero documents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'd'.repeat(64),
        claimedDocumentCount: 0,
        locale: 'es',
        requestHeaders: new Headers(),
      })
    ).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      event: string
      properties: Record<string, unknown>
    }
    expect(payload.event).toBe('workspace_claimed')
    expect(payload.properties).not.toHaveProperty('fileCount')
  })

  it.each([
    { label: 'digest that is not 64 hex', claimDigest: 'not-a-digest', claimedDocumentCount: 1 },
    {
      label: 'more than twenty claimed files',
      claimDigest: 'e'.repeat(64),
      claimedDocumentCount: 21,
    },
    { label: 'negative claimed files', claimDigest: 'f'.repeat(64), claimedDocumentCount: -1 },
  ])('fails closed for $label', async ({ claimDigest, claimedDocumentCount }) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    expect(
      await captureIntakeClaimConversion({
        claimDigest,
        claimedDocumentCount,
        locale: 'es',
        requestHeaders: new Headers(),
      })
    ).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed without retrying when an ingest request throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ingest timeout'))
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'a'.repeat(64),
        claimedDocumentCount: 1,
        locale: 'es',
        requestHeaders: new Headers(),
      })
    ).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the configured ingest host is absent or invalid', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { captureIntakeClaimConversion } = await import('@/lib/analytics/server')

    vi.stubEnv('POSTHOG_INGEST_HOST', 'http://analytics.example.com')
    expect(
      await captureIntakeClaimConversion({
        claimDigest: 'c'.repeat(64),
        claimedDocumentCount: 1,
        locale: 'es',
        requestHeaders: new Headers(),
      })
    ).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
