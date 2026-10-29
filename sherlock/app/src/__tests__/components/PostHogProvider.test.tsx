import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('posthog-js', () => ({ default: posthogMock }))

async function flushUntilInit() {
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  await act(async () => {
    await vi.waitFor(() => expect(posthogMock.init).toHaveBeenCalled())
  })
}

function initializedConfig(): Record<string, unknown> {
  const config = posthogMock.init.mock.calls[0]?.[1]
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Expected PostHog init config')
  }
  return config
}

function functionProperty(
  source: Record<string, unknown>,
  property: string
): (...args: unknown[]) => unknown {
  const candidate = source[property]
  if (typeof candidate !== 'function') throw new Error(`Expected function at ${property}`)
  return (...args: unknown[]) => Reflect.apply(candidate, undefined, args)
}

function objectProperty(
  source: Record<string, unknown>,
  property: string
): Record<string, unknown> {
  const candidate = source[property]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Expected object at ${property}`)
  }
  return Object.fromEntries(Object.entries(candidate))
}

describe('PostHogProvider complete journey analytics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_public_test_key')
    posthogMock.init.mockReturnValue(posthogMock)
    window.history.replaceState({}, '', '/es/my-company/documents')
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
  })

  it('initializes analytics, replay and interaction capture inside the VDR without cookies', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const config = initializedConfig()
    expect(config).toMatchObject({
      api_host: '/ingest',
      persistence: 'localStorage',
      disable_persistence: false,
      person_profiles: 'never',
      mask_all_element_attributes: true,
      mask_all_text: true,
      rageclick: true,
      capture_pageview: 'history_change',
      capture_pageleave: true,
      capture_heatmaps: true,
      disable_scroll_properties: false,
      disable_session_recording: false,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_product_tours: true,
      advanced_disable_flags: false,
      advanced_disable_feature_flags: true,
      respect_dnt: true,
      rate_limiting: { events_per_second: 5, events_burst_limit: 20 },
    })
    expect(config).not.toHaveProperty('cookieless_mode')
    expect(config).toHaveProperty('autocapture')
    expect(config).toHaveProperty('capture_dead_clicks')

    const recording = objectProperty(config, 'session_recording')
    expect(recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
      recordHeaders: false,
      recordBody: false,
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
    })
    expect(String(recording.blockSelector)).toContain('canvas')
    expect(String(recording.blockSelector)).toContain('iframe')
    const maskText = functionProperty(recording, 'maskTextFn')
    const markedStaticLabel = document.createElement('span')
    markedStaticLabel.dataset.replayUi = 'true'
    const unmarkedBusinessValue = document.createElement('span')
    expect(maskText('Guardar cambios', markedStaticLabel)).toBe('Guardar cambios')
    expect(maskText('Contacto', unmarkedBusinessValue)).toBe('********')
    expect(maskText('Estados Financieros Sample Foods.pdf')).toBe(
      '******* *********** ****** *********'
    )
  })

  it('keeps VDR pageviews while stripping query values and route identifiers', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const beforeSend = functionProperty(initializedConfig(), 'before_send')
    const sanitized = beforeSend({
      uuid: 'pageview-id',
      event: '$pageview',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $current_url:
          'https://sherlock.capital/es/admin/companies/j57client123456789/documents?token=secret',
        email: 'private@example.com',
        companyName: 'Private Company',
      },
    })

    expect(sanitized).toMatchObject({
      event: '$pageview',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $current_url: 'https://sherlock.capital/es/admin/companies/:id/documents',
        $pathname: '/es/admin/companies/:id/documents',
        $process_person_profile: false,
      },
    })
    expect(JSON.stringify(sanitized)).not.toMatch(
      /secret|private@example|Private Company|j57client/
    )
  })

  it('keeps click structure but removes element text, attributes and document names', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const beforeSend = functionProperty(initializedConfig(), 'before_send')
    const sanitized = beforeSend({
      uuid: 'autocapture-id',
      event: '$autocapture',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $current_url: 'https://sherlock.capital/es/my-company/documents?document=secret',
        $event_type: 'click',
        $ce_version: 1,
        $el_text: 'Estados Financieros Sample Foods.pdf',
        $elements: [{ attr__title: 'Estados Financieros Sample Foods.pdf' }],
        $elements_chain:
          'button.private:text="Estados Financieros Sample Foods.pdf"nth-child="2"nth-of-type="1";div:attr__aria-label="private@example.com"nth-child="1"',
      },
    })

    expect(sanitized).toMatchObject({
      event: '$autocapture',
      properties: {
        $event_type: 'click',
        $ce_version: 1,
        $elements_chain: 'button:nth-child="2"nth-of-type="1";div:nth-child="1"',
        $process_person_profile: false,
      },
    })
    expect(JSON.stringify(sanitized)).not.toMatch(
      /Sample Foods|private@example|\$el_text|\$elements"/
    )
  })

  it('allows masked replay snapshots and strips unrelated top-level properties', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const beforeSend = functionProperty(initializedConfig(), 'before_send')
    const snapshotData = [{ type: 3, data: { source: 0, text: '********' }, timestamp: 1 }]
    const sanitized = beforeSend({
      uuid: 'snapshot-id',
      event: '$snapshot',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $session_id: 'session-id',
        $window_id: 'window-id',
        $current_url: 'https://sherlock.capital/es/my-company/documents?document=private',
        $snapshot_bytes: 32,
        $snapshot_data: snapshotData,
        requestBody: '{"password":"private"}',
      },
    })

    expect(sanitized).toMatchObject({
      event: '$snapshot',
      properties: {
        $current_url: 'https://sherlock.capital/es/my-company/documents',
        $snapshot_bytes: 32,
        $snapshot_data: snapshotData,
        $process_person_profile: false,
      },
    })
    expect(JSON.stringify(sanitized)).not.toContain('password')
  })

  it('sanitizes replay URLs and removes network headers and bodies', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const recording = objectProperty(initializedConfig(), 'session_recording')
    const sanitizeRequest = functionProperty(recording, 'maskCapturedNetworkRequestFn')
    const sanitized = sanitizeRequest({
      name: 'https://sherlock.capital/es/admin/companies/j57client123456789/documents?token=secret',
      entryType: 'resource',
      startTime: 1,
      duration: 2,
      requestHeaders: { authorization: 'Bearer secret' },
      responseHeaders: { 'set-cookie': 'secret' },
      requestBody: '{"email":"private@example.com"}',
      responseBody: '{"document":"private"}',
    })

    expect(sanitized).toMatchObject({
      name: 'https://sherlock.capital/es/admin/companies/:id/documents',
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/Bearer|set-cookie|private@example|responseBody/)
  })

  it('keeps bounded heatmap coordinates under a sanitized URL', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const beforeSend = functionProperty(initializedConfig(), 'before_send')
    const sanitized = beforeSend({
      uuid: 'heatmap-id',
      event: '$$heatmap',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $current_url: 'https://sherlock.capital/es/my-company/documents?company=private',
        $heatmap_data: {
          'https://sherlock.capital/es/my-company/documents?company=private': [
            { x: 42, y: 84, type: 'click', target_fixed: false, documentName: 'private.pdf' },
          ],
        },
      },
    })

    expect(sanitized).toMatchObject({
      event: '$$heatmap',
      properties: {
        $heatmap_data: {
          'https://sherlock.capital/es/my-company/documents': [
            { x: 42, y: 84, type: 'click', target_fixed: false },
          ],
        },
      },
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/private\.pdf|company=private/)
  })

  it('captures error type and stack position while redacting messages and variables', async () => {
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')
    render(<PostHogProvider>Data Room</PostHogProvider>)
    await flushUntilInit()

    const beforeSend = functionProperty(initializedConfig(), 'before_send')
    const sanitized = beforeSend({
      uuid: 'exception-id',
      event: '$exception',
      properties: {
        token: 'phc_public_test_key',
        distinct_id: 'anonymous-device-id',
        $current_url: 'https://sherlock.capital/es/my-company/documents?token=secret',
        $exception_type: 'TypeError',
        $exception_message: 'Failed for private@example.com',
        $exception_level: 'error',
        $exception_list: [
          {
            type: 'TypeError',
            value: 'Failed for private@example.com',
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  filename: '/app/src/components/Room.tsx?token=secret',
                  function: 'Room',
                  lineno: 21,
                  colno: 5,
                  in_app: true,
                  vars: { email: 'private@example.com' },
                },
              ],
            },
          },
        ],
      },
    })

    expect(sanitized).toMatchObject({
      properties: {
        $exception_type: 'TypeError',
        $exception_message: '[redacted]',
        $exception_level: 'error',
        $exception_list: [
          {
            type: 'TypeError',
            value: '[redacted]',
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  filename: '/app/src/components/Room.tsx',
                  function: 'Room',
                  lineno: 21,
                  colno: 5,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/private@example|token=secret|vars/)
  })

  it('does not initialize when the browser sends Do Not Track', async () => {
    Object.defineProperty(window.navigator, 'doNotTrack', { configurable: true, value: '1' })
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    render(<PostHogProvider>Data Room</PostHogProvider>)
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(posthogMock.init).not.toHaveBeenCalled()
    Object.defineProperty(window.navigator, 'doNotTrack', { configurable: true, value: null })
  })

  it('does not initialize when Global Privacy Control is enabled', async () => {
    Object.defineProperty(window.navigator, 'globalPrivacyControl', {
      configurable: true,
      value: true,
    })
    vi.resetModules()
    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    render(<PostHogProvider>Data Room</PostHogProvider>)
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(posthogMock.init).not.toHaveBeenCalled()
    Object.defineProperty(window.navigator, 'globalPrivacyControl', {
      configurable: true,
      value: false,
    })
  })
})

describe('PostHogProvider tree stability', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    window.history.replaceState({}, '', '/')
  })

  it('does not remount children when the SDK finishes loading', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_public_test_key')
    posthogMock.init.mockReturnValue(posthogMock)
    window.history.replaceState({}, '', '/es/')
    vi.resetModules()

    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    let mountCount = 0
    function Probe() {
      const [picked, setPicked] = useState<string[]>([])
      useEffect(() => {
        mountCount += 1
      }, [])

      return (
        <button
          data-testid="probe"
          onClick={() => setPicked((current) => [...current, 'modelo.xlsx'])}
        >
          {picked.join(', ') || 'sin archivos'}
        </button>
      )
    }

    render(
      <PostHogProvider>
        <Probe />
      </PostHogProvider>
    )

    const beforeNode = screen.getByTestId('probe')
    fireEvent.click(beforeNode)
    expect(beforeNode).toHaveTextContent('modelo.xlsx')
    expect(mountCount).toBe(1)

    await flushUntilInit()

    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('probe')).toBe(beforeNode)
    expect(beforeNode).toHaveTextContent('modelo.xlsx')
    expect(mountCount).toBe(1)
  })

  // Cada sección de la app monta su propio AppShell, así que saltar de la sala
  // a Notificaciones desmonta y remonta este provider. Con el candado en un
  // `useRef` eso disparaba un segundo `posthog.init` y el SDK avisaba «You have
  // already initialized PostHog» una vez por salto.
  it('initializes once per page load even when the provider remounts', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_public_test_key')
    posthogMock.init.mockReturnValue(posthogMock)
    window.history.replaceState({}, '', '/es/')
    vi.resetModules()

    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    const first = render(
      <PostHogProvider>
        <span data-testid="section">sala</span>
      </PostHogProvider>
    )
    await flushUntilInit()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)

    first.unmount()

    render(
      <PostHogProvider>
        <span data-testid="section">avisos</span>
      </PostHogProvider>
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('section')).toHaveTextContent('avisos')
  })

  // El candado de módulo recuerda también los fracasos: si se queda con una
  // promesa rechazada, un chunk que no bajó deja la analítica muerta hasta la
  // próxima recarga entera. El `useRef` reintentaba al remontar y eso no se
  // pierde.
  it('retries on the next mount when the first init fails', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_public_test_key')
    posthogMock.init.mockImplementationOnce(() => {
      throw new Error('chunk load failed')
    })
    posthogMock.init.mockReturnValue(posthogMock)
    window.history.replaceState({}, '', '/es/')
    vi.resetModules()

    const { PostHogProvider } = await import('@/components/providers/PostHogProvider')

    const first = render(
      <PostHogProvider>
        <span data-testid="section">sala</span>
      </PostHogProvider>
    )
    await flushUntilInit()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)

    first.unmount()

    render(
      <PostHogProvider>
        <span data-testid="section">avisos</span>
      </PostHogProvider>
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(posthogMock.init).toHaveBeenCalledTimes(2)
  })
})
