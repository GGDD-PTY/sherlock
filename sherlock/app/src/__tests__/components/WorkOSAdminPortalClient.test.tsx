import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkOSAdminPortalClient } from '@/components/admin/WorkOSAdminPortalClient'

vi.mock('@/components/admin/CompanyAuthorizationRolloutClient', () => ({
  CompanyAuthorizationRolloutClient: () => (
    <div data-testid="company-authorization-rollout">Control empresa-organización</div>
  ),
}))

describe('WorkOSAdminPortalClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows server-side WorkOS configuration status without exposing secrets', () => {
    render(
      <WorkOSAdminPortalClient
        envStatus={{
          apiKey: true,
          clientId: true,
          cookiePassword: false,
          webhookSecret: true,
          redirectUri: true,
        }}
      />
    )

    expect(screen.getByText('WORKOS_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('WORKOS_COOKIE_PASSWORD')).toBeInTheDocument()
    expect(screen.getAllByText('Configurado')).toHaveLength(4)
    expect(screen.getByText('Pendiente')).toBeInTheDocument()
    expect(screen.queryByText(/sk_test/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/whsec/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('company-authorization-rollout')).toBeInTheDocument()
  })

  it('keeps portal actions disabled until required WorkOS env is complete', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <WorkOSAdminPortalClient
        envStatus={{
          apiKey: true,
          clientId: false,
          cookiePassword: true,
          webhookSecret: true,
          redirectUri: true,
        }}
      />
    )

    fireEvent.change(screen.getByLabelText('ID de organización de WorkOS'), {
      target: { value: 'org_123' },
    })

    expect(screen.getByRole('button', { name: 'Abrir SSO' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Verificar dominio' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir SSO' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests an SSO Admin Portal link and opens it in a new tab', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          link: 'https://portal.workos.com/admin_portal/session_123',
          intent: 'sso',
          organizationId: 'org_123',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <WorkOSAdminPortalClient
        envStatus={{
          apiKey: true,
          clientId: true,
          cookiePassword: true,
          webhookSecret: true,
          redirectUri: true,
        }}
      />
    )

    fireEvent.change(screen.getByLabelText('ID de organización de WorkOS'), {
      target: { value: 'org_123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir SSO' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workos/admin-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_123', intent: 'sso' }),
      })
    })
    expect(openSpy).toHaveBeenCalledWith(
      'https://portal.workos.com/admin_portal/session_123',
      '_blank',
      'noopener,noreferrer'
    )
  })
})
