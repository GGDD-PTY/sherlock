import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { adminAuthSupport, constructedUrls, mockSetAdminAuth, MockConvexHttpClient } = vi.hoisted(
  () => {
    const adminAuthSupport = { enabled: true }
    const constructedUrls: string[] = []
    const mockSetAdminAuth = vi.fn()

    class MockConvexHttpClient {
      constructor(url: string) {
        constructedUrls.push(url)

        if (adminAuthSupport.enabled) {
          Object.assign(this, {
            setAdminAuth: (token: string) => mockSetAdminAuth(token),
          })
        }
      }
    }

    return { adminAuthSupport, constructedUrls, mockSetAdminAuth, MockConvexHttpClient }
  }
)

vi.mock('convex/browser', () => ({
  ConvexHttpClient: MockConvexHttpClient,
}))

import { getConvexAdminClient } from '@/lib/convex/admin-client'

const originalConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
const originalConvexDeployKey = process.env.CONVEX_DEPLOY_KEY

describe('getConvexAdminClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adminAuthSupport.enabled = true
    constructedUrls.length = 0
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://test.convex.cloud'
    process.env.CONVEX_DEPLOY_KEY = 'convex_test_admin_key'
  })

  afterEach(() => {
    if (originalConvexUrl === undefined) {
      delete process.env.NEXT_PUBLIC_CONVEX_URL
    } else {
      process.env.NEXT_PUBLIC_CONVEX_URL = originalConvexUrl
    }

    if (originalConvexDeployKey === undefined) {
      delete process.env.CONVEX_DEPLOY_KEY
    } else {
      process.env.CONVEX_DEPLOY_KEY = originalConvexDeployKey
    }
  })

  it('returns null when the Convex URL is missing', () => {
    delete process.env.NEXT_PUBLIC_CONVEX_URL

    expect(getConvexAdminClient()).toBeNull()
    expect(constructedUrls).toEqual([])
    expect(mockSetAdminAuth).not.toHaveBeenCalled()
  })

  it('returns null when the admin deploy key is missing', () => {
    delete process.env.CONVEX_DEPLOY_KEY

    expect(getConvexAdminClient()).toBeNull()
    expect(constructedUrls).toEqual([])
    expect(mockSetAdminAuth).not.toHaveBeenCalled()
  })

  it('creates a Convex client and applies admin auth when configured', () => {
    const client = getConvexAdminClient()

    expect(client).toBeInstanceOf(MockConvexHttpClient)
    expect(constructedUrls).toEqual(['https://test.convex.cloud'])
    expect(mockSetAdminAuth).toHaveBeenCalledWith('convex_test_admin_key')
  })

  it('returns null when the Convex client does not expose admin auth', () => {
    adminAuthSupport.enabled = false

    expect(getConvexAdminClient()).toBeNull()
    expect(constructedUrls).toEqual(['https://test.convex.cloud'])
    expect(mockSetAdminAuth).not.toHaveBeenCalled()
  })
})
