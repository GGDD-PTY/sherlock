import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isValidDeviceToken } from '../../../../convex/_roadmap/model'

const STORAGE_KEY = 'sherlock.roadmap.device-token'

async function loadGetter() {
  const { getRoadmapDeviceToken } = await import('@/lib/roadmap/device-token')
  return getRoadmapDeviceToken
}

describe('getRoadmapDeviceToken', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists a Convex-shaped token and reuses it on the next call', async () => {
    const getRoadmapDeviceToken = await loadGetter()

    const first = getRoadmapDeviceToken()
    const stored = window.localStorage.getItem(STORAGE_KEY)

    expect(isValidDeviceToken(first)).toBe(true)
    expect(stored).toBe(first)
    expect(getRoadmapDeviceToken()).toBe(first)
  })

  it.each(['too-short', 'device_token_1234567', `${'a'.repeat(15)}`, `${'a'.repeat(65)}`])(
    'replaces a stored token the server would reject (%s)',
    async (invalid) => {
      window.localStorage.setItem(STORAGE_KEY, invalid)
      const getRoadmapDeviceToken = await loadGetter()

      const token = getRoadmapDeviceToken()

      expect(token).not.toBe(invalid)
      expect(isValidDeviceToken(token)).toBe(true)
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(token)
    }
  )

  it('falls back to a stable ephemeral token when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const getRoadmapDeviceToken = await loadGetter()

    const first = getRoadmapDeviceToken()
    const second = getRoadmapDeviceToken()

    expect(isValidDeviceToken(first)).toBe(true)
    expect(second).toBe(first)
  })
})
