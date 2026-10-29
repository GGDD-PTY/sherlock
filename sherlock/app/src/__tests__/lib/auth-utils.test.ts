// ============================================================================
// AUTH UTILS UNIT TESTS
// ============================================================================
// Tests for shared authentication utilities
// Covers: getRedirectParam function
// ============================================================================

import { describe, it, expect } from 'vitest'
import { getRedirectParam } from '@/lib/auth-utils'

describe('lib/auth-utils.ts', () => {
  // ============================================================================
  // getRedirectParam TESTS
  // ============================================================================
  describe('getRedirectParam', () => {
    // ===== TEST: EXTRACT redirect_url =====
    it('extracts redirect_url parameter', async () => {
      const params = Promise.resolve({
        redirect_url: '/my-company/documents',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/my-company/documents')
    })

    it('extracts WorkOS returnTo parameter', async () => {
      const params = Promise.resolve({
        returnTo: '/my-company/documents',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/my-company/documents')
    })

    it('extracts legacy redirectTo parameter from older links', async () => {
      const params = Promise.resolve({
        redirectTo: '/onboarding',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/onboarding')
    })

    // ===== TEST: EXTRACT after_sign_in_url =====
    it('extracts after_sign_in_url parameter', async () => {
      const params = Promise.resolve({
        after_sign_in_url: '/settings',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/settings')
    })

    // ===== TEST: EXTRACT after_sign_up_url =====
    it('extracts after_sign_up_url parameter', async () => {
      const params = Promise.resolve({
        after_sign_up_url: '/onboarding',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/onboarding')
    })

    // ===== TEST: PRIORITY - redirect_url FIRST =====
    it('prioritizes redirect_url over other parameters', async () => {
      const params = Promise.resolve({
        redirect_url: '/primary',
        after_sign_in_url: '/secondary',
        after_sign_up_url: '/tertiary',
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/primary')
    })

    // ===== TEST: HANDLE ARRAY VALUES =====
    it('handles array values by taking the first element', async () => {
      const params = Promise.resolve({
        redirect_url: ['/first', '/second'],
      })

      const result = await getRedirectParam(params)

      expect(result).toBe('/first')
    })

    // ===== TEST: RETURN UNDEFINED WHEN NO PARAMS =====
    it('returns undefined when no redirect parameters exist', async () => {
      const params = Promise.resolve({
        other_param: 'value',
      })

      const result = await getRedirectParam(params)

      expect(result).toBeUndefined()
    })

    // ===== TEST: RETURN UNDEFINED FOR EMPTY OBJECT =====
    it('returns undefined for empty search params', async () => {
      const params = Promise.resolve({})

      const result = await getRedirectParam(params)

      expect(result).toBeUndefined()
    })

    // ===== TEST: HANDLE UNDEFINED VALUES =====
    it('handles undefined values gracefully', async () => {
      const params = Promise.resolve({
        redirect_url: undefined,
        after_sign_in_url: undefined,
      })

      const result = await getRedirectParam(params)

      expect(result).toBeUndefined()
    })

    // ===== TEST: HANDLE COMPLEX REDIRECT URLS =====
    it('preserves complex redirect URLs with query strings', async () => {
      const complexUrl = '/my-company/documents?filter=active&sort=date'
      const params = Promise.resolve({
        redirect_url: complexUrl,
      })

      const result = await getRedirectParam(params)

      expect(result).toBe(complexUrl)
    })

    // ===== TEST: HANDLE ABSOLUTE URLS =====
    it('handles absolute URLs', async () => {
      const absoluteUrl = 'https://example.com/callback'
      const params = Promise.resolve({
        redirect_url: absoluteUrl,
      })

      const result = await getRedirectParam(params)

      expect(result).toBe(absoluteUrl)
    })
  })
})
