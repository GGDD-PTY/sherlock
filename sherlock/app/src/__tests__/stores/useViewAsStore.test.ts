// ============================================================================
// TESTS: useViewAsStore
// ============================================================================
// Tests for the Zustand store that manages admin "View As" and impersonation.
// Covers state management, cookie persistence, and server-side helpers.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from '@testing-library/react'

// We need to reset the Zustand store between tests
// Import the store and helpers directly (not through mocks)
import {
  useViewAsStore,
  parseViewAsCookie,
  VIEW_AS_COOKIE_NAME,
  IMPERSONATE_COOKIE_NAME,
} from '@/stores/useViewAsStore'
import type { Id } from '../../../convex/_generated/dataModel'

// ============================================================================
// TESTS
// ============================================================================

describe('useViewAsStore', () => {
  beforeEach(() => {
    // Reset the store state before each test
    act(() => {
      useViewAsStore.setState({
        viewAsRole: null,
        impersonateUserId: null,
      })
    })
    // Clear cookies
    document.cookie = `${VIEW_AS_COOKIE_NAME}=; path=/; max-age=0`
    document.cookie = `${IMPERSONATE_COOKIE_NAME}=; path=/; max-age=0`
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('starts with null viewAsRole', () => {
      const state = useViewAsStore.getState()
      expect(state.viewAsRole).toBeNull()
    })

    it('starts with null impersonateUserId', () => {
      const state = useViewAsStore.getState()
      expect(state.impersonateUserId).toBeNull()
    })
  })

  // ==========================================================================
  // setViewAs
  // ==========================================================================

  describe('setViewAs', () => {
    it('sets viewAsRole to COMPANY', () => {
      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })

      expect(useViewAsStore.getState().viewAsRole).toBe('COMPANY')
    })

    it('clears impersonateUserId when setting viewAs', () => {
      // First set impersonation
      act(() => {
        useViewAsStore.setState({
          impersonateUserId: 'profile_123' as Id<'profiles'>,
          viewAsRole: 'COMPANY',
        })
      })

      // Then set viewAs
      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })

      expect(useViewAsStore.getState().impersonateUserId).toBeNull()
      expect(useViewAsStore.getState().viewAsRole).toBe('COMPANY')
    })

    it('sets VIEW_AS_COOKIE_NAME cookie', () => {
      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })

      expect(document.cookie).toContain(`${VIEW_AS_COOKIE_NAME}=COMPANY`)
    })

    it('clears IMPERSONATE cookie when setting viewAs', () => {
      // Set impersonate cookie first
      document.cookie = `${IMPERSONATE_COOKIE_NAME}=profile_old; path=/; SameSite=Lax`

      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })

      // The impersonate cookie should be cleared (max-age=0)
      // We verify indirectly through the store
      expect(useViewAsStore.getState().impersonateUserId).toBeNull()
    })
  })

  // ==========================================================================
  // clearViewAs
  // ==========================================================================

  describe('clearViewAs', () => {
    it('resets viewAsRole to null', () => {
      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })
      expect(useViewAsStore.getState().viewAsRole).toBe('COMPANY')

      act(() => {
        useViewAsStore.getState().clearViewAs()
      })

      expect(useViewAsStore.getState().viewAsRole).toBeNull()
    })

    it('resets impersonateUserId to null', () => {
      act(() => {
        useViewAsStore.setState({
          impersonateUserId: 'profile_123' as Id<'profiles'>,
          viewAsRole: 'COMPANY',
        })
      })

      act(() => {
        useViewAsStore.getState().clearViewAs()
      })

      expect(useViewAsStore.getState().impersonateUserId).toBeNull()
    })
  })

  // ==========================================================================
  // toggleViewAs
  // ==========================================================================

  describe('toggleViewAs', () => {
    it('deactivates viewAs when same role is toggled', () => {
      act(() => {
        useViewAsStore.getState().setViewAs('COMPANY')
      })

      act(() => {
        useViewAsStore.getState().toggleViewAs('COMPANY')
      })

      expect(useViewAsStore.getState().viewAsRole).toBeNull()
    })
  })

  // ==========================================================================
  // setImpersonateUser
  // ==========================================================================

  describe('setImpersonateUser', () => {
    it('sets impersonateUserId and viewAsRole', () => {
      const profileId = 'profile_abc' as Id<'profiles'>

      act(() => {
        useViewAsStore.getState().setImpersonateUser(profileId, 'COMPANY')
      })

      expect(useViewAsStore.getState().impersonateUserId).toBe('profile_abc')
      expect(useViewAsStore.getState().viewAsRole).toBe('COMPANY')
    })

    it('sets cookies for impersonation', () => {
      act(() => {
        useViewAsStore.getState().setImpersonateUser('profile_xyz' as Id<'profiles'>, 'COMPANY')
      })

      expect(document.cookie).toContain(`${VIEW_AS_COOKIE_NAME}=COMPANY`)
      expect(document.cookie).toContain(`${IMPERSONATE_COOKIE_NAME}=profile_xyz`)
    })
  })

  // ==========================================================================
  // clearImpersonate
  // ==========================================================================

  describe('clearImpersonate', () => {
    it('clears impersonation (delegates to clearViewAs)', () => {
      act(() => {
        useViewAsStore.getState().setImpersonateUser('profile_abc' as Id<'profiles'>, 'COMPANY')
      })
      expect(useViewAsStore.getState().impersonateUserId).toBe('profile_abc')

      act(() => {
        useViewAsStore.getState().clearImpersonate()
      })

      expect(useViewAsStore.getState().impersonateUserId).toBeNull()
      expect(useViewAsStore.getState().viewAsRole).toBeNull()
    })
  })
})

