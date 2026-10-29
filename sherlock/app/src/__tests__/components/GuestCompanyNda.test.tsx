import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GuestCompanyNda } from '@/components/vdr-guest/GuestCompanyNda'

// El NDA llega dentro de la envoltura de `apiSuccess`, que agrega `requestId`
// al mismo nivel. La migración a `effect/Schema` pidió `onExcessProperty:
// 'error'` sobre el árbol entero y esa clave tumbaba la respuesta completa: el
// invitado veía «no está disponible» contra el servidor real.
const NDA = {
  title: 'Acuerdo de confidencialidad',
  content: 'Las partes acuerdan mantener la confidencialidad de la información compartida.',
  contentHash: 'a'.repeat(64),
  version: '2026.1',
  locale: 'es',
} as const

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

describe('GuestCompanyNda', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reads the published NDA out of the apiSuccess envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ nda: NDA, requestId: 'req-guest-nda' }))
    )

    render(<GuestCompanyNda onAccepted={() => {}} />)

    expect(await screen.findByText('Acuerdo de confidencialidad')).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre completo del firmante')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aceptar NDA y abrir el Data Room' })).toBeDisabled()
  })

  it('discards an NDA that carries a key the contract does not declare', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          nda: { ...NDA, signedBy: 'fixture-1f71008a@example.com' },
          requestId: 'req-guest-nda',
        })
      )
    )

    render(<GuestCompanyNda onAccepted={() => {}} />)

    expect(
      await screen.findByText(
        'El NDA no está disponible para esta sesión. Solicita al equipo una invitación vigente.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Acuerdo de confidencialidad')).not.toBeInTheDocument()
  })
})
