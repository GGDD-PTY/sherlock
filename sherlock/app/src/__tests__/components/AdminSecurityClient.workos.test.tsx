import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn(() => vi.fn()))

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    security: {
      getRecentSecurityEvents: 'security:getRecentSecurityEvents',
      getSecurityEventsCounts: 'security:getSecurityEventsCounts',
      resolveSecurityEvent: 'security:resolveSecurityEvent',
    },
    documents: {
      getManualReviewQueue: 'documents:getManualReviewQueue',
    },
  },
}))

vi.mock('@/lib/dev-auth/config', () => ({
  DEV_AUTH_ENABLED: false,
}))

describe('AdminSecurityClient WorkOS-backed query path', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockUseMutation.mockClear()
    mockUseQuery.mockImplementation((query) => {
      if (query === 'security:getRecentSecurityEvents') {
        return [
          {
            _id: 'security_event_failed_login',
            _creationTime: Date.now(),
            type: 'FAILED_LOGIN',
            severity: 'WARNING',
            userEmail: 'investor@example.com',
            ipAddress: '10.0.0.10',
            resolved: false,
          },
        ]
      }

      if (query === 'security:getSecurityEventsCounts') {
        return {
          total: 1,
          critical: 0,
          alert: 0,
          warning: 1,
          info: 0,
        }
      }

      if (query === 'documents:getManualReviewQueue') {
        return []
      }

      return undefined
    })
  })

  it('keeps real Convex security queries active when dev-auth is disabled', async () => {
    const { AdminSecurityClient } = await import('@/components/admin/AdminSecurityClient')
    render(<AdminSecurityClient />)

    expect(mockUseQuery).toHaveBeenCalledWith(
      'security:getRecentSecurityEvents',
      expect.objectContaining({
        limit: 100,
        includeResolved: false,
        severity: undefined,
      })
    )
    expect(mockUseQuery).toHaveBeenCalledWith('security:getSecurityEventsCounts', {})
    expect(mockUseQuery).toHaveBeenCalledWith('documents:getManualReviewQueue', { limit: 25 })
    expect(mockUseQuery.mock.calls.some(([, args]) => args === 'skip')).toBe(false)

    expect(screen.queryByText('Muestra de seguridad para dev-auth')).not.toBeInTheDocument()
    expect(screen.getByText('Inicio de sesión fallido')).toBeInTheDocument()
  })
})