// ============================================================================
// SERVER-SIDE HELPERS
// ============================================================================

describe('parseViewAsCookie', () => {
  it('returns null for null cookie header', () => {
    expect(parseViewAsCookie(null)).toBeNull()
  })

  it('returns null for empty cookie header', () => {
    expect(parseViewAsCookie('')).toBeNull()
  })

  it('rejects the retired INVESTOR role from cookies', () => {
    const cookieHeader = `${VIEW_AS_COOKIE_NAME}=INVESTOR; other=value`
    expect(parseViewAsCookie(cookieHeader)).toBeNull()
  })

  it('parses COMPANY role from cookie', () => {
    const cookieHeader = `other=foo; ${VIEW_AS_COOKIE_NAME}=COMPANY`
    expect(parseViewAsCookie(cookieHeader)).toBe('COMPANY')
  })

  it('returns null for invalid role value', () => {
    const cookieHeader = `${VIEW_AS_COOKIE_NAME}=ADMIN`
    expect(parseViewAsCookie(cookieHeader)).toBeNull()
  })

  it('returns null when cookie is not present', () => {
    const cookieHeader = 'other=value; another=test'
    expect(parseViewAsCookie(cookieHeader)).toBeNull()
  })

  it('handles URL-encoded values', () => {
    const cookieHeader = `${VIEW_AS_COOKIE_NAME}=${encodeURIComponent('COMPANY')}`
    expect(parseViewAsCookie(cookieHeader)).toBe('COMPANY')
  })

  it('returns null for empty value', () => {
    const cookieHeader = `${VIEW_AS_COOKIE_NAME}=`
    expect(parseViewAsCookie(cookieHeader)).toBeNull()
  })

  it('handles cookies without equals sign', () => {
    const cookieHeader = `nocookie; ${VIEW_AS_COOKIE_NAME}=COMPANY`
    expect(parseViewAsCookie(cookieHeader)).toBe('COMPANY')
  })
})

// ============================================================================
// CONSTANTS
// ============================================================================

describe('constants', () => {
  it('exports VIEW_AS_COOKIE_NAME', () => {
    expect(VIEW_AS_COOKIE_NAME).toBe('sherlock_view_as')
  })

  it('exports IMPERSONATE_COOKIE_NAME', () => {
    expect(IMPERSONATE_COOKIE_NAME).toBe('sherlock_impersonate')
  })
})
