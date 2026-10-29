import { render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

const BOUNDARY_TIMESTAMP = Date.UTC(2026, 0, 1, 0, 30, 0)
const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUsePaginatedQuery = vi.hoisted(() => vi.fn())

vi.unmock('next-intl')
vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  usePaginatedQuery: mockUsePaginatedQuery,
  useMutation: () => vi.fn(),
}))
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: false }))
vi.mock('../../../convex/_generated/api', () => ({
  api: {
    adminAuditLogs: { list: 'audit:list', getStats: 'audit:stats' },
    ndas: {
      getAdminStats: 'nda:stats',
      listAllForAdmin: 'nda:list',
      adminRevoke: 'nda:revoke',
    },
    gdpr: {
      listDeletionRequests: 'gdpr:list',
      processAccountDeletion: 'gdpr:process',
    },
  },
}))

import { AdminGdprClient } from '@/components/admin/AdminGdprClient'
import { AuditLogsClient } from '@/components/admin/AuditLogsClient'

const auditRow = {
  _id: 'audit_1',
  _creationTime: BOUNDARY_TIMESTAMP,
  adminProfileId: 'profile_1',
  adminEmail: 'admin@example.com',
  adminName: 'Admin',
  action: 'KYC_APPROVE',
  targetType: 'PROFILE',
}

function setupQueries() {
  mockUsePaginatedQuery.mockReturnValue({
    results: [auditRow],
    status: 'Exhausted',
    loadMore: vi.fn(),
  })
  mockUseQuery.mockImplementation((query: string) => {
    if (query === 'audit:stats') {
      return {
        totalLogs: 1,
        totalLogsCapped: false,
        recentLogs: 1,
        byCategory: { user: 0, deal: 0, kyc: 1 },
      }
    }
    if (query === 'nda:stats') {
      return {
        total: 1,
        active: 1,
        expired: 0,
        revoked: 0,
        expiringIn30Days: 0,
        signedLast7Days: 1,
        scanCap: 2000,
        scannedCount: 1,
        truncated: false,
      }
    }
    if (query === 'gdpr:list') {
      return [
        {
          _id: 'request_1',
          email: 'boundary@example.com',
          status: 'PENDING',
          requestedAt: BOUNDARY_TIMESTAMP,
        },
      ]
    }
    return undefined
  })
}

function provider(locale: 'es', child: React.ReactNode) {
  return (
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      {child}
    </NextIntlClientProvider>
  )
}

// `BOUNDARY_TIMESTAMP` es 00:30 UTC del 1 de enero: en Panamá todavía son las
// 19:30 del 31 de diciembre. Ese es el día que el cliente vivió y el que la
// pantalla admin tiene que imprimir ([F] 2026-09-17). Antes decía «01 ene 2026».
const CASES = [['es', /31 dic 2025/i, /01 ene 2026/i]] as const

describe('admin date rendering uses the Panama calendar day', () => {
  it.each(CASES)('keeps the audit timestamp on December 31 in %s', (locale, expected, shifted) => {
    setupQueries()
    const { container } = render(provider(locale, <AuditLogsClient />))

    expect(container).toHaveTextContent(expected)
    expect(container).not.toHaveTextContent(shifted)
  })

  it.each(CASES)('keeps GDPR dates on December 31 in %s', (locale, expected, shifted) => {
    setupQueries()
    const { container } = render(provider(locale, <AdminGdprClient />))

    expect(container).toHaveTextContent(expected)
    expect(container).not.toHaveTextContent(shifted)
  })
})
